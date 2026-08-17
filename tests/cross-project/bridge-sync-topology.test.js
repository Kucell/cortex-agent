"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const bridgeSync = require("../../lib/cross-project/bridge-sync");
const subscriptions = require("../../lib/cross-project/subscriptions");
const topologyRegistry = require("../../lib/topology");
const { resolveRuntimePaths } = require("../../lib/runtime-layout");

function mkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTwoRoots(fn) {
  return (t) => {
    const target = mkDir("cortex-bridge-auto-target-");
    const source = mkDir("cortex-bridge-auto-source-");
    t.after(() => fs.rmSync(target, { recursive: true, force: true }));
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    return fn(t, target, source);
  };
}

function event(overrides = {}) {
  return {
    bridge_event_id: "BR-EVT-auto-001",
    source_project_id: "hmi-platform",
    source_task_id: "T-017",
    event_type: "task.state_changed",
    correlation_group: "agentic-ui-delivery",
    summary: { to_state: "READY_FOR_REVIEW" },
    propagated_at: "2026-08-12T01:00:00.000Z",
    ...overrides,
  };
}

function writeTopology(root, peers) {
  const dir = path.join(root, ".agent", "topology");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({
    schema_version: 1,
    self: { project_id: "SamHMI", host_root: root, declared_at: "2026-08-12T00:00:00.000Z" },
    peers,
  }, null, 2));
}

function seedSourceOutbox(sourceRoot, sourceProjectId, events) {
  const dir = bridgeSync.sourceOutboxDir(sourceRoot, sourceProjectId);
  fs.mkdirSync(dir, { recursive: true });
  for (const ev of events) {
    fs.writeFileSync(path.join(dir, `${ev.bridge_event_id}.json`), JSON.stringify(ev));
  }
}

// ─── syncFromTopology: happy path ───────────────────────────────────────

test("syncFromTopology syncs every subscription with topology-resolved host_root", withTwoRoots((t, target, source) => {
  writeTopology(target, [
    { project_id: "hmi-platform", host_root: source, role: "producer", registered_at: "2026-08-12T00:00:00.000Z" },
    // peer with empty host_root: syncFromTopology treats this as unresolved
    { project_id: "other-peer", host_root: "", role: "consumer", registered_at: "2026-08-12T00:00:00.000Z" },
  ]);
  subscriptions.addSubscription(target, {
    source_project_id: "hmi-platform",
    correlation_group: "agentic-ui-delivery",
    event_types: ["task.state_changed"],
  });
  subscriptions.addSubscription(target, {
    source_project_id: "other-peer",
    correlation_group: "agentic-ui-delivery",
    event_types: ["task.state_changed"],
  });
  seedSourceOutbox(source, "hmi-platform", [event()]);

  const run = bridgeSync.syncFromTopology(target);
  assert.equal(run.ok, true);
  assert.equal(run.total, 2);
  assert.equal(run.reachable, 1);
  assert.equal(run.unreachable, 1);
  assert.equal(run.unresolved.length, 1);
  assert.equal(run.unresolved[0].source_project_id, "other-peer");
  assert.equal(run.unresolved[0].reason, "peer_missing_host_root");
  const reachable = run.sources.find((s) => s.source_project_id === "hmi-platform");
  assert.equal(reachable.result.scanned, 1);
  assert.equal(reachable.result.matched, 1);
  assert.equal(reachable.result.written, 1);

  // MS-003: Updated to use correct runtime path based on activation state
  // Inbox file was written for the reachable source
  const targetPaths = resolveRuntimePaths(target);
  const inboxFile = path.join(targetPaths["cross-project"].new, "inbox", "hmi-platform", "BR-EVT-auto-001.json");
  assert.ok(fs.existsSync(inboxFile), "inbox file should exist for reachable source");

  // Idempotent: a second call should not re-write because cursor advanced
  const second = bridgeSync.syncFromTopology(target);
  const reachable2 = second.sources.find((s) => s.source_project_id === "hmi-platform");
  assert.equal(reachable2.result.scanned, 1, "still scans outbox");
  assert.equal(reachable2.result.written, 0, "cursor prevents re-write");
}));

// ─── syncFromTopology: empty subscriptions ─────────────────────────────

test("syncFromTopology with no subscriptions returns an empty run", (t) => {
  const target = mkDir("cortex-bridge-auto-empty-");
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  writeTopology(target, []);

  const run = bridgeSync.syncFromTopology(target);
  assert.equal(run.ok, true);
  assert.equal(run.total, 0);
  assert.equal(run.reachable, 0);
  assert.equal(run.sources.length, 0);
});

// ─── syncFromTopology: peer_not_in_topology ────────────────────────────

test("syncFromTopology reports unreachable when subscription has no topology entry", (t) => {
  const target = mkDir("cortex-bridge-auto-orphan-");
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  // No topology file at all
  subscriptions.addSubscription(target, {
    source_project_id: "ghost-peer",
    event_types: ["task.state_changed"],
  });

  const run = bridgeSync.syncFromTopology(target);
  assert.equal(run.ok, true);
  assert.equal(run.total, 1);
  assert.equal(run.unreachable, 1);
  assert.equal(run.unresolved[0].reason, "peer_not_in_topology");
  assert.equal(run.sources[0].result.errors[0].code, "BRIDGE_SYNC_TOPOLOGY_UNRESOLVED");
});

// ─── syncFromTopology: dedup ────────────────────────────────────────────

test("syncFromTopology dedups multiple subscriptions to the same source", withTwoRoots((t, target, source) => {
  writeTopology(target, [
    { project_id: "hmi-platform", host_root: source, role: "producer", registered_at: "2026-08-12T00:00:00.000Z" },
  ]);
  subscriptions.addSubscription(target, {
    source_project_id: "hmi-platform",
    event_types: ["task.state_changed"],
  });
  subscriptions.addSubscription(target, {
    source_project_id: "hmi-platform",
    event_types: ["decision.resolved"],
  });
  seedSourceOutbox(source, "hmi-platform", [event()]);

  const run = bridgeSync.syncFromTopology(target);
  assert.equal(run.total, 1, "same source deduped to a single sync");
  assert.equal(run.sources.length, 1);
}));