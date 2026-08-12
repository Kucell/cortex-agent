"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const listener = require("../../lib/automation/inbox-listener");
const inboxStore = require("../../lib/cross-project/inbox-store");
const outbox = require("../../lib/cross-project/outbox");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-p006-inbox-"));
}

function writeHandler(root, id, body) {
  const dir = listener.bridgesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

test("bridgesDir defaults under .agent", () => {
  const root = mkRoot();
  assert.equal(listener.bridgesDir(root), path.join(root, ".agent", "bridges"));
});

test("planDispatch respects correlation_group", () => {
  const handler = {
    event_types: ["task.state_changed", "decision.resolved"],
    correlation_group: "agentic-ui-delivery",
    target_mission_id: "M-019",
  };
  const matching = {
    bridge_event_id: "BR-EVT-x",
    event_type: "task.state_changed",
    correlation_group: "agentic-ui-delivery",
    summary: { foo: 1 },
    propagated_at: "2026-08-12T00:00:00.000Z",
  };
  const plan = listener.planDispatch(matching, handler);
  assert.equal(plan.target_mission_id, "M-019");
  assert.deepEqual(plan.payload.summary, { foo: 1 });

  const wrongGroup = { ...matching, correlation_group: "hmi-collab" };
  assert.equal(listener.planDispatch(wrongGroup, handler), null);
  const wrongType = { ...matching, event_type: "checkpoint.closed" };
  assert.equal(listener.planDispatch(wrongType, handler), null);
});

test("runOnce returns error when handler is missing", () => {
  const root = mkRoot();
  const out = listener.runOnce(root, { handler_id: "missing" });
  assert.equal(out.ok, false);
});

test("runOnce dispatches matching events to sidecar files", () => {
  const root = mkRoot();
  writeHandler(root, "h1", {
    source_project_id: "hmi-platform",
    event_types: ["task.state_changed"],
    correlation_group: "agentic-ui-delivery",
    target_mission_id: "M-019",
    target_milestone: "MS-INTEGRATION",
  });
  // Seed the inbox with a single matching event.
  inboxStore.writeInboxEntry(root, "hmi-platform", {
    bridge_event_id: "BR-EVT-p006-d1",
    source_project_id: "hmi-platform",
    event_type: "task.state_changed",
    summary: { task_id: "M-017", state: "READY_FOR_REVIEW" },
    correlation_group: "agentic-ui-delivery",
    propagated_at: "2026-08-12T01:00:00.000Z",
  });
  const out = listener.runOnce(root, { handler_id: "h1" });
  assert.equal(out.ok, true);
  assert.equal(out.dispatched.length, 1);
  assert.equal(out.dispatched[0].bridge_event_id, "BR-EVT-p006-d1");
  assert.ok(fs.existsSync(out.dispatched[0].sidecar));
  const plan = JSON.parse(fs.readFileSync(out.dispatched[0].sidecar, "utf8"));
  assert.equal(plan.target_mission_id, "M-019");
  assert.equal(plan.target_milestone, "MS-INTEGRATION");
  assert.equal(plan.payload.event_type, "task.state_changed");
});

test("runOnce skips events not yet after cursor", () => {
  const root = mkRoot();
  writeHandler(root, "h1", {
    source_project_id: "hmi-platform",
    event_types: ["task.state_changed"],
    target_mission_id: "M-019",
  });
  inboxStore.writeInboxEntry(root, "hmi-platform", {
    bridge_event_id: "BR-EVT-p006-d1",
    source_project_id: "hmi-platform",
    event_type: "task.state_changed",
    summary: {},
    propagated_at: "2026-08-12T00:00:00.000Z",
  });
  // First run consumes everything.
  const r1 = listener.runOnce(root, { handler_id: "h1" });
  assert.equal(r1.dispatched.length, 1);
  // Second run should not re-dispatch.
  const r2 = listener.runOnce(root, { handler_id: "h1" });
  assert.equal(r2.dispatched.length, 0);
});

test("runAllOnce iterates all known handlers", () => {
  const root = mkRoot();
  writeHandler(root, "h1", { source_project_id: "hmi-platform", event_types: ["task.state_changed"], target_mission_id: "M-019" });
  writeHandler(root, "h2", { source_project_id: "SamHMI", event_types: ["decision.resolved"], target_mission_id: "M-017" });
  const out = listener.runAllOnce(root);
  assert.equal(out.ok, true);
  assert.equal(out.runs.length, 2);
});

test("listInboxHandlers returns empty when bridges dir absent", () => {
  const root = mkRoot();
  assert.deepEqual(listener.listInboxHandlers(root), []);
});
