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
const markersLib = require("./markers");

const cwd = process.cwd();

// How many times a deferred update may be replayed before it is dropped.
// Without a bound, a permanently failing `graphify update .` would make the
// drain loop spin forever inside one runner.
const PENDING_MAX_ATTEMPTS = 5;

// How many drains may follow each other in a chain.
//
// A drain that finds the queue non-empty when it finishes starts a
// successor, and a successor can start another one. Without a bound the
// chain has no end: while the lock stays busy, every drain times out on the
// lock and the queue stays non-empty, so the chain keeps growing.
const MAX_DRAIN_GENERATIONS = 3;

// The timeout and the lock path are supplied by the spawning hook, so the
// two sides cannot disagree about them.
const timeoutMs = resolveTimeoutMs();
// The drain scheduler lock. It is handed to the drain process so that no
// second drain can start while this one is running -- the chain of
// follow-up drains would otherwise have no upper bound.
// The lock this process owns. The runner takes the rebuild lock ITSELF in
// both modes.
//
// It used to inherit the lock from the hook through the environment, and
// the handover was a race in itself: the hook validated the token and then
// rewrote the lock file, so a runner that had already released the lock,
// or exited, saw the lock RECREATED by the hook's write. The lock then
// looked held for the whole stale window and every drain was refused. With
// the runner taking the lock itself there is no handover and no window.
let ownedLock = null;
// The generation of this drain in the follow-up chain. The first drain is
// generation 1; every successor increments it.
const drainGeneration = Number(process.env.GRAPHIFY_DRAIN_GENERATION) || 1;

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
  released = true;
  if (!ownedLock) return;
  // The handle carries the token check: a lock that was reclaimed as stale
  // belongs to somebody else now, and removing it would break the mutual
  // exclusion for that holder.
  ownedLock.release();
  ownedLock = null;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    releaseLock();
    process.exit(143);
  });
}
process.on("exit", () => {
  releaseLock();
});
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
// The full build takes the rebuild lock itself.
//
// The lock is what keeps the full build and the incremental update mutually
// exclusive: without it, an incremental update can publish a degraded
// graph between the full build's write and its baseline stamp, and the
// stamp then records the DEGRADED ratio as the new "full" baseline -- the
// exact state the guard exists to prevent.
//
// The wait is bounded: an incremental update that is already running gets
// a chance to finish, and a lock that stays busy does not block the
// rebuild for ever. The deferred requests stay queued either way.
const buildLock = acquireLockWithRetry({ attempts: 60, delayMs: 1000 });
if (!buildLock) {
  console.log(
    `[graphify-full] the rebuild lock is busy; the rebuild is skipped and ` +
    `the deferred updates stay queued`
  );
  finish(1);
}
ownedLock = buildLock;
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
// The FENCE: before the baseline is stamped, this process checks that it
// still owns the lock. A lock can be reclaimed as stale while its holder
// is alive -- the judgement and the takeover are separate steps -- so a
// holder that lost the lock must not stamp a baseline. A refused stamp
// leaves the previous baseline in place, which is the conservative
// outcome: the guard keeps firing instead of silently stopping.
if (!ownedLock || !ownedLock.isHeld()) {
  console.error(
    `[graphify-full] FAILED to stamp baseline: the rebuild lock was lost ` +
    `while the rebuild was running`
  );
  finish(1);
}
const stamp = densityLib.stampBaselineFromGraph(cwd, {
  expectedNodes: measured.nodes,
  expectedEdges: measured.edges,
  buildKind: "full",
  // The generation of the lock this runner holds. A baseline written under
  // an older generation was written by a holder that lost the lock, and it
  // is refused here and distrusted by the reader.
  lockGeneration: ownedLock.generation,
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
  // The fact that this process HELD the lock is captured BEFORE the lock
  // is released.
  //
  // The release clears the handle, so the check that used to come after it
  // was always true: the follow-up drain was never started, and a request
  // that arrived between the last empty check and the exit stayed queued
  // with nobody to consume it. The commit it described never reached the
  // graph.
  const hadLock = Boolean(ownedLock);
  releaseLock();
  // The follow-up drain is started ONLY when this run actually held the
  // lock and consumed the queue. A drain that could not take the lock in
  // the first place must not spawn a successor: the process that HOLDS the
  // lock is the one that will drain the queue when it finishes. Deriving a
  // successor from a failed attempt is what turned the follow-up chain into
  // an unbounded sequence of processes.
  if (!hadLock) {
    process.exit(code);
  }
  if (drainGeneration >= MAX_DRAIN_GENERATIONS) {
    // The chain has reached its bound. The request stays queued: the next
    // commit, or the next rebuild, will drain it. Stopping here is what
    // keeps the chain from growing without end.
    if (densityLib.hasPendingUpdate(cwd)) {
      console.warn(
        `[graphify-full] the follow-up drain chain reached its bound ` +
        `(${MAX_DRAIN_GENERATIONS}); a deferred update stays queued`
      );
    }
    process.exit(code);
  }
  if (densityLib.hasPendingUpdate(cwd)) {
    const started = densityLib.startPendingDrain({
      projectRoot: cwd,
      generation: drainGeneration + 1,
    });
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
function settleAfterEmptyQueue({ rounds = 3, delayMs = 100 } = {}) {
  for (let round = 0; round < rounds; round += 1) {
    sleepSync(delayMs);
    if (densityLib.hasPendingUpdate(cwd)) return true;
  }
  return false;
}

function drainLoop() {
  let ok = true;
  for (let round = 0; round < 10; round += 1) {
    const pending = densityLib.takePendingUpdate(cwd);
    if (!pending) {
      // The queue is empty, but a request can arrive in the window between
      // this check and the exit. The runner therefore settles for a short
      // while before it gives up: a request that arrives there is replayed
      // by this run instead of waiting for a commit that may never come.
      if (settleAfterEmptyQueue()) continue;
      return ok;
    }
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
      // The exhausted requests are dropped for good, so their claim files
      // are removed too; otherwise they would linger in the queue forever.
      densityLib.completePendingUpdate(pending.exhaustedClaims);
      ok = false;
    }
    if (pending.changedPaths.length === 0) {
      // Only exhausted requests were claimed; the loop continues so a
      // request that is still alive gets its turn.
      continue;
    }
    // The requests are replayed in GROUPS of equal attempt count. A single
    // merged batch would hand the highest counter to every request in it,
    // so a fresh request queued next to a request that already failed four
    // times would inherit that budget and be dropped after a single further
    // failure -- without ever having been retried properly.
    const groups = pending.groups && pending.groups.length > 0
      ? pending.groups
      : [{
        attempts: pending.attempts,
        changedPaths: pending.changedPaths,
        semanticPaths: pending.semanticPaths || [],
        sourceHead: pending.sourceHead,
        branch: pending.branch,
        claims: pending.claims,
      }];
    // A drain that cannot publish its result stops instead of spinning.
    // The tight loop below would otherwise retry the SAME request until it
    // burned its whole budget -- five attempts in one run -- and drop it,
    // which is exactly the loss the retry budget exists to prevent.
    let stop = false;
    for (const group of groups) {
      console.log(
        `[graphify-full] replaying ${group.changedPaths.length} deferred path(s) ` +
        `that arrived during the rebuild`
      );
      let succeeded = false;
      try {
        // The FENCE before the write: a drain whose lock was reclaimed must
        // not publish a graph. The check is a comparison of values, so the
        // window between it and the write is closed by the generation that
        // travels with the artifacts this drain confirms.
        if (!ownedLock || !ownedLock.isHeld()) {
          console.warn(
            `[graphify-full] the rebuild lock was lost; the deferred update ` +
            `was not replayed`
          );
          densityLib.releasePendingUpdate(cwd, group.claims, {
            attempts: group.attempts + 1,
          });
          ok = false;
          stop = true;
          break;
        }
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
        // The request is put back so it is not lost, and the attempt counter
        // is carried over so the loop can give up eventually instead of
        // spinning forever. The claim files are only removed once the
        // request has been handed back to the queue.
        densityLib.releasePendingUpdate(cwd, group.claims, {
          attempts: group.attempts + 1,
        });
        ok = false;
        // The re-queued request is picked up by the next round of this loop,
        // so it is not left for a later commit.
        continue;
      }
      // A deferred SEMANTIC change is not covered by an incremental update:
      // the update only refreshes the code graph. The stale marker is what
      // tells the next session that the semantic graph is out of date.
      //
      // The marker is written BEFORE the claims are confirmed. The order
      // matters: a marker that failed to land must leave the request
      // recoverable, otherwise the semantic change loses every persistent
      // reminder -- the queue is empty and the marker does not exist.
      const semanticPaths = Array.isArray(group.semanticPaths) ? group.semanticPaths : [];
      if (semanticPaths.length > 0) {
        const marker = markersLib.writeMarker({
          graphDir: path.join(cwd, "graphify-out"),
          kind: markersLib.KIND.SEMANTIC,
          reason: "semantic_changes_only",
          changedPaths: semanticPaths,
          sourceHead: group.sourceHead || null,
          branch: group.branch || null,
        });
        if (!marker || !marker.ok) {
          console.error(
            `[graphify-full] the deferred semantic marker could not be ` +
            `written; the request stays queued`
          );
          densityLib.releasePendingUpdate(cwd, group.claims, {
            attempts: group.attempts + 1,
          });
          ok = false;
          // The drain stops here. The request is back in the queue with its
          // attempt counted, and the next drain tries again -- with the
          // budget spread over several runs instead of burned in one.
          stop = true;
          break;
        }
      }
      // The replay succeeded and the marker landed, so the claims are
      // removed for good. Until this point the claim files were still on
      // disk: a runner that died during the replay left the request
      // recoverable instead of losing it.
      densityLib.completePendingUpdate(group.claims);
    }
    if (stop) return ok;
  }
  return ok;
}

