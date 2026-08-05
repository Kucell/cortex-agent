"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const bridgeSync = require("../../lib/cross-project/bridge-sync");
const subscriptions = require("../../lib/cross-project/subscriptions");
const inboxStore = require("../../lib/cross-project/inbox-store");

function mkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withRoots(fn) {
  return (t) => {
    const target = mkDir("cortex-bridge-sync-target-");
    const source = mkDir("cortex-bridge-sync-source-");
    t.after(() => fs.rmSync(target, { recursive: true, force: true }));
    t.after(() => fs.rmSync(source, { recursive: true, force: true }));
    return fn(t, target, source);
  };
}

function event(overrides = {}) {
  return {
    bridge_event_id: "BR-EVT-001",
    source_project_id: "cortex-agent",
    source_task_id: "T-001",
    event_type: "task.state_changed",
    correlation_group: "XPC-DASHBOARD-PRD",
    summary: { to_state: "READY_FOR_REVIEW", from_state: "EXECUTING" },
    propagated_at: "2026-08-05T00:00:01.000Z",
    ...overrides,
  };
}

function seedOutbox(sourceRoot, sourceProjectId, events) {
  const dir = bridgeSync.sourceOutboxDir(sourceRoot, sourceProjectId);
  fs.mkdirSync(dir, { recursive: true });
  for (const ev of events) {
    fs.writeFileSync(path.join(dir, `${ev.bridge_event_id}.json`), JSON.stringify(ev));
  }
}

// ─── sourceOutboxDir / cursorsPath ────────────────────────────────────────

test("sourceOutboxDir and cursorsPath follow the agreed layout", withRoots((t, target, source) => {
  assert.equal(
    bridgeSync.sourceOutboxDir(source, "cortex-agent"),
    path.join(source, ".agent-runtime", "cross-project", "outbox", "cortex-agent"),
  );
  assert.equal(
    bridgeSync.cursorsPath(target),
    path.join(target, ".agent-runtime", "cross-project", "cursors.json"),
  );
}));

// ─── syncForProject: argument validation ───────────────────────────────────

test("syncForProject requires sourceProjectId", withRoots((t, target, source) => {
  assert.throws(
    () => bridgeSync.syncForProject(target, { sourceRoot: source }),
    (err) => err.code === "BRIDGE_SYNC_INVALID",
  );
}));

test("syncForProject requires sourceRoot", withRoots((t, target) => {
  assert.throws(
    () => bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent" }),
    (err) => err.code === "BRIDGE_SYNC_INVALID",
  );
}));

// ─── syncForProject: cold start / no subscription / unreachable ───────────

test("syncForProject: no subscription for the source is a clean no-op", withRoots((t, target, source) => {
  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.ok, true);
  assert.equal(result.written, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.sources.length, 0);
  assert.equal(inboxStore.listInbox(target).length, 0);
}));

test("syncForProject: unreachable source returns reachable=false without throwing", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.ok, true);
  assert.equal(result.reachable, false);
  assert.equal(result.written, 0);
}));

// ─── syncForProject: happy path ────────────────────────────────────────────

test("syncForProject: writes matching events to inbox and updates cursor", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  seedOutbox(source, "cortex-agent", [
    event({ bridge_event_id: "BR-EVT-001", propagated_at: "2026-08-05T00:00:01.000Z" }),
    event({ bridge_event_id: "BR-EVT-002", propagated_at: "2026-08-05T00:00:02.000Z" }),
  ]);

  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.ok, true);
  assert.equal(result.reachable, true);
  assert.equal(result.scanned, 2);
  assert.equal(result.matched, 2);
  assert.equal(result.written, 2);
  assert.equal(result.cursor.last_bridge_event_id, "BR-EVT-002");
  assert.equal(result.cursor.last_propagated_at, "2026-08-05T00:00:02.000Z");

  const inbox = inboxStore.readInbox(target, "cortex-agent");
  assert.equal(inbox.events.length, 2);
  assert.equal(inbox.events[0].bridge_event_id, "BR-EVT-002"); // newest first
  assert.equal(inbox.events[1].bridge_event_id, "BR-EVT-001");
}));

// ─── cursor advances / re-sync skips already-delivered events ─────────────

test("syncForProject: re-syncing after cursor advance skips already-delivered events", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  seedOutbox(source, "cortex-agent", [event({ bridge_event_id: "BR-EVT-001", propagated_at: "2026-08-05T00:00:01.000Z" })]);

  const first = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(first.written, 1);

  // Add a new event to the outbox.
  fs.writeFileSync(
    path.join(bridgeSync.sourceOutboxDir(source, "cortex-agent"), "BR-EVT-002.json"),
    JSON.stringify(event({ bridge_event_id: "BR-EVT-002", propagated_at: "2026-08-05T00:00:02.000Z" })),
  );

  const second = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(second.scanned, 2);
  assert.equal(second.matched, 1); // only the new event passes the cursor
  assert.equal(second.written, 1);
  assert.equal(second.cursor.last_bridge_event_id, "BR-EVT-002");
}));

// ─── filter excludes uninteresting events ────────────────────────────────

test("syncForProject: subscription filter.to_state excludes other to_state values", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, {
    source_project_id: "cortex-agent",
    event_types: ["task.state_changed"],
    filter: { to_state: ["READY_FOR_REVIEW", "BLOCKED"] },
  });
  seedOutbox(source, "cortex-agent", [
    event({ bridge_event_id: "BR-EVT-A", summary: { to_state: "EXECUTING" }, propagated_at: "2026-08-05T00:00:01.000Z" }),
    event({ bridge_event_id: "BR-EVT-B", summary: { to_state: "READY_FOR_REVIEW" }, propagated_at: "2026-08-05T00:00:02.000Z" }),
    event({ bridge_event_id: "BR-EVT-C", summary: { to_state: "COMPLETED" }, propagated_at: "2026-08-05T00:00:03.000Z" }),
  ]);

  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.scanned, 3);
  assert.equal(result.matched, 1);
  assert.equal(result.written, 1);
  const { events } = inboxStore.readInbox(target, "cortex-agent");
  assert.equal(events.length, 1);
  assert.equal(events[0].bridge_event_id, "BR-EVT-B");
}));

// ─── event_type filter ───────────────────────────────────────────────────

test("syncForProject: subscription event_types excludes non-matching types", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["decision.resolved"] });
  seedOutbox(source, "cortex-agent", [
    event({ bridge_event_id: "BR-EVT-A", event_type: "task.state_changed" }),
    event({ bridge_event_id: "BR-EVT-B", event_type: "decision.resolved" }),
  ]);
  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.scanned, 2);
  assert.equal(result.matched, 1);
  assert.equal(result.written, 1);
  const { events } = inboxStore.readInbox(target, "cortex-agent");
  assert.equal(events[0].bridge_event_id, "BR-EVT-B");
}));

// ─── correlation_group filter ────────────────────────────────────────────

test("syncForProject: correlation_group filter excludes other groups", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, {
    source_project_id: "cortex-agent",
    event_types: ["task.state_changed"],
    correlation_group: "XPC-DASHBOARD-PRD",
  });
  seedOutbox(source, "cortex-agent", [
    event({ bridge_event_id: "BR-EVT-A", correlation_group: "XPC-OTHER" }),
    event({ bridge_event_id: "BR-EVT-B", correlation_group: "XPC-DASHBOARD-PRD" }),
    event({ bridge_event_id: "BR-EVT-C" /* no group */ }),
  ]);
  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.scanned, 3);
  assert.equal(result.matched, 1);
  assert.equal(result.written, 1);
  const { events } = inboxStore.readInbox(target, "cortex-agent");
  assert.equal(events[0].bridge_event_id, "BR-EVT-B");
}));

// ─── multiple subscriptions, single source ────────────────────────────────

test("syncForProject: event matching multiple subscriptions is still written once", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed", "decision.resolved"] });
  seedOutbox(source, "cortex-agent", [event({ bridge_event_id: "BR-EVT-001" })]);
  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.matched, 1);
  assert.equal(result.written, 1);
  const { events } = inboxStore.readInbox(target, "cortex-agent");
  assert.equal(events.length, 1);
}));

// ─── source with multiple sources: per-source scope ──────────────────────

test("syncForProject: events from another source are not pulled in", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  seedOutbox(source, "cortex-agent", [event({ bridge_event_id: "BR-EVT-C" })]);
  seedOutbox(source, "SamHMI", [event({ bridge_event_id: "BR-EVT-S", source_project_id: "SamHMI" })]);
  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.scanned, 1);
  assert.equal(result.written, 1);
  const { events } = inboxStore.readInbox(target, "cortex-agent");
  assert.equal(events.length, 1);
  assert.equal(events[0].bridge_event_id, "BR-EVT-C");
}));

// ─── corrupt source events are skipped ───────────────────────────────────

test("syncForProject: corrupt source events count as skipped, not as writes", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  seedOutbox(source, "cortex-agent", [event({ bridge_event_id: "BR-EVT-001" })]);
  fs.writeFileSync(
    path.join(bridgeSync.sourceOutboxDir(source, "cortex-agent"), "BR-EVT-CORRUPT.json"),
    "not json",
  );
  const result = bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  assert.equal(result.scanned, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.written, 1);
}));

// ─── cursor persistence is atomic ────────────────────────────────────────

test("syncForProject: cursor file is written atomically (no temp files)", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  seedOutbox(source, "cortex-agent", [event({ bridge_event_id: "BR-EVT-001" })]);
  bridgeSync.syncForProject(target, { sourceProjectId: "cortex-agent", sourceRoot: source });
  const dir = path.join(target, ".agent-runtime", "cross-project");
  const stragglers = fs.readdirSync(dir).filter((n) => n.includes(".tmp."));
  assert.equal(stragglers.length, 0, `unexpected temp files: ${stragglers.join(",")}`);
}));

// ─── isAfterCursor: ties broken by id ────────────────────────────────────

test("isAfterCursor: ties by propagated_at fall through to bridge_event_id lexicographic", () => {
  const cursor = { last_bridge_event_id: "BR-EVT-002", last_propagated_at: "2026-08-05T00:00:01.000Z" };
  assert.equal(bridgeSync.isAfterCursor({ bridge_event_id: "BR-EVT-001", propagated_at: "2026-08-05T00:00:01.000Z" }, cursor), false);
  assert.equal(bridgeSync.isAfterCursor({ bridge_event_id: "BR-EVT-003", propagated_at: "2026-08-05T00:00:01.000Z" }, cursor), true);
  assert.equal(bridgeSync.isAfterCursor({ bridge_event_id: "BR-EVT-002", propagated_at: "2026-08-05T00:00:01.000Z" }, cursor), false);
  assert.equal(bridgeSync.isAfterCursor({ bridge_event_id: "BR-EVT-002", propagated_at: "2026-08-05T00:00:02.000Z" }, cursor), true);
});

// ─── syncAll: iterates all subscriptions ─────────────────────────────────

test("syncAll: iterates over every distinct source_project_id in subscriptions", withRoots((t, target, source) => {
  subscriptions.addSubscription(target, { source_project_id: "cortex-agent", event_types: ["task.state_changed"] });
  subscriptions.addSubscription(target, { source_project_id: "SamHMI", event_types: ["decision.resolved"] });
  seedOutbox(source, "cortex-agent", [event({ bridge_event_id: "BR-EVT-C" })]);
  seedOutbox(source, "SamHMI", [event({ bridge_event_id: "BR-EVT-S", source_project_id: "SamHMI", event_type: "decision.resolved" })]);

  const run = bridgeSync.syncAll(target, { sourceRoot: source });
  assert.equal(run.ok, true);
  assert.equal(run.sources.length, 2);
  const bySource = Object.fromEntries(run.sources.map((s) => [s.source_project_id, s.result]));
  assert.equal(bySource["cortex-agent"].written, 1);
  assert.equal(bySource["SamHMI"].written, 1);
});
