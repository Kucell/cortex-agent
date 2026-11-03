"use strict";

/**
 * Graphify full-rebuild runner (issue #154).
 *
 * This process owns THREE things that must end together:
 *
   1. the full rebuild itself, under a timeout;
   2. the rebuild lock, so the full build and the incremental update stay
      mutually exclusive;
   3. the baseline stamp.
 *
 * They live in ONE process on purpose. An external watchdog has to track a
 * child's liveness across process boundaries, and every such mechanism has
 * a failure mode of its own: an unreferenced timer lets the watcher exit
 * early, a mis-indexed `process.argv` slot passes the timeout where the PID
 * belongs, and a signal that kills the watcher does not kill the child.
 * Here there is nothing to track -- the timeout is `spawnSync`'s own, and
 * the lock is released by the same code path that ends the build.
 *
 * The runner is spawned with the CURRENT node executable, so it does not
 * depend on a `node` being on PATH (Windows resolves `node` differently).
 * It runs DETACHED, so the git hook returns immediately and the commit is
 * never blocked.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const densityLib = require("./density");

const cwd = process.cwd();

// How many times a deferred update may be replayed before it is dropped.
// Without a bound, a permanently failing `graphify update .` would make the
// drain loop spin forever inside one runner.
const PENDING_MAX_ATTEMPTS = 5;

// The timeout and the lock path are supplied by the spawning hook, so the
// two sides cannot disagree about them.
const timeoutMs = resolveTimeoutMs();
const lockPath = process.env.GRAPHIFY_REBUILD_LOCK_PATH || null;
const lockToken = process.env.GRAPHIFY_REBUILD_LOCK_TOKEN || null;
// The drain scheduler lock. It is handed to the drain process so that no
// second drain can start while this one is running -- the chain of
// follow-up drains would otherwise have no upper bound.
const drainLockPath = process.env.GRAPHIFY_DRAIN_LOCK_PATH || null;
const drainLockToken = process.env.GRAPHIFY_DRAIN_LOCK_TOKEN || null;
// The lock this process owns. It is set when the runner had to acquire the
// lock itself (the drain mode); in the full-rebuild mode the lock was
// acquired by the hook and handed over through the environment.
let ownedLock = null;
let drainLockOwned = false;

function resolveTimeoutMs() {
  const fromEnv = Number(process.env.GRAPHIFY_FULL_REBUILD_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const config = densityLib.readThresholdConfig(cwd);
    const seconds = Number(config.full_rebuild_timeout_seconds);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  } catch (_) {
    // Fall through to the framework default.
  }
  return densityLib.DEFAULT_THRESHOLD.full_rebuild_timeout_seconds * 1000;
}

// The lock is released on EVERY exit path, including a signal. Without the
// signal handlers a terminated runner would leave the lock behind and every
// incremental update would be skipped until the stale reaper ran.
let released = false;
function releaseLock() {
  if (released) return;
  // A lock this process acquired itself is released through its handle,
  // which carries the token check. The environment lock is released by
  // path, because the token travels in the environment.
  if (ownedLock) {
    released = true;
    ownedLock.release();
    ownedLock = null;
    return;
  }
  if (!lockPath) return;
  released = true;
  // Only remove the lock when it is still OURS. If the lock was reclaimed as
  // stale while this rebuild ran, a new holder owns it now, and removing it
  // would break the mutual exclusion for that holder.
  try {
    const current = JSON.parse(require("node:fs").readFileSync(lockPath, "utf8"));
    if (lockToken && current && current.token && current.token !== lockToken) return;
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    // A corrupt lock cannot be attributed to a holder; removing it keeps the
    // project usable.
  }
  try { require("node:fs").unlinkSync(lockPath); } catch (_) { /* already gone */ }
}

/**
 * Release the drain scheduler lock.
 *
 * The lock is only removed when the token still matches, so a drain whose
 * lock was reclaimed as stale cannot delete the NEW holder's lock.
 */
function releaseDrainLock() {
  if (!drainLockOwned || !drainLockPath) return;
  drainLockOwned = false;
  try {
    const current = JSON.parse(require("node:fs").readFileSync(drainLockPath, "utf8"));
    if (drainLockToken && current && current.token && current.token !== drainLockToken) return;
  } catch (err) {
    if (err && err.code === "ENOENT") return;
  }
  try { require("node:fs").unlinkSync(drainLockPath); } catch (_) { /* already gone */ }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    releaseLock();
    releaseDrainLock();
    process.exit(143);
  });
}
process.on("exit", () => {
  releaseLock();
  releaseDrainLock();
});
process.on("uncaughtException", (err) => {
  console.error(`[graphify-full] FAILED: ${err && err.message ? err.message : String(err)}`);
  releaseLock();
  releaseDrainLock();
  process.exit(1);
});

// The runner has two modes:
//
//   (default)        run the full rebuild, stamp the baseline, then replay
//                    any deferred update -- all while holding the lock.
//   --drain-pending  skip the rebuild entirely and only replay a deferred
//                    update. This is what a hook that held the lock starts
//                    after it releases it, so a request that arrived while
//                    the lock was busy is not left waiting for a later
//                    commit that may never come.
const drainOnly = process.argv.includes("--drain-pending");

if (drainOnly) {
  // The drain takes the lock ITSELF.
  //
  // The drain used to run `graphify update .` without taking the lock,
  // which broke the mutual exclusion the lock exists for: a drain could
  // publish a degraded graph between a full build's write and its baseline
  // stamp, and the stamp would then record the DEGRADED ratio as the new
  // "full" baseline -- the exact state the guard exists to prevent.
  //
  // The drain ALWAYS takes the lock itself.
  //
  // It used to use the lock handed in through the environment when that
  // variable was present. That was wrong: the follow-up drain is spawned
  // by `finish()`, AFTER this process released the lock -- so the child
  // inherited a lock path for a lock nobody owns, skipped the acquire, and
  // ran `graphify update .` without holding anything. Another process could
  // have taken the lock in the meantime, and the incremental update would
  // then race it -- the mutual exclusion the lock exists for, broken again.
  //
  // The drain therefore ignores the inherited lock entirely and acquires its
  // own. The inherited lock belongs to the FULL-BUILD mode only.
  {
    // This process IS the drain, so it owns the scheduler lock that was
    // handed to it by the starter.
    drainLockOwned = Boolean(drainLockPath);
    // The lock may be held by a rebuild that is about to finish. The drain
    // WAITS for it instead of giving up: giving up would leave the deferred
    // request in the queue with nobody to consume it, and the commit it
    // describes would never reach the graph.
    const lock = acquireLockWithRetry();
    if (!lock) {
      // Somebody else holds the lock. The request stays queued and the
      // holder's own drain will pick it up.
      console.log(
        `[graphify-full] the rebuild lock is busy; the deferred update stays queued`
      );
      finish(1);
    }
    ownedLock = lock;
  }
  const drained = drainLoop();
  finish(drained ? 0 : 1);
}

/**
 * Acquire the rebuild lock, waiting for a holder that is about to finish.
 *
 * The wait is bounded: a rebuild that runs for hours must not keep the
 * drain waiting for hours, and the deferred request is not lost either way
 * -- it stays in the queue and the next hook or rebuild drains it.
 */
function acquireLockWithRetry({ attempts = 30, delayMs = 1000 } = {}) {
  const fromEnv = Number(process.env.GRAPHIFY_DRAIN_LOCK_WAIT_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    attempts = Math.max(1, Math.round(fromEnv / Math.max(delayMs, 1)));
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lock = densityLib.acquireRebuildLock(cwd);
    if (lock) return lock;
    // The queue may have been drained by somebody else in the meantime.
    if (!densityLib.hasPendingUpdate(cwd)) return null;
    sleepSync(delayMs);
  }
  return null;
}

/**
 * Sleep synchronously for a few milliseconds.
 */
function sleepSync(ms) {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  } catch (_) {
    // A host without Atomics.wait simply does not wait.
  }
}

const startedAt = Date.now();
console.log(
  `[graphify-full] start: graphify extract . --force ` +
  `(timeout=${Math.round(timeoutMs / 1000)}s, cwd=${cwd})`
);

// The full build MUST be a real full build.
//
// `graphify .` is shorthand for `graphify extract .`, and extract ENTERS
// INCREMENTAL MODE whenever a graph.json already exists -- only `--force`
// turns that off (graphify 0.9.27, cli.py: `incremental_mode =
// existing_graph_path.exists() and not force`). A "full" rebuild that
// silently ran incrementally would stamp the DEGRADED ratio as the new
// baseline, and the density guard would never fire again -- the exact
// failure the guard exists to prevent.
//
// `GRAPHIFY_FORCE=1` is set as well, because that is the env-var form of
// the same switch and keeps the behaviour identical for CLI versions that
// only honour one of the two.
const result = spawnSync("graphify", ["extract", ".", "--force"], {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "inherit", "inherit"],
  timeout: timeoutMs,
  env: Object.assign({}, process.env, { GRAPHIFY_FORCE: "1" }),
});

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
if (result.error) {
  console.error(`[graphify-full] FAILED: ${result.error.message} after ${elapsed}s`);
  finish(1);
}
if (result.status !== 0) {
  console.error(`[graphify-full] FAILED: exit ${result.status} after ${elapsed}s`);
  finish(result.status || 1);
}

// Measure the graph the build produced, then stamp THAT measurement. The
// stamp is bound to the counts: if another writer published a different
// graph in the meantime, the counts no longer match and the stamp is
// REFUSED, leaving the previous baseline in place. Stamping the degraded
// graph would drag the baseline down with it and the guard would never fire
// again.
const measured = densityLib.readGraphCounts(cwd);
if (!measured.present) {
  console.error(`[graphify-full] FAILED: ${densityLib.graphPath(cwd)} is missing after the rebuild`);
  finish(1);
}
const stamp = densityLib.stampBaselineFromGraph(cwd, {
  expectedNodes: measured.nodes,
  expectedEdges: measured.edges,
  buildKind: "full",
});
if (!stamp.ok) {
  console.error(`[graphify-full] FAILED to stamp baseline: ${stamp.reason}`);
  finish(1);
}

console.log(
  `[graphify-full] done in ${elapsed}s: ${stamp.nodes} nodes, ${stamp.edges} edges, ` +
  `ratio=${stamp.ratio.toFixed(3)}, baseline stamped into ` +
  `${path.relative(cwd, stamp.sidecarPath)}`
);

// A commit that arrived while the lock was busy was deferred into the
// pending queue. It is replayed HERE, while this process still holds the
// lock -- releasing the lock first would let another writer start a rebuild
// that the replay could then race.
const replayed = drainLoop();

finish(replayed ? 0 : 1);

/**
 * End the runner: release the lock and, when a deferred update is still
 * queued, hand it to a follow-up drain.
 *
 * The follow-up drain matters because the drain loop can be interrupted by
 * a request that arrives AFTER the loop found the queue empty, or by a
 * replay that failed and was re-queued. Without a successor the request
 * would wait for a later commit that may never come -- the deferred commit
 * would never reach the graph.
 *
 * The successor takes the lock itself, so it cannot race this process.
 */
function finish(code) {
  releaseLock();
  // The scheduler lock is released BEFORE the follow-up drain is started:
  // the follow-up is a NEW drain, and it has to be able to take the
  // scheduler lock itself, otherwise it would refuse to start.
  releaseDrainLock();
  if (densityLib.hasPendingUpdate(cwd)) {
    const started = densityLib.startPendingDrain({ projectRoot: cwd });
    if (started && started.started) {
      console.log(
        `[graphify-full] a deferred update is still queued; a follow-up drain was started`
      );
    }
  }
  process.exit(code);
}

/**
 * Replay the deferred updates until the queue is empty.
 *
 * A single replay is not enough. While the replay ran, a NEW commit could
 * have arrived and been queued; the runner released the lock and exited, and
 * that request waited for a later commit that may never come. The same
 * applies to a replay that FAILED and was put back: nothing was left to
 * consume it.
 *
 * The loop therefore keeps replaying while the queue holds anything, and a
 * request that keeps failing is bounded by an attempt counter, so a
 * permanently broken `graphify update .` cannot make the runner spin
 * forever.
 *
 * Returns true when the queue ended up empty.
 */
function drainLoop() {
  let ok = true;
  for (let round = 0; round < 10; round += 1) {
    const pending = densityLib.takePendingUpdate(cwd);
    if (!pending) return ok;
    // The requests that have failed too often are dropped SEPARATELY. They
    // are not merged into the batch below: merging them would hand their
    // failure history to a fresh request in the same batch, and the fresh
    // request would be dropped without ever being attempted.
    if (pending.exhausted && pending.exhausted.length > 0) {
      const paths = pending.exhausted.reduce(
        (all, c) => all.concat(Array.isArray(c.changedPaths) ? c.changedPaths : []),
        [],
      );
      console.error(
        `[graphify-full] dropping a deferred update that failed ` +
        `${PENDING_MAX_ATTEMPTS} times: ${new Set(paths).size} path(s)`
      );
      ok = false;
    }
    if (pending.changedPaths.length === 0) {
      // Only exhausted requests were claimed; the loop continues so a
      // request that is still alive gets its turn.
      continue;
    }
    console.log(
      `[graphify-full] replaying ${pending.changedPaths.length} deferred path(s) ` +
      `that arrived during the rebuild`
    );
    let succeeded = false;
    try {
      const replay = spawnSync("graphify", ["update", "."], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 120_000,
      });
      succeeded = !replay.error && replay.status === 0;
      if (!succeeded) {
        console.warn(
          `[graphify-full] the deferred update did not complete ` +
          `(exit ${replay.status === null ? "none" : replay.status})`
        );
      }
    } catch (err) {
      console.warn(`[graphify-full] the deferred update failed: ${err && err.message ? err.message : String(err)}`);
      succeeded = false;
    }
    if (!succeeded) {
      // Put the request back so it is not lost, and count the attempt so
      // the loop can give up eventually instead of spinning forever.
      densityLib.writePendingUpdate(cwd, {
        changedPaths: pending.changedPaths,
        sourceHead: pending.sourceHead,
        branch: pending.branch,
        attempts: pending.attempts + 1,
      });
      ok = false;
      // The re-queued request is picked up by the next round of this loop,
      // so it is not left for a later commit.
      continue;
    }
  }
  return ok;
}

