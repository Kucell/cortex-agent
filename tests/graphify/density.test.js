"use strict";

// ─── Graphify edge-density guard tests (issue #154) ────────────────────────
//
// Pins the contract of lib/graphify/density.js:
//   - A LOW density graph triggers the full-rebuild decision.
//   - A HEALTHY density graph does not.
//   - The INCREMENTAL path never writes the baseline.
//   - The baseline priority is sidecar > graph _meta > configured value.
//   - Small graphs are skipped by the min_nodes_for_check guard.
//   - A missing baseline skips the check instead of guessing.
//
// Every fixture lives under the repository's `.agent-work/` scratch
// directory: the runtime-artifact convention requires artifacts to stay
// under `.agent/`, never in the temp directory.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const density = require("../../lib/graphify/density");

const ROOT = path.resolve(__dirname, "..", "..");
const WORK_ROOT = path.join(ROOT, ".agent-work", "test-density");

function mkProject(name) {
  const root = path.join(WORK_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
  fs.mkdirSync(path.join(root, "graphify-out"), { recursive: true });
  return root;
}

function writeGraph(root, { nodes, edges, meta = null }) {
  const graph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
    links: Array.from({ length: edges }, (_, i) => ({ source: `n${i % Math.max(nodes, 1)}`, target: `n0` })),
    hyperedges: [],
  };
  if (meta) graph._meta = meta;
  fs.writeFileSync(
    path.join(root, "graphify-out", "graph.json"),
    JSON.stringify(graph, null, 2),
  );
}

function writeThreshold(root, config) {
  fs.writeFileSync(
    path.join(root, ".agent", "plugins", "graphify", "threshold.json"),
    JSON.stringify(config, null, 2),
  );
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

test("density: low density triggers the full rebuild", () => {
  const root = mkProject("low-density");
  try {
    // 200 nodes / 100 edges -> ratio 0.5, well below baseline 2.0.
    writeGraph(root, { nodes: 200, edges: 100 });
    writeThreshold(root, {
      min_nodes_for_check: 100,
      ratio_drop_threshold: 0.85,
      baseline_edge_node_ratio: 2.0,
      full_rebuild_timeout_seconds: 60,
    });
    const config = density.readThresholdConfig(root);
    const counts = density.readGraphCounts(root);
    const baseline = density.resolveBaseline(root, config, counts);
    const decision = density.evaluateDensity({ projectRoot: root, config, counts, baseline });
    assert.equal(decision.trigger, true);
    assert.equal(decision.reason, "density_dropped");
    assert.equal(decision.ratio, 0.5);
    assert.equal(decision.threshold, 1.7);
    assert.equal(decision.baseline, 2.0);
    assert.equal(decision.baselineSource, "threshold_config");
  } finally {
    cleanup(root);
  }
});

test("density: healthy density does not trigger the rebuild", () => {
  const root = mkProject("healthy-density");
  try {
    // 200 nodes / 380 edges -> ratio 1.9, above baseline 2.0 * 0.85 = 1.7.
    writeGraph(root, { nodes: 200, edges: 380 });
    writeThreshold(root, {
      min_nodes_for_check: 100,
      ratio_drop_threshold: 0.85,
      baseline_edge_node_ratio: 2.0,
    });
    const config = density.readThresholdConfig(root);
    const counts = density.readGraphCounts(root);
    const baseline = density.resolveBaseline(root, config, counts);
    const decision = density.evaluateDensity({ projectRoot: root, config, counts, baseline });
    assert.equal(decision.trigger, false);
    assert.equal(decision.reason, "density_ok");
    assert.ok(decision.ratio > decision.threshold);
  } finally {
    cleanup(root);
  }
});

test("density: the incremental path never writes the baseline", () => {
  const root = mkProject("incremental-no-stamp");
  try {
    writeGraph(root, { nodes: 200, edges: 100 });
    writeThreshold(root, { min_nodes_for_check: 100, ratio_drop_threshold: 0.85, baseline_edge_node_ratio: 2.0 });
    const baselineFile = density.baselinePath(root);
    assert.equal(fs.existsSync(baselineFile), false, "no baseline may exist before a full build");

    // A low-density incremental state must trigger the DECISION without the
    // decision itself writing a baseline. `checkAndMaybeRebuild` only
    // starts a rebuild; the baseline is stamped by the rebuild wrapper.
    const config = density.readThresholdConfig(root);
    const counts = density.readGraphCounts(root);
    const baseline = density.resolveBaseline(root, config, counts);
    const decision = density.evaluateDensity({ projectRoot: root, config, counts, baseline });
    assert.equal(decision.trigger, true);
    assert.equal(fs.existsSync(baselineFile), false,
      "the incremental path must not write the baseline");

    // The only writer is stampBaseline, which the full-build path calls.
    const stamp = density.stampBaseline(root, { nodes: 200, edges: 400, buildKind: "full" });
    assert.equal(stamp.ok, true);
    assert.equal(fs.existsSync(baselineFile), true);
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(sidecar.edge_node_ratio, 2);
    assert.equal(sidecar.build_kind, "full");
  } finally {
    cleanup(root);
  }
});

test("density: the baseline sidecar survives an incremental update that erases _meta", () => {
  // `graphify update .` rewrites graph.json and drops every key the CLI
  // does not own -- `_meta` included. The durable baseline therefore
  // lives in a sidecar next to the plugin, not inside graph.json.
  const root = mkProject("sidecar-survives");
  try {
    writeGraph(root, { nodes: 200, edges: 400 });
    const stamp = density.stampBaseline(root, { nodes: 200, edges: 400, buildKind: "full" });
    assert.equal(stamp.ok, true);

    // Simulate what `graphify update .` does: rewrite graph.json without _meta.
    writeGraph(root, { nodes: 200, edges: 120 });

    const config = density.readThresholdConfig(root);
    const counts = density.readGraphCounts(root);
    assert.equal(counts.meta.edge_node_ratio, undefined, "_meta must be gone after the update");
    const baseline = density.resolveBaseline(root, config, counts);
    assert.equal(baseline.source, "density_baseline_sidecar");
    assert.equal(baseline.value, 2);
  } finally {
    cleanup(root);
  }
});

test("density: baseline priority is sidecar > graph _meta > configured value", () => {
  const root = mkProject("baseline-priority");
  try {
    writeThreshold(root, { min_nodes_for_check: 1, ratio_drop_threshold: 0.85, baseline_edge_node_ratio: 1.5 });

    // (3) configured value only.
    writeGraph(root, { nodes: 100, edges: 100 });
    let config = density.readThresholdConfig(root);
    let counts = density.readGraphCounts(root);
    let baseline = density.resolveBaseline(root, config, counts);
    assert.equal(baseline.source, "threshold_config");
    assert.equal(baseline.value, 1.5);

    // (2) graph _meta wins over the configured value.
    writeGraph(root, { nodes: 100, edges: 100, meta: { edge_node_ratio: 2.5 } });
    counts = density.readGraphCounts(root);
    baseline = density.resolveBaseline(root, config, counts);
    assert.equal(baseline.source, "graph_meta");
    assert.equal(baseline.value, 2.5);

    // (1) the sidecar wins over both.
    density.stampBaseline(root, { nodes: 100, edges: 300, buildKind: "full" });
    counts = density.readGraphCounts(root);
    baseline = density.resolveBaseline(root, config, counts);
    assert.equal(baseline.source, "density_baseline_sidecar");
    assert.equal(baseline.value, 3);
  } finally {
    cleanup(root);
  }
});

test("density: small graphs are skipped by the min_nodes_for_check guard", () => {
  const root = mkProject("min-nodes");
  try {
    writeGraph(root, { nodes: 20, edges: 2 });
    writeThreshold(root, { min_nodes_for_check: 100, ratio_drop_threshold: 0.85, baseline_edge_node_ratio: 2.0 });
    const config = density.readThresholdConfig(root);
    const counts = density.readGraphCounts(root);
    const baseline = density.resolveBaseline(root, config, counts);
    const decision = density.evaluateDensity({ projectRoot: root, config, counts, baseline });
    assert.equal(decision.trigger, false);
    assert.equal(decision.reason, "below_min_nodes");
  } finally {
    cleanup(root);
  }
});

test("density: a missing baseline skips the check instead of guessing", () => {
  const root = mkProject("no-baseline");
  try {
    writeGraph(root, { nodes: 200, edges: 10 });
    // No sidecar, no _meta, and the configured baseline is null.
    writeThreshold(root, { min_nodes_for_check: 100, ratio_drop_threshold: 0.85, baseline_edge_node_ratio: null });
    const config = density.readThresholdConfig(root);
    const counts = density.readGraphCounts(root);
    const baseline = density.resolveBaseline(root, config, counts);
    assert.equal(baseline, null);
    const decision = density.evaluateDensity({ projectRoot: root, config, counts, baseline });
    assert.equal(decision.trigger, false);
    assert.equal(decision.reason, "no_baseline");
  } finally {
    cleanup(root);
  }
});

test("density: the framework defaults are conservative", () => {
  // A project that configured nothing must not start spawning multi-minute
  // rebuilds because of a default nobody chose.
  assert.equal(density.DEFAULT_THRESHOLD.baseline_edge_node_ratio, null);
  assert.equal(density.DEFAULT_THRESHOLD.min_nodes_for_check, 100);
  assert.ok(density.DEFAULT_THRESHOLD.ratio_drop_threshold > 0);
  assert.ok(density.DEFAULT_THRESHOLD.ratio_drop_threshold <= 1);

  const root = mkProject("defaults");
  try {
    const config = density.readThresholdConfig(root);
    assert.equal(config.baseline_edge_node_ratio, null);
    assert.equal(config.min_nodes_for_check, 100);
  } finally {
    cleanup(root);
  }
});

test("density: a corrupt threshold file degrades to the framework defaults", () => {
  const root = mkProject("corrupt-threshold");
  try {
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "threshold.json"),
      "{ not json",
    );
    const config = density.readThresholdConfig(root);
    assert.equal(config.min_nodes_for_check, density.DEFAULT_THRESHOLD.min_nodes_for_check);
    assert.equal(config.baseline_edge_node_ratio, null);
  } finally {
    cleanup(root);
  }
});

test("density: the rebuild cooldown suppresses a burst of rebuilds", () => {
  const root = mkProject("cooldown");
  try {
    writeGraph(root, { nodes: 200, edges: 100 });
    writeThreshold(root, {
      min_nodes_for_check: 100,
      ratio_drop_threshold: 0.85,
      baseline_edge_node_ratio: 2.0,
      rebuild_cooldown_seconds: 1800,
    });
    // Record a rebuild that just started.
    fs.writeFileSync(
      density.rebuildStatePath(root),
      JSON.stringify({ startedAt: new Date().toISOString(), pid: 1, logPath: "x" }),
    );
    const config = density.readThresholdConfig(root);
    const result = density.startFullRebuild({ projectRoot: root, config });
    assert.equal(result.started, false);
    assert.equal(result.reason, "rebuild_cooldown");
    assert.ok(result.retryAfterSeconds > 0);
  } finally {
    cleanup(root);
  }
});

test("density: checkAndMaybeRebuild never throws and reports the decision", () => {
  const root = mkProject("entry-point");
  try {
    // No graph at all -> the check reports "graph_missing" and does nothing.
    const missing = density.checkAndMaybeRebuild({ projectRoot: root });
    assert.equal(missing.checked, false);
    assert.equal(missing.reason, "graph_missing");
    assert.equal(missing.rebuild, null);

    // No project root -> the guard is inert.
    const inert = density.checkAndMaybeRebuild({ projectRoot: null });
    assert.equal(inert.checked, false);
    assert.equal(inert.reason, "no_project_root");
  } finally {
    cleanup(root);
  }
});

test("density: stamping the baseline mirrors the value into graph.json _meta", () => {
  const root = mkProject("meta-mirror");
  try {
    writeGraph(root, { nodes: 100, edges: 250 });
    const stamp = density.stampBaseline(root, { nodes: 100, edges: 250, buildKind: "full" });
    assert.equal(stamp.ok, true);
    assert.equal(stamp.metaStamped, true);
    const graph = JSON.parse(fs.readFileSync(density.graphPath(root), "utf8"));
    assert.equal(graph._meta.edge_node_ratio, 2.5);
    assert.equal(graph._meta.build_kind, "full");
    assert.ok(graph._meta.baseline_locked_at);
  } finally {
    cleanup(root);
  }
});

