"use strict";

// Test helper: bounded retry for child-process spawns.
//
// Background:
//   The parallel test runner can saturate the machine's process table. When
//   that happens the kernel refuses the fork/exec with EAGAIN (or ENOMEM /
//   EMFILE / ENFILE) and the child never starts. The failure looks like a
//   product bug — the command under test never ran, there is no stdout and no
//   stderr — but it says nothing about the code under test.
//
//   Only that failure class is retried. A process that actually started and
//   exited on its own carries an exit status or a signal: that is a real
//   result and is never retried, so a genuine regression cannot be masked by
//   the retry window.
//
// Usage:
//   const { execFileWithRetry } = require("./helpers/spawn-retry");
//   const out = execFileWithRetry("node", [CLI, ...args], { cwd });
//
//   const { spawnWithRetry } = require("./helpers/spawn-retry");
//   // the factory returns a handle carrying the child process
//   const running = await spawnWithRetry(() => launchOnce(cwd, args, env));

const { execFileSync, spawnSync } = require("node:child_process");

// The process table is saturated — the kernel refuses to fork/exec.
const RETRYABLE_SPAWN_CODES = new Set(["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"]);

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 200;

/**
 * A spawn failure is retryable only when the child never started.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableSpawnError(error) {
  if (!error || !RETRYABLE_SPAWN_CODES.has(error.code)) return false;
  // A child that was killed by a signal carries `signal`, and a child that
  // ran to completion carries a numeric `status` — neither is a spawn
  // failure, so neither may be retried.
  if (error.signal) return false;
  return error.status === null || error.status === undefined;
}

/**
 * Synchronous backoff without spawning anything. The whole point is that the
 * process table is saturated, so forking a `sleep` would make it worse.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Run a command synchronously, retrying only the "the process never started"
 * failure class.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {object} [options] passed straight to execFileSync
 * @param {{ attempts?: number, backoffMs?: number }} [retry]
 * @returns {string}
 */
function execFileWithRetry(file, args, options = {}, retry = {}) {
  const attempts = retry.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = retry.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return execFileSync(file, args, options);
    } catch (error) {
      if (!isRetryableSpawnError(error)) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      sleepSync(backoffMs * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * Spawn a child process synchronously, retrying only the "the process never
 * started" failure class.
 *
 * `spawnSync` reports a failed spawn through `result.error` instead of
 * throwing, so the retry decision is made on that field. The result of the
 * last attempt is returned either way — a caller that inspects
 * `result.status` / `result.stdout` sees exactly what a single attempt would
 * have produced.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {object} [options] passed straight to spawnSync
 * @param {{ attempts?: number, backoffMs?: number }} [retry]
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function spawnSyncWithRetry(command, args, options = {}, retry = {}) {
  const attempts = retry.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = retry.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastResult = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = spawnSync(command, args, options);
    if (!result.error || !isRetryableSpawnError(result.error)) return result;
    lastResult = result;
    if (attempt === attempts - 1) break;
    sleepSync(backoffMs * (attempt + 1));
  }
  return lastResult;
}

/**
 * Resolve once the child is known to have started, reject when the spawn
 * itself failed.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<void>}
 */
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => { resolve(); });
    child.once("error", reject);
  });
}

/**
 * Spawn a child process, retrying only the "the process never started"
 * failure class. The factory is called again for every attempt so each try
 * gets a fresh child (and a fresh stdout/stderr capture).
 *
 * @template {{ child: import("node:child_process").ChildProcess }} T
 * @param {() => T} factory
 * @param {{ attempts?: number, backoffMs?: number }} [retry]
 * @returns {Promise<T>}
 */
async function spawnWithRetry(factory, retry = {}) {
  const attempts = retry.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = retry.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const handle = factory();
    try {
      await waitForSpawn(handle.child);
      return handle;
    } catch (error) {
      if (!isRetryableSpawnError(error)) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      await delay(backoffMs * (attempt + 1));
    }
  }
  throw lastError;
}

module.exports = {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  RETRYABLE_SPAWN_CODES,
  delay,
  execFileWithRetry,
  isRetryableSpawnError,
  sleepSync,
  spawnSyncWithRetry,
  spawnWithRetry,
  waitForSpawn,
};
