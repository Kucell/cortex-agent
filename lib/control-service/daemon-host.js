#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  DEFAULT_POLL_INTERVAL_MS,
  now,
  readOwner,
  readState,
  writeState,
  clearOwner,
} = require("./daemon-state.js");
const {
  createLocalDaemonEngine,
} = require("./daemon-runtime.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop(projectRoot, options = {}) {
  const pollInterval = Number.isInteger(options.poll_interval_ms)
    ? Math.max(1000, options.poll_interval_ms)
    : DEFAULT_POLL_INTERVAL_MS;
  const token = options.owner_token || process.env.CORTEX_CONTROL_DAEMON_TOKEN || null;
  let stopping = false;

  function ownsCurrentRecord() {
    const owner = readOwner(projectRoot);
    return Boolean(
      owner
      && owner.pid === process.pid
      && (!token || owner.token === token),
    );
  }

  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    if (ownsCurrentRecord()) {
      writeState(projectRoot, {
        enabled: false,
        status: "stopping",
        last_heartbeat_at: now(),
      });
    }
  }

  process.once("SIGTERM", () => { stop("SIGTERM").catch(() => {}); });
  process.once("SIGINT", () => { stop("SIGINT").catch(() => {}); });

  if (!ownsCurrentRecord()) {
    const error = new Error("daemon owner record does not match child process");
    error.code = "ERR_DAEMON_OWNER_MISMATCH";
    throw error;
  }

  const engine = options.engine || createLocalDaemonEngine(projectRoot);

  writeState(projectRoot, {
    enabled: true,
    status: "running",
    pid: process.pid,
    poll_interval_ms: pollInterval,
    started_at: readState(projectRoot).started_at || now(),
    last_heartbeat_at: now(),
    stopped_at: null,
    last_error: null,
  });

  while (!stopping) {
    let lastError = null;
    try {
      await engine.tick({
        project_root: projectRoot,
        polled_at: now(),
      });
    } catch (error) {
      lastError = {
        code: error.code || "ERR_DAEMON_TICK",
        message: error.message,
        at: now(),
      };
    }

    writeState(projectRoot, {
      enabled: true,
      status: lastError ? "degraded" : "running",
      pid: process.pid,
      poll_interval_ms: pollInterval,
      last_heartbeat_at: now(),
      last_error: lastError,
    });
    await sleep(pollInterval);
  }

  if (ownsCurrentRecord()) {
    writeState(projectRoot, {
      enabled: false,
      status: "stopped",
      pid: null,
      last_heartbeat_at: now(),
      stopped_at: now(),
    });
    clearOwner(projectRoot);
  }
}

if (require.main === module) {
  const [mode, root, interval] = process.argv.slice(2);
  if (mode !== "__run" || !root) {
    process.stderr.write("control daemon host is an internal entry point\n");
    process.exit(2);
  }
  runLoop(path.resolve(root), {
    poll_interval_ms: interval ? Number(interval) : undefined,
  }).catch((error) => {
    try {
      writeState(path.resolve(root), {
        enabled: true,
        status: "degraded",
        pid: null,
        last_heartbeat_at: now(),
        last_error: {
          code: error.code || "ERR_DAEMON_RUNTIME",
          message: error.message,
          at: now(),
        },
      });
    } catch (_) {}
    process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
    process.exit(1);
  });
}

module.exports = {
  runLoop,
};
