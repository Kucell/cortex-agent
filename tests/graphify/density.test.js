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

test("density: the _meta mirror never rolls a newer graph back", () => {
  // The mirror is a read-modify-write of the WHOLE graph. If the graph was
  // replaced between the read and the write, publishing the snapshot reverts
  // the newer graph. The mirror must refuse in that case.
  //
  // The race window is BETWEEN the read and the write inside the mirror, so
  // the test injects the concurrent publisher exactly there: the graph is
  // replaced after the mirror has parsed it but before it publishes.
  const root = mkProject("meta-no-rollback");
  try {
    writeGraph(root, { nodes: 100, edges: 250 });
    const file = density.graphPath(root);

    const newer = {
      nodes: Array.from({ length: 150 }, (_, i) => ({ id: `n${i}` })),
      links: [],
    };
    const realReadFileSync = fs.readFileSync;
    let injected = false;
    // Replace the graph right AFTER the mirror read it and BEFORE it
    // publishes. The mirror compares the file identity it parsed with the
    // identity on disk, so the replacement is detected.
    fs.readFileSync = function patched(target, ...rest) {
      const result = realReadFileSync.call(fs, target, ...rest);
      if (!injected && String(target) === file) {
        injected = true;
        fs.writeFileSync(file, JSON.stringify(newer, null, 2));
      }
      return result;
    };

    const payload = {
      build_kind: "full",
      edge_node_ratio: 2.5,
      baseline_locked_at: new Date().toISOString(),
    };
    let stamped;
    try {
      stamped = density.stampGraphMeta(root, payload);
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    assert.equal(injected, true, "the concurrent publisher must have been injected");
    assert.equal(stamped, false, "the mirror must refuse to publish over a changed graph");
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.nodes.length, 150, "the newer graph must survive");
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
    assert.ok(result.lockPath, "the rebuild must record the lock it holds");
    assert.equal(spawnCalls.length, 1);
    assert.ok(spawnCalls[0].args[0].endsWith("full-rebuild-runner.js"),
      "the rebuild must be driven by the framework's own runner");
    const runnerSource = fs.readFileSync(result.runner, "utf8");
    assert.match(runnerSource, /timeout: timeoutMs/,
      "the runner must apply the timeout to the build it runs");
    assert.match(runnerSource, /releaseLock/,
      "the runner must release the lock it owns");
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

test("density: the lock is handed over to the rebuild process", () => {
  // The hook that starts a detached rebuild exits immediately. A lock that
  // still named the HOOK's pid would look abandoned while the rebuild is
  // still running, and the next hook would reclaim it and race the rebuild.
  const root = mkProject("lock-handover");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock);
    assert.equal(lock.transferTo(4242), true);
    const holder = JSON.parse(fs.readFileSync(density.rebuildLockPath(root), "utf8"));
    assert.equal(holder.pid, 4242);
    assert.equal(holder.token, lock.token, "the token must survive the handover");
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
    const releaseCalls = (source.match(/releaseLock\(\)/g) || []).length;
    assert.ok(releaseCalls >= 5,
      "the runner must release the lock on every exit path");
    assert.match(source, /process\.on\("exit", releaseLock\)/,
      "the lock must be released even on an abnormal exit");
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      assert.ok(source.includes(signal),
        "the runner must handle " + signal);
    }
  } finally {
    cleanup(root);
  }
});
