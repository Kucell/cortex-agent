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
  `[graphify-full] start: graphify . (timeout=${Math.round(timeoutMs / 1000)}s, cwd=${cwd})`
);

const result = spawnSync("graphify", ["."], {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "inherit", "inherit"],
  timeout: timeoutMs,
});

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
if (result.error) {
  console.error(`[graphify-full] FAILED: ${result.error.message} after ${elapsed}s`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[graphify-full] FAILED: exit ${result.status} after ${elapsed}s`);
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
  process.exit(0);
}

const counts = densityLib.readGraphCounts(cwd);
if (!counts.present) {
  console.error(`[graphify-full] FAILED: ${densityLib.graphPath(cwd)} is missing after the rebuild`);
  process.exit(1);
}

const stamp = densityLib.stampBaseline(cwd, {
  nodes: counts.nodes,
  edges: counts.edges,
  buildKind: "full",
});
if (!stamp.ok) {
  console.error(`[graphify-full] FAILED to stamp baseline: ${stamp.reason}`);
  process.exit(1);
}

console.log(
  `[graphify-full] done in ${elapsed}s: ${counts.nodes} nodes, ${counts.edges} edges, ` +
  `ratio=${stamp.ratio.toFixed(3)}, baseline stamped into ` +
  `${path.relative(cwd, stamp.sidecarPath)}`
);

process.exit(0);
