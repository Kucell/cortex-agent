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
const { spawn, spawnSync } = require("node:child_process");

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

// A spawn stand-in that records the call and never launches anything.
// `startFullRebuild` spawns the framework's runner DETACHED, which would
// otherwise start a real `graphify extract . --force` in the test's
// working directory.
function stubSpawn(record) {
  return (command, args, options) => {
    record.push({ command, args, options });
    return {
      pid: 424242,
      on() { return this; },
      unref() {},
    };
  };
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
    const spawnCalls = [];
    const result = density.startFullRebuild({ projectRoot: root, config, spawnImpl: stubSpawn(spawnCalls) });
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

test("density: stamping the baseline never rewrites graph.json", () => {
  // The framework used to MIRROR the baseline into `graph.json._meta`. The
  // mirror is a read-modify-write of the WHOLE graph file: it publishes the
  // snapshot it read, so a graph that was replaced in the meantime is
  // silently reverted -- a newer, larger graph replaced by an older one.
  //
  // The sidecar is the durable copy, so the framework does not write the
  // graph at all: the graph belongs to the Graphify CLI alone.
  const root = mkProject("meta-mirror");
  try {
    writeGraph(root, { nodes: 100, edges: 250 });
    const before = fs.readFileSync(density.graphPath(root), "utf8");
    const stamp = density.stampBaseline(root, { nodes: 100, edges: 250, buildKind: "full" });
    assert.equal(stamp.ok, true);
    assert.equal(stamp.metaStamped, false, "the framework must not write the graph");
    const after = fs.readFileSync(density.graphPath(root), "utf8");
    assert.equal(after, before, "graph.json must be byte-identical after the stamp");
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(sidecar.edge_node_ratio, 2.5, "the sidecar carries the baseline");
    assert.equal(sidecar.build_kind, "full");
    assert.ok(sidecar.baseline_locked_at);
  } finally {
    cleanup(root);
  }
});

// ─── Concurrency and durability regressions ─────────────────────────────────

test("density: the rebuild lock admits exactly one holder", () => {
  // Two post-commit hooks running at the same time both used to read "no
  // recent rebuild" and both started a rebuild. The lock is an exclusive
  // create, so exactly one writer wins.
  const root = mkProject("rebuild-lock");
  try {
    const first = density.acquireRebuildLock(root);
    assert.ok(first, "the first acquire must succeed");
    const second = density.acquireRebuildLock(root);
    assert.equal(second, null, "a second acquire must fail while the lock is held");
    first.release();
    const third = density.acquireRebuildLock(root);
    assert.ok(third, "the lock must be acquirable again after release");
    third.release();
  } finally {
    cleanup(root);
  }
});

test("density: a concurrent rebuild start is refused instead of spawning a second one", () => {
  const root = mkProject("rebuild-lock-start");
  try {
    writeGraph(root, { nodes: 200, edges: 100 });
    writeThreshold(root, {
      min_nodes_for_check: 100,
      ratio_drop_threshold: 0.85,
      baseline_edge_node_ratio: 2.0,
      rebuild_cooldown_seconds: 0,
    });
    const config = density.readThresholdConfig(root);
    // Hold the lock the way a running rebuild would.
    const held = density.acquireRebuildLock(root);
    assert.ok(held);
    const spawnCalls = [];
    const result = density.startFullRebuild({ projectRoot: root, config, spawnImpl: stubSpawn(spawnCalls) });
    assert.equal(result.started, false);
    assert.equal(result.reason, "rebuild_in_progress");
    held.release();
  } finally {
    cleanup(root);
  }
});

test("density: the sidecar is written with an exclusive temp name", () => {
  // A shared temp name lets one writer publish another writer's half-written
  // file. Every writer must use its own temp path.
  const root = mkProject("atomic-sidecar");
  try {
    const target = path.join(root, "atomic.json");
    density.writeFileAtomic(target, "first");
    assert.equal(fs.readFileSync(target, "utf8"), "first");
    density.writeFileAtomic(target, "second");
    assert.equal(fs.readFileSync(target, "utf8"), "second");
    // No temp file is left behind.
    const leftovers = fs.readdirSync(root).filter((n) => n.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "no temp file may survive the write");
  } finally {
    cleanup(root);
  }
});

test("density: a stamp never rolls a newer graph back", () => {
  // The baseline used to be mirrored into `graph.json._meta`, and the
  // mirror was a read-modify-write of the whole graph: a graph that was
  // replaced between the read and the write was reverted -- a newer, larger
  // graph replaced by an older one.
  //
  // The framework does not write the graph at all any more, so the race is
  // gone by construction. The test injects a concurrent publisher exactly
  // where the mirror used to publish -- between the comparison and the
  // publication -- and asserts that the newer graph survives the stamp.
  const root = mkProject("meta-no-rollback");
  try {
    writeGraph(root, { nodes: 100, edges: 250 });
    const file = density.graphPath(root);

    const newer = {
      nodes: Array.from({ length: 150 }, (_, i) => ({ id: `n${i}` })),
      links: [],
    };
    let injected = false;
    let stamp;
    stamp = density.stampBaseline(root, {
      nodes: 100,
      edges: 250,
      buildKind: "full",
      onBeforeAppend: () => {
        injected = true;
        fs.writeFileSync(file, JSON.stringify(newer, null, 2));
      },
    });
    assert.equal(injected, true, "the concurrent publisher must have been injected");
    assert.equal(stamp.ok, true, "the stamp itself must still succeed");
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.nodes.length, 150, "the newer graph must survive");
    assert.equal(after._meta, undefined, "the framework must not add _meta to the graph");
  } finally {
    cleanup(root);
  }
});

test("density: a _meta baseline is migrated into the sidecar before the incremental update", () => {
  // `graphify update .` erases _meta. A project that carried the
  // consumer-side convention must not lose its baseline on the first commit
  // after the upgrade.
  const root = mkProject("meta-migration");
  try {
    writeGraph(root, { nodes: 200, edges: 400, meta: { edge_node_ratio: 2, build_kind: "full" } });
    const migrated = density.migrateMetaBaseline(root);
    assert.equal(migrated.migrated, true);
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(sidecar.edge_node_ratio, 2);
    assert.equal(sidecar.migrated_from, "graph_meta");

    // An existing sidecar is authoritative and is never overwritten.
    const again = density.migrateMetaBaseline(root);
    assert.equal(again.migrated, false);
    assert.equal(again.reason, "sidecar_present");
  } finally {
    cleanup(root);
  }
});

test("density: the migration is a no-op when there is no _meta baseline", () => {
  const root = mkProject("meta-migration-none");
  try {
    writeGraph(root, { nodes: 200, edges: 400 });
    const migrated = density.migrateMetaBaseline(root);
    assert.equal(migrated.migrated, false);
    assert.equal(migrated.reason, "no_meta_baseline");
    assert.equal(fs.existsSync(density.baselinePath(root)), false);
  } finally {
    cleanup(root);
  }
});

test("density: the full rebuild uses a command that really rebuilds from scratch", () => {
  // `graphify .` is `graphify extract .`, and extract enters incremental
  // mode whenever graph.json exists. Only --force turns that off. A "full"
  // rebuild without it would stamp the degraded ratio as the new baseline.
  const root = mkProject("full-build-command");
  try {
    writeGraph(root, { nodes: 200, edges: 100 });
    writeThreshold(root, {
      min_nodes_for_check: 100,
      ratio_drop_threshold: 0.85,
      baseline_edge_node_ratio: 2.0,
      rebuild_cooldown_seconds: 0,
      full_rebuild_timeout_seconds: 60,
    });
    const config = density.readThresholdConfig(root);
    const spawnCalls = [];
    const result = density.startFullRebuild({ projectRoot: root, config, spawnImpl: stubSpawn(spawnCalls) });
    assert.equal(result.started, true);
    assert.ok(result.runner, "the rebuild is driven by the framework's own runner");
    assert.ok(fs.existsSync(result.runner), "the runner must exist");
    // The runner must invoke the command that really rebuilds from scratch.
    const source = fs.readFileSync(result.runner, "utf8");
    assert.match(source, /"extract", "\.", "--force"/,
      "the runner must force a full extraction");
    assert.match(source, /GRAPHIFY_FORCE/,
      "the runner must also set the env-var form of the same switch");
  } finally {
    cleanup(root);
  }
});

test("density: the rebuild runner bounds the rebuild in the process that owns it", () => {
  // The timeout, the lock and the stamp all belong to the runner process.
  // An external watchdog would have to track the child's liveness across
  // process boundaries, and every such mechanism has a failure mode of
  // its own: an unreferenced timer lets it exit early, a mis-indexed
  // argument slot passes the timeout where the PID belongs.
  const root = mkProject("runner");
  try {
    writeGraph(root, { nodes: 200, edges: 100 });
    writeThreshold(root, {
      min_nodes_for_check: 100,
      ratio_drop_threshold: 0.85,
      baseline_edge_node_ratio: 2.0,
      rebuild_cooldown_seconds: 0,
      full_rebuild_timeout_seconds: 60,
    });
    const config = density.readThresholdConfig(root);
    const spawnCalls = [];
    const result = density.startFullRebuild({ projectRoot: root, config, spawnImpl: stubSpawn(spawnCalls) });
    assert.equal(result.started, true);
    assert.equal(spawnCalls.length, 1);
    assert.ok(spawnCalls[0].args[0].endsWith("full-rebuild-runner.js"),
      "the rebuild must be driven by the framework's own runner");
    const runnerSource = fs.readFileSync(result.runner, "utf8");
    assert.match(runnerSource, /timeoutMs,/,
      "the runner must apply the timeout to the build it runs");
    assert.match(runnerSource, /runGuardedUpdate/,
      "the runner must run the build under the guard that watches the lock");
    assert.match(runnerSource, /releaseLock/,
      "the runner must release the lock it owns");
    assert.match(runnerSource, /acquireRebuildLock/,
      "the runner must take the rebuild lock itself");
    assert.match(runnerSource, /isHeld\(\)/,
      "the runner must check that it still owns the lock before it stamps");
  } finally {
    cleanup(root);
  }
});

test("density: the baseline is not stamped over a graph that changed under it", () => {
  const root = mkProject("stamp-graph-changed");
  try {
    writeGraph(root, { nodes: 200, edges: 400 });
    const stamp = density.stampBaselineFromGraph(root, {
      expectedNodes: 200,
      expectedEdges: 400,
      buildKind: "full",
    });
    assert.equal(stamp.ok, true);
    assert.equal(stamp.ratio, 2);

    // A different graph is on disk now; the expected counts no longer hold.
    writeGraph(root, { nodes: 300, edges: 150 });
    const refused = density.stampBaselineFromGraph(root, {
      expectedNodes: 200,
      expectedEdges: 400,
      buildKind: "full",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "graph_changed_during_rebuild");
  } finally {
    cleanup(root);
  }
});

test("density: a lock release never removes somebody else's lock", () => {
  // A holder whose lock was reclaimed as stale must not delete the NEW
  // holder's lock when it finally cleans up.
  const root = mkProject("lock-ownership");
  try {
    const first = density.acquireRebuildLock(root);
    assert.ok(first);
    // Simulate the stale reclaim: somebody else takes the lock over.
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "someone-else",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));
    first.release();
    assert.equal(fs.existsSync(density.rebuildLockPath(root)), true,
      "a release must not remove a lock it does not own");
  } finally {
    cleanup(root);
  }
});

test("density: a lock whose holder is gone is reclaimed", () => {
  // A lock left behind by a crashed process would otherwise block every
  // incremental update until the age-based reaper runs.
  const root = mkProject("lock-stale-pid");
  try {
    fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
    const old = Date.now() - 24 * 60 * 60 * 1000;
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "dead",
      pid: 999999999,
      acquiredAt: new Date(old).toISOString(),
    }));
    const acquired = density.acquireRebuildLock(root);
    assert.ok(acquired, "a lock whose holder is gone must be reclaimed");
    acquired.release();
  } finally {
    cleanup(root);
  }
});

test("density: the pending update queue records and replays a deferred request", () => {
  // A commit that arrives while the rebuild lock is busy must not be lost.
  const root = mkProject("pending-queue");
  try {
    const written = density.writePendingUpdate(root, {
      changedPaths: ["src/a.js"],
      sourceHead: "abc123",
      branch: "main",
    });
    assert.equal(written.ok, true);
    assert.equal(fs.existsSync(density.pendingDir(root)), true);

    const pending = density.takePendingUpdate(root);
    assert.ok(pending);
    assert.deepEqual(pending.changedPaths, ["src/a.js"]);
    assert.equal(pending.sourceHead, "abc123");
    // Taking the record clears it, so it is replayed exactly once.
    assert.equal(density.takePendingUpdate(root), null);
  } finally {
    cleanup(root);
  }
});

test("density: two concurrent consumers never claim the same pending request", () => {
  // The queue is one file per request. A consumer OWNS the request it
  // removed, so a second consumer finds nothing left to claim.
  const root = mkProject("pending-exclusive");
  try {
    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    const first = density.takePendingUpdate(root);
    const second = density.takePendingUpdate(root);
    assert.ok(first);
    assert.equal(second, null, "a request must not be consumed twice");
  } finally {
    cleanup(root);
  }
});

test("density: a pending request for the same paths is not queued twice", () => {
  const root = mkProject("pending-dedupe");
  try {
    const first = density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    const second = density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const pending = density.takePendingUpdate(root);
    assert.deepEqual(pending.changedPaths, ["src/a.js"]);
  } finally {
    cleanup(root);
  }
});

test("density: the rebuild lock is never handed over to another process", () => {
  // The lock used to be handed from the hook to the detached runner through
  // the environment: the hook validated the token and then REWROTE the lock
  // file with the runner's pid. A runner that had already released the lock
  // -- or exited -- saw the lock RECREATED by that write, so the lock looked
  // held for the whole stale window and every drain was refused.
  //
  // The runner takes the lock itself now, so there is no handover at all.
  const root = mkProject("lock-handover");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock);
    assert.equal(typeof lock.transferTo, "undefined",
      "a lock must not offer a pid handover any more");
    const holder = JSON.parse(fs.readFileSync(density.rebuildLockPath(root), "utf8"));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.token, lock.token);
    assert.equal(lock.isHeld(), true, "the holder must see its own lock");
    const runnerSource = fs.readFileSync(
      path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js"),
      "utf8",
    );
    assert.equal(runnerSource.includes("transferTo"), false,
      "the runner must not inherit a lock through a handover");
    lock.release();
  } finally {
    cleanup(root);
  }
});

test("density: a live lock holder is never reclaimed because of its age", () => {
  // A rebuild can legitimately run for hours. Reclaiming its lock on age
  // alone would let the next writer race it.
  const root = mkProject("lock-age");
  try {
    fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
    const old = Date.now() - 24 * 60 * 60 * 1000;
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "live",
      pid: process.pid,
      acquiredAt: new Date(old).toISOString(),
    }));
    const acquired = density.acquireRebuildLock(root);
    assert.equal(acquired, null, "a live holder's lock must not be reclaimed");
  } finally {
    cleanup(root);
  }
});

test("density: the baseline migration never overwrites a newer baseline", () => {
  // The migration publishes a CREATE. A full rebuild that finished in the
  // meantime may already have published a newer baseline; replacing it
  // with the older _meta value would lower the threshold.
  const root = mkProject("migration-no-clobber");
  try {
    writeGraph(root, { nodes: 200, edges: 400, meta: { edge_node_ratio: 2 } });
    // A newer baseline already exists.
    density.writeFileAtomic(density.baselinePath(root), JSON.stringify({ edge_node_ratio: 4 }) + "\n");
    const migrated = density.migrateMetaBaseline(root);
    assert.equal(migrated.migrated, false);
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 4,
      "the newer baseline must survive the migration");
  } finally {
    cleanup(root);
  }
});

test("density: the runner releases the lock on every exit path", () => {
  // A lock leaked by a failed rebuild would skip every incremental update
  // until the stale reaper ran.
  const root = mkProject("runner-release");
  try {
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const source = fs.readFileSync(runner, "utf8");
    assert.match(source, /function finish\([^)]*\)\s*\{[\s\S]*?const hadLock = Boolean\(ownedLock\);[\s\S]*?releaseLock\(\);/,
      "the exit path must record that it held the lock BEFORE it releases it");
    assert.match(source, /process\.on\("exit",/,
      "the locks must be released even on an abnormal exit");
    const exitHandler = source.slice(source.indexOf('process.on("exit"'));
    assert.match(exitHandler.slice(0, 200), /releaseLock\(\)/,
      "the exit handler must release the rebuild lock");
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      assert.ok(source.includes(signal),
        "the runner must handle " + signal);
    }
  } finally {
    cleanup(root);
  }
});

test("density: a runner that fails to build releases the lock it took", () => {
  // A lock leaked by a failed rebuild would skip every incremental update
  // until the stale reaper ran. This test runs the runner FOR REAL against
  // a project whose `graphify` binary does not exist, so the build fails
  // and the runner takes its own exit path.
  //
  // A source-level assertion cannot prove this: the number of
  // `releaseLock()` call sites says nothing about whether the failing path
  // actually reaches one. Running it does.
  const root = mkProject("runner-real-failure");
  try {
    // A PATH with no `graphify` on it, so the build genuinely fails.
    const emptyBin = path.join(root, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js"),
    ], {
      cwd: root,
      encoding: "utf8",
      env: Object.assign({}, process.env, {
        PATH: emptyBin,
        GRAPHIFY_FULL_REBUILD_TIMEOUT_MS: "5000",
      }),
    });
    assert.notEqual(result.status, 0, "the runner must fail when the build fails");
    assert.equal(fs.existsSync(density.rebuildLockPath(root)), false,
      "a failed rebuild must not leak the lock");
  } finally {
    cleanup(root);
  }
});

test("density: a drain that finds the lock busy leaves the request queued", () => {
  // The drain takes the lock itself. When somebody else holds it, the
  // request must stay queued -- the drain must not publish a degraded
  // graph in parallel with the rebuild that holds the lock.
  const root = mkProject("drain-lock-busy");
  try {
    const emptyBin = path.join(root, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    // Somebody else holds the lock.
    const holder = density.acquireRebuildLock(root);
    assert.ok(holder);

    const result = spawnSync(process.execPath, [
      path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js"),
      "--drain-pending",
    ], {
      cwd: root,
      encoding: "utf8",
      env: Object.assign({}, process.env, {
        PATH: emptyBin,
        GRAPHIFY_FULL_REBUILD_TIMEOUT_MS: "5000",
        // The drain waits for the lock; the test does not want to wait for
        // the production timeout.
        GRAPHIFY_DRAIN_LOCK_WAIT_MS: "0",
      }),
    });
    assert.notEqual(result.status, 0, "the drain must report that it could not run");
    assert.equal(fs.existsSync(density.rebuildLockPath(root)), true,
      "the drain must not remove somebody else's lock");
    assert.ok(density.hasPendingUpdate(root),
      "the deferred request must stay queued while the lock is busy");
    holder.release();
  } finally {
    cleanup(root);
  }
});

test("density: two writers reclaiming the same stale lock never both win", async () => {
  // The stale reclaim must be ATOMIC with the judgement that produced it.
  // A plain unlink is a check-then-act: two writers can both read the same
  // dead lock, both conclude it is stale, and the second one then removes
  // the NEW lock the first one took -- so both believe they hold the lock
  // and the mutual exclusion is gone.
  //
  // The two writers are REAL processes started at the same time, so the
  // interleaving is genuine rather than a scripted sequence.
  const root = mkProject("stale-reclaim-race");
  try {
    fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
    // A lock whose holder is gone and which is older than the stale window.
    const old = Date.now() - 24 * 60 * 60 * 1000;
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "dead",
      pid: 999999999,
      acquiredAt: new Date(old).toISOString(),
    }));

    // A helper that tries to take the lock and reports whether it won.
    const helper = path.join(root, "try-lock.js");
    fs.writeFileSync(helper, [
      '"use strict";',
      'const density = require(' + JSON.stringify(path.join(ROOT, "lib", "graphify", "density.js")) + ');',
      'const lock = density.acquireRebuildLock(process.argv[2], { staleMs: 1000 });',
      'if (!lock) { process.stdout.write("lost"); process.exit(0); }',
      'process.stdout.write("won");',
      '// Hold the lock for a while, so a second writer has to fight for it.',
      'setTimeout(() => { lock.release(); }, 1500);',
    ].join("\n") + "\n");

    // Both writers start at the SAME time and run concurrently. A
    // sequential run would not be a race at all: the first writer would
    // finish and release before the second one even started, and the
    // second would legitimately win.
    const [first, second] = await Promise.all([
      spawnAsync(process.execPath, [helper, root], root),
      spawnAsync(process.execPath, [helper, root], root),
    ]);
    const winners = [first.stdout, second.stdout].filter((s) => s === "won").length;
    assert.equal(winners, 1,
      "exactly one writer may hold the reclaimed lock, got " +
      JSON.stringify([first.stdout, second.stdout]));
  } finally {
    cleanup(root);
  }
});

// Spawn a child and collect its stdout. Used where the test needs two
// processes to run CONCURRENTLY -- a sequential run cannot express a race.
function spawnAsync(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("close", () => resolve({ stdout: out }));
  });
}

test("density: a consumer never removes a request it did not read", () => {
  // The pending queue used to derive the file name from the request's paths
  // only. A consumer that read the file and was then interrupted, while a
  // writer removed and RECREATED the same name, would delete the NEW
  // request while replaying the OLD content -- the new request is lost.
  //
  // The file names are unique now, and the consumer claims a file by an
  // atomic rename, so a request can only ever be removed by the consumer
  // that read exactly that file.
  const root = mkProject("pending-generation");
  try {
    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    const dir = density.pendingDir(root);
    const first = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
    assert.equal(first.length, 1);

    // A second request for the SAME paths must get a DIFFERENT file: the
    // name identifies the generation, not just the content.
    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    const second = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
    assert.equal(second.length, 2,
      "two requests for the same paths must occupy two files");
    assert.notEqual(second[0], second[1]);

    // Consuming removes exactly the files that were there; a request
    // written afterwards survives.
    const taken = density.takePendingUpdate(root);
    assert.ok(taken);
    assert.deepEqual(taken.changedPaths, ["src/a.js"]);
    density.writePendingUpdate(root, { changedPaths: ["src/b.js"] });
    const after = density.takePendingUpdate(root);
    assert.ok(after, "a request written after the consume must survive it");
    assert.deepEqual(after.changedPaths, ["src/b.js"]);
  } finally {
    cleanup(root);
  }
});

test("density: a stale reclaim never deletes the lock a new holder took", () => {
  // The interleaving the review described:
  //   A judges the stale lock reclaimable;
  //   B -- a live holder -- takes the lock in that window;
  //   A resumes and removes it.
  // A then acquires the lock as well, so both believe they hold it and the
  // mutual exclusion is silently gone.
  //
  // The window is far too narrow to hit reliably by racing two processes,
  // so the test injects it through the `onStaleJudged` seam: B's takeover
  // happens exactly inside that window.
  //
  // The assertion that matters is that B's lock is LEFT ALONE. An earlier
  // version of this test asserted only that the surviving lock was A's and
  // not B's -- which is satisfied by "A deleted B's lock and took a new
  // one", i.e. by the very defect the test claims to prevent. The test has
  // to distinguish the fix from the defect, not merely describe the outcome.
  const root = mkProject("stale-reclaim-interleaving");
  try {
    fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
    const old = Date.now() - 24 * 60 * 60 * 1000;
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "dead",
      pid: 999999999,
      acquiredAt: new Date(old).toISOString(),
    }));

    // B's takeover, inside A's judgement window. B's holder is a RUNNING
    // process, so its lock is live and must not be reclaimable at all.
    let bToken = null;
    const takeover = () => {
      const file = density.rebuildLockPath(root);
      try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
      bToken = "b-new-lock";
      fs.writeFileSync(file, JSON.stringify({
        token: bToken,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }));
    };

    const a = density.acquireRebuildLock(root, {
      staleMs: 1000,
      onStaleJudged: takeover,
    });

    assert.ok(bToken, "the takeover must have happened");
    assert.equal(fs.existsSync(density.rebuildLockPath(root)), true,
      "B's lock must still exist");
    const holder = JSON.parse(fs.readFileSync(density.rebuildLockPath(root), "utf8"));
    assert.equal(holder.token, bToken,
      "B's lock must be untouched: A must not delete a LIVE lock");
    assert.equal(a, null,
      "A must not acquire the lock while B holds a live one");
  } finally {
    cleanup(root);
  }
});

test("density: the baseline is still published when hard links are unavailable", () => {
  // `link()` is the primitive that makes an exclusive publish atomic, but
  // it is not available on every filesystem (FAT32, some network mounts,
  // some container volumes). When it is missing, the publication has to
  // fall back to an exclusive create -- otherwise the baseline is never
  // written and the pending queue is never filled, while the caller
  // carries on as if it had worked.
  const root = mkProject("no-hardlink");
  try {
    const original = fs.linkSync;
    fs.linkSync = () => {
      const err = new Error("operation not supported");
      err.code = "EOPNOTSUPP";
      throw err;
    };
    try {
      // The pending queue must still record the request.
      const written = density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
      assert.equal(written.ok, true,
        "the queue must fall back to an exclusive create when link() is unsupported");
      const pending = density.takePendingUpdate(root);
      assert.ok(pending, "the queued request must be readable");
      assert.deepEqual(pending.changedPaths, ["src/a.js"]);

      // The baseline migration must still publish the sidecar.
      writeGraph(root, { nodes: 200, edges: 400, meta: { edge_node_ratio: 2 } });
      const migrated = density.migrateMetaBaseline(root);
      assert.equal(migrated.migrated, true,
        "the migration must fall back to an exclusive create when link() is unsupported");
      const sidecar = density.readBaselineSidecar(root);
      assert.ok(sidecar, "the baseline must exist after the fallback publication");
      assert.equal(sidecar.edge_node_ratio, 2);
    } finally {
      fs.linkSync = original;
    }
  } finally {
    cleanup(root);
  }
});

test("density: a drain that waits for the lock consumes the deferred request", async () => {
  // The drain used to give up the moment the lock was busy, which left the
  // deferred request in the queue with nobody to consume it: the commit it
  // describes would never reach the graph. The drain now waits for the
  // holder to finish and then consumes the request.
  //
  // The `graphify` stub records the calls it received, so the test can see
  // the deferred update actually ran.
  const root = mkProject("drain-waits-for-lock");
  try {
    const binDir = path.join(root, "stub-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, "graphify");
    fs.writeFileSync(stub, [
      "#!/usr/bin/env node",
      '"use strict";',
      "const fs = require('fs');",
      "const path = require('path');",
      "fs.appendFileSync(path.join(process.cwd(), 'stub-calls.log'), JSON.stringify({ args: process.argv.slice(2) }) + '\\n');",
      // The writer writes into the directory GRAPHIFY_OUT points at, like
      // the real CLI does: the framework publishes the staged graph itself.
      "const outDir = process.env.GRAPHIFY_OUT ? path.resolve(process.env.GRAPHIFY_OUT) : path.join(process.cwd(), 'graphify-out');",
      "fs.mkdirSync(outDir, { recursive: true });",
      "fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'b' }] }));",
      "fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schemaVersion: '1.0', graphifyVersion: '0.9.27-stub', generatedAt: new Date().toISOString(), includedRoots: [], excludedRoots: [], nodeCount: 2, edgeCount: 1, generationMode: 'update' }));",
      "process.exit(0);",
      "",
    ].join("\n"), { mode: 0o755 });

    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });

    // Somebody else holds the lock, and releases it shortly afterwards --
    // exactly what a finishing rebuild does. The holder has to be a SEPARATE
    // process: the test blocks in `spawnSync` while the drain runs, so a
    // timer in this process would never fire.
    const holderScript = path.join(root, "holder.js");
    fs.writeFileSync(holderScript, [
      '"use strict";',
      'const density = require(' + JSON.stringify(path.join(ROOT, "lib", "graphify", "density.js")) + ');',
      "const lock = density.acquireRebuildLock(process.argv[2]);",
      "if (!lock) { process.exit(2); }",
      'process.stdout.write("held\\n");',
      "setTimeout(() => { lock.release(); }, 400);",
      "setTimeout(() => process.exit(0), 800);",
    ].join("\n") + "\n");
    const holderChild = spawn(process.execPath, [holderScript, root], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    // Wait until the holder has actually taken the lock.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the holder did not take the lock")), 5000);
      holderChild.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("held")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const result = spawnSync(process.execPath, [
      path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js"),
      "--drain-pending",
    ], {
      cwd: root,
      encoding: "utf8",
      env: Object.assign({}, process.env, {
        PATH: binDir + path.delimiter + process.env.PATH,
        GRAPHIFY_FULL_REBUILD_TIMEOUT_MS: "5000",
        GRAPHIFY_DRAIN_LOCK_WAIT_MS: "10000",
      }),
    });
    assert.equal(result.status, 0,
      "the drain must succeed once the lock is free: " + (result.stderr || ""));
    const calls = fs.existsSync(path.join(root, "stub-calls.log"))
      ? fs.readFileSync(path.join(root, "stub-calls.log"), "utf8")
        .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      : [];
    assert.ok(calls.some((c) => c.args[0] === "update"),
      "the deferred update must have run");
    assert.equal(density.hasPendingUpdate(root), false,
      "the queue must be empty after the drain");
    holderChild.kill();
  } finally {
    cleanup(root);
  }
});

test("density: a follow-up drain never inherits the lock it was started with", async () => {
  // The follow-up drain is spawned by `finish()`, AFTER the runner released
  // the lock. The child inherited the lock path through the environment, so
  // it believed it already held the lock, skipped the acquire, and ran the
  // incremental update without holding anything -- while another process
  // could have taken the lock in the meantime. The mutual exclusion was
  // broken again.
  //
  // The starter therefore clears the inherited lock variables, and the drain
  // always acquires its own.
  const root = mkProject("drain-no-inherited-lock");
  try {
    const binDir = path.join(root, "stub-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, "graphify");
    fs.writeFileSync(stub, [
      "#!/usr/bin/env node",
      '"use strict";',
      "const fs = require('fs');",
      "const path = require('path');",
      // Record the lock the process saw, and whether it was held by a live
      // process at that moment.
      "const lockFile = path.join(process.cwd(), '.agent', 'plugins', 'graphify', '.density-rebuild.lock');",
      "let held = false;",
      "try {",
      "  const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));",
      "  held = typeof holder.pid === 'number' && holder.pid !== process.pid;",
      "} catch (_) {}",
      "fs.appendFileSync(path.join(process.cwd(), 'stub-calls.log'), JSON.stringify({ args: process.argv.slice(2), sawLiveLock: held }) + '\\n');",
      "process.exit(0);",
      "",
    ].join("\n"), { mode: 0o755 });

    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });

    // A drain is started while a rebuild lock is held by somebody else.
    const holder = density.acquireRebuildLock(root);
    assert.ok(holder);
    const started = density.startPendingDrain({ projectRoot: root });
    assert.equal(started.started, true);

    // The drain must not have run the update while the lock was held by
    // another process. It waits for the lock instead.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const log = path.join(root, "stub-calls.log");
      if (fs.existsSync(log)) {
        const calls = fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
        assert.ok(calls.every((c) => c.sawLiveLock === false),
          "the drain must never run the update while another process holds the lock");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    holder.release();
  } finally {
    cleanup(root);
  }
});

test("density: an exhausted request does not take a fresh one down with it", () => {
  // The attempts counter is the maximum over the merged batch. When an
  // exhausted request was merged with a fresh one, the fresh request
  // inherited the exhausted counter and was dropped without ever being
  // attempted -- the commit it described never reached the graph.
  const root = mkProject("pending-attempt-isolation");
  try {
    // A request that has failed too often, and a fresh one.
    const exhausted = density.writePendingUpdate(root, {
      changedPaths: ["src/old.js"],
      attempts: 99,
    });
    const fresh = density.writePendingUpdate(root, { changedPaths: ["src/new.js"] });
    assert.equal(exhausted.ok, true);
    assert.equal(fresh.ok, true);

    const taken = density.takePendingUpdate(root);
    assert.ok(taken);
    // The fresh request must be replayed.
    assert.deepEqual(taken.changedPaths, ["src/new.js"],
      "the fresh request must not inherit the exhausted request's counter");
    // The exhausted one is reported separately so the caller can drop it.
    assert.equal(taken.exhausted.length, 1);
    assert.deepEqual(taken.exhausted[0].changedPaths, ["src/old.js"]);
  } finally {
    cleanup(root);
  }
});

test("density: a claim left behind by a dead consumer is recovered", () => {
  // A consumer claims a request by renaming it to a `.claimed-*` name. If
  // it dies between the claim and the removal, the request stays in that
  // name: invisible to the queue, and nothing would ever replay it.
  const root = mkProject("pending-claim-recovery");
  try {
    const written = density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    assert.equal(written.ok, true);
    const dir = density.pendingDir(root);
    const source = fs.readdirSync(dir).find((n) => n.endsWith(".json") && !n.startsWith("."));
    assert.ok(source);

    // A consumer that claimed the request and then died: the claim names a
    // process that is gone, and it is older than the stale window.
    const claimName = ".claimed-999999999-" + (Date.now() - 24 * 60 * 60 * 1000) + "-deadbeef.json";
    const claimPath = path.join(dir, claimName);
    fs.renameSync(path.join(dir, source), claimPath);
    fs.writeFileSync(claimPath, JSON.stringify({
      schemaVersion: "1.0",
      recordedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      changedPaths: ["src/a.js"],
      sourceHead: null,
      branch: null,
      attempts: 0,
    }, null, 2) + "\n");

    assert.equal(density.hasPendingUpdate(root), false,
      "an abandoned claim is invisible until it is recovered");

    const taken = density.takePendingUpdate(root);
    assert.ok(taken, "the abandoned claim must be recovered and replayed");
    assert.deepEqual(taken.changedPaths, ["src/a.js"]);
    assert.equal(fs.existsSync(claimPath), false,
      "the recovered claim must be removed");
  } finally {
    cleanup(root);
  }
});

test("density: a drain serialises on the rebuild lock instead of a second lock", () => {
  // The drain used to take a SECOND, dedicated "scheduler" lock that made
  // the drain a singleton. It guarded nothing that the rebuild lock does
  // not already guard, and its handover carried the same race as the
  // rebuild lock's handover: the starter rewrote the lock file after the
  // child had already released it, so the lock was RECREATED and every
  // later drain was refused for the whole stale window.
  //
  // The drain takes the REBUILD lock now, so two drains can never write the
  // graph at the same time, and a request is consumed exactly once because
  // the claim is an atomic rename.
  const root = mkProject("drain-serialised");
  try {
    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    const runnerSource = fs.readFileSync(
      path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js"),
      "utf8",
    );
    assert.match(runnerSource, /acquireRebuildLock/,
      "the drain must take the rebuild lock itself");
    assert.equal(runnerSource.includes("acquireDrainSchedulerLock"), false,
      "the separate scheduler lock must be gone");
    // A request is consumed exactly once, no matter how many consumers see
    // it: the claim is an atomic rename.
    const first = density.takePendingUpdate(root);
    assert.ok(first, "the request must be claimable");
    const second = density.takePendingUpdate(root);
    assert.equal(second, null, "a request must never be consumed twice");
  } finally {
    cleanup(root);
  }
});
