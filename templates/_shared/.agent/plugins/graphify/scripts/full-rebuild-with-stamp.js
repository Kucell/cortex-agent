#!/usr/bin/env node
"use strict";

/**
 * full-rebuild-with-stamp.js -- Graphify full rebuild that records the
 * edge-density baseline (issue #154).
 *
 * The post-commit hook detects that the incrementally updated graph lost
 * edge density and starts this script DETACHED, so the commit is never
 * blocked. This script:
 *
 *   1. runs `graphify .` (a FULL build) in the foreground of the child
 *      process, under a timeout;
 *   2. reads the resulting node / edge counts;
 *   3. stamps the measured ratio as the new baseline.
 *
 * Only a FULL build may write the baseline. The incremental path
 * (`graphify update .`) never does: a baseline that moved down together
 * with the degraded graph would make the density threshold unreachable
 * and the fallback would silently stop working.
 *
 * The script resolves the shared implementation the same way the
 * post-commit wrapper does, so it works inside a consumer project without
 * depending on where the framework is installed. When the shared module
 * cannot be resolved the script still performs the rebuild and simply does
 * not stamp a baseline -- degrading to "no fallback", never to a crash.
 */

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const cwd = process.cwd();

// Resolve the shared implementation relative to this script's install path:
//   <project>/.agent/plugins/graphify/scripts/full-rebuild-with-stamp.js
// -> <project>/.agent/plugins/graphify/lib/graphify/density.js
const candidates = [
  path.join(__dirname, "..", "lib", "graphify", "density.js"),
  path.join(__dirname, "..", "..", "..", "..", "lib", "graphify", "density.js"),
  path.join(__dirname, "..", "..", "lib", "graphify", "density.js"),
];

let densityLib = null;
for (const candidate of candidates) {
  try {
    densityLib = require(candidate);
    break;
  } catch (_) {
    // try the next candidate
  }
}

// The timeout is supplied by the spawning hook through the environment so
// the two sides cannot disagree about it.
function resolveTimeoutMs() {
  const fromEnv = Number(process.env.GRAPHIFY_FULL_REBUILD_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (densityLib) {
    const config = densityLib.readThresholdConfig(cwd);
    const seconds = Number(config.full_rebuild_timeout_seconds);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  }
  return 1800 * 1000;
}

const timeoutMs = resolveTimeoutMs();
const startedAt = Date.now();
console.log(
  `[graphify-full] start: graphify extract . --force (timeout=${Math.round(timeoutMs / 1000)}s, cwd=${cwd})`
);

// The spawning hook took the rebuild lock BEFORE spawning this process, so
// the full build and the incremental update are mutually exclusive for the
// whole rebuild. This process OWNS that lock and releases it when it ends --
// including on failure, so a failed rebuild does not wedge the project.
const lockPath = process.env.GRAPHIFY_REBUILD_LOCK_PATH || null;
let released = false;
function releaseLock() {
  if (released || !lockPath) return;
  released = true;
  // Only remove the lock when it is still OURS. A lock that was reclaimed
  // as stale belongs to somebody else now, and removing it would break the
  // mutual exclusion for the new holder.
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const token = process.env.GRAPHIFY_REBUILD_LOCK_TOKEN || null;
    if (token && current && current.token && current.token !== token) return;
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    // A corrupt lock cannot be attributed to a holder; removing it keeps the
    // project usable.
  }
  try { fs.unlinkSync(lockPath); } catch (_) { /* already released */ }
}

// Release the lock on every exit path, including an uncaught exception and
// a termination signal. A lock leaked by a killed rebuild would skip every
// incremental update until the stale reaper ran.
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

if (!densityLib) {
  // The rebuild succeeded; only the baseline stamp is unavailable. This is
  // a degraded but non-fatal outcome: the graph is fresh, the guard simply
  // falls back to the configured baseline on the next check.
  console.warn(
    `[graphify-full] done in ${elapsed}s, but the shared density module could not be resolved; ` +
    `no baseline was stamped.`
  );
  releaseLock();
  process.exit(0);
}

// Measure and stamp in ONE step, bound to the graph state on disk RIGHT NOW.
// If an incremental update published a different graph in the meantime, the
// stamp is refused and the previous baseline stays in place. Stamping the
// degraded graph would drag the baseline down with it and the guard would
// never fire again.
const stamp = densityLib.stampBaselineFromGraph(cwd, { buildKind: "full" });
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

releaseLock();
process.exit(0);
