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

// The timeout and the lock path are supplied by the spawning hook, so the
// two sides cannot disagree about them.
const timeoutMs = resolveTimeoutMs();
const lockPath = process.env.GRAPHIFY_REBUILD_LOCK_PATH || null;
const lockToken = process.env.GRAPHIFY_REBUILD_LOCK_TOKEN || null;

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
  if (released || !lockPath) return;
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

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    releaseLock();
    process.exit(143);
  });
}
process.on("exit", releaseLock);
process.on("uncaughtException", (err) => {
  console.error(`[graphify-full] FAILED: ${err && err.message ? err.message : String(err)}`);
  releaseLock();
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
  const drained = replayPendingUpdate();
  releaseLock();
  process.exit(drained ? 0 : 1);
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
  releaseLock();
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[graphify-full] FAILED: exit ${result.status} after ${elapsed}s`);
  releaseLock();
  process.exit(result.status || 1);
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
  releaseLock();
  process.exit(1);
}
const stamp = densityLib.stampBaselineFromGraph(cwd, {
  expectedNodes: measured.nodes,
  expectedEdges: measured.edges,
  buildKind: "full",
});
if (!stamp.ok) {
  console.error(`[graphify-full] FAILED to stamp baseline: ${stamp.reason}`);
  releaseLock();
  process.exit(1);
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
const replayed = replayPendingUpdate();

releaseLock();

process.exit(replayed ? 0 : 0);

/**
 * Replay a deferred incremental update.
 *
 * The request is only removed from the queue when the replay actually
 * SUCCEEDED. A failed replay puts it back, so the deferred commit is not
 * silently lost: the next update picks it up.
 *
 * Returns true when there was nothing to do or the replay succeeded.
 */
function replayPendingUpdate() {
  const pending = densityLib.takePendingUpdate(cwd);
  if (!pending || pending.changedPaths.length === 0) return true;
  console.log(
    `[graphify-full] replaying ${pending.changedPaths.length} deferred path(s) ` +
    `that arrived during the rebuild`
  );
  let ok = false;
  try {
    const replay = spawnSync("graphify", ["update", "."], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 120_000,
    });
    ok = !replay.error && replay.status === 0;
    if (!ok) {
      console.warn(
        `[graphify-full] the deferred update did not complete ` +
        `(exit ${replay.status === null ? "none" : replay.status})`
      );
    }
  } catch (err) {
    console.warn(`[graphify-full] the deferred update failed: ${err && err.message ? err.message : String(err)}`);
    ok = false;
  }
  if (!ok) {
    // Put the request back so it is not lost.
    densityLib.writePendingUpdate(cwd, {
      changedPaths: pending.changedPaths,
      sourceHead: pending.sourceHead,
      branch: pending.branch,
    });
  }
  return ok;
}
