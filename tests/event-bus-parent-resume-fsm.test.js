"use strict";

// ─── M-004 MS-003 VC-008: parent-resume client FSM tests ────────────────────
//
// Coverage (17 cases target):
//   1. State transitions (5): INIT→RECEIVED→ACKED→RUNNING→DONE, FAILED branch
//   2. Trigger events (5): spawned/progress/completed/failed/cancelled
//   3. Lease validation (2): valid lease pass / invalid lease 3 retry + escalate
//   4. Mission validation (2): mission_id exists / mission_id missing reject
//   5. P-003 integration (3): inbox write / subscriptions read / bridge sync trigger
//
// Total: 17 cases (target ~17)
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-008
//   - docs/architecture/framework-event-bus-design.md §3.3
//   - lib/event-bus/clients/parent-resume.js

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const parentResume = require(path.join(ROOT, "lib", "event-bus", "clients", "parent-resume"));

let _counter = 0;

function freshRoot() {
  _counter++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-008-" + process.pid + "-" + _counter + "-"));
  fs.mkdirSync(path.join(root, ".agent", "missions", "M-VC008"), { recursive: true });
  return root;
}

function makeEvent(name, opts) {
  opts = opts || {};
  return {
    event_id: "eb-evt-" + name + "-" + Math.random().toString(36).slice(2, 10),
    event_name: name,
    event_version: "1.0",
    bus_id: opts.busId || "test:M-VC008",
    occurred_at: new Date().toISOString(),
    producer: opts.producer || {
      producer_id: "parent-m-vc008",
      producer_kind: "parent_agent",
      session_id: "S-VC008",
    },
    correlation: {
      mission_id: opts.missionId || "M-VC008",
      subagent_id: opts.subagentId || "sub-1",
      parent_run_id: opts.parentRunId || "R-VC008-001",
      causation_id: null,
    },
    payload: opts.payload || {},
  };
}

function makeActiveLeaseProvider(missionId) {
  return {
    isLeaseActive(id) { return id === missionId; },
    getActiveLease(id) {
      return id === missionId ? { lease_id: "L-1", held_by: "parent-m-vc008", scope: id, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() } : null;
    },
  };
}

function makeInactiveLeaseProvider() {
  return {
    isLeaseActive() { return false; },
    getActiveLease() { return null; },
  };
}

// ─── Setup hook: reset state before each test ──────────────────────────────

test.beforeEach(() => {
  parentResume._resetForTests();
});

// ─── 1. State transitions (5) ──────────────────────────────────────────────

test("VC-008 T1: INIT → RECEIVED on subagent_spawned", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  const result = parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  assert.equal(result.ack, true);
  assert.equal(result.next_state, "RECEIVED");
});

test("VC-008 T2: RECEIVED → ACKED on subagent_progress", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  const result = parentResume.handle(makeEvent("subagent_progress", { payload: { percent: 50 } }));
  assert.equal(result.ack, true);
  assert.equal(result.next_state, "ACKED");
});

test("VC-008 T3: ACKED → DONE on subagent_completed (resume_action=resume_parent)", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  parentResume.handle(makeEvent("subagent_progress", { payload: { percent: 30 } }));
  const result = parentResume.handle(makeEvent("subagent_completed", { payload: { status: "success", output_summary: "done" } }));
  assert.equal(result.ack, true);
  assert.equal(result.next_state, "DONE");
  assert.equal(result.resume_action, "resume_parent");
  assert.equal(result.terminal, true);
});

test("VC-008 T4: ACKED → FAILED on subagent_failed (resume_action=resume_parent_with_failure)", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  parentResume.handle(makeEvent("subagent_progress", { payload: { percent: 20 } }));
  const result = parentResume.handle(makeEvent("subagent_failed", { payload: { status: "failed", error_code: "E_FAIL", error_message: "boom" } }));
  assert.equal(result.ack, true);
  assert.equal(result.next_state, "FAILED");
  assert.equal(result.resume_action, "resume_parent_with_failure");
  assert.equal(result.terminal, true);
});

test("VC-008 T5: ACKED → DONE on subagent_cancelled (cancel 不阻止 resume)", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  const result = parentResume.handle(makeEvent("subagent_cancelled", { payload: { reason: "user stopped" } }));
  assert.equal(result.ack, true);
  assert.equal(result.next_state, "DONE");
  assert.equal(result.resume_action, "resume_parent");
  assert.equal(result.terminal, true);
});

// ─── 2. Trigger events (5) ─────────────────────────────────────────────────

test("VC-008 E1: subagent_spawned transition produces RECEIVED state", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  const r = parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "plan", task_description: "t" } }));
  assert.equal(r.next_state, "RECEIVED");
  assert.equal(r.event_name, "subagent_spawned");
});

test("VC-008 E2: subagent_progress with ≥ 10% advance transitions to ACKED", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "plan", task_description: "t" } }));
  const r = parentResume.handle(makeEvent("subagent_progress", { payload: { percent: 50 } }));
  assert.equal(r.next_state, "ACKED");
  assert.equal(r.event_name, "subagent_progress");
});

test("VC-008 E3: subagent_completed transitions to DONE", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "plan", task_description: "t" } }));
  const r = parentResume.handle(makeEvent("subagent_completed", { payload: { status: "success", output_summary: "ok" } }));
  assert.equal(r.next_state, "DONE");
  assert.equal(r.event_name, "subagent_completed");
});

test("VC-008 E4: subagent_failed transitions to FAILED", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "plan", task_description: "t" } }));
  const r = parentResume.handle(makeEvent("subagent_failed", { payload: { status: "failed", error_code: "E_X", error_message: "x" } }));
  assert.equal(r.next_state, "FAILED");
  assert.equal(r.event_name, "subagent_failed");
});

test("VC-008 E5: subagent_cancelled transitions to DONE", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "plan", task_description: "t" } }));
  const r = parentResume.handle(makeEvent("subagent_cancelled", { payload: { reason: "r" } }));
  assert.equal(r.next_state, "DONE");
  assert.equal(r.event_name, "subagent_cancelled");
});

// ─── 3. Lease validation (2) ──────────────────────────────────────────────

test("VC-008 L1: valid lease passes (lease_check.active=true)", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  const r = parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  assert.equal(r.ack, true);
  assert.equal(r.lease_check.active, true);
});

test("VC-008 L2: invalid lease — 3 retry + escalation decision written", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeInactiveLeaseProvider());
  parentResume.setInboxWriteEnabled(false);

  // 3 consecutive handle calls on different event types (each increments retry).
  // First 2 should return ack=false (retry), 3rd should write escalation.
  const r1 = parentResume.handle(makeEvent("subagent_spawned", { subagentId: "sub-1", payload: { subagent_role: "explore", task_description: "t" } }));
  const r2 = parentResume.handle(makeEvent("subagent_progress", { subagentId: "sub-1", payload: { percent: 10 } }));
  const r3 = parentResume.handle(makeEvent("subagent_completed", { subagentId: "sub-1", payload: { status: "success", output_summary: "x" } }));

  assert.equal(r1.ack, false);
  assert.equal(r1.retry_count, 1);
  assert.equal(r2.ack, false);
  assert.equal(r2.retry_count, 2);
  assert.equal(r3.ack, false);
  assert.equal(r3.retry_count, 3);
  assert.equal(r3.next_state, "FAILED");
  assert.ok(r3.escalation);
  assert.ok(r3.escalation.decision_path);
  assert.ok(fs.existsSync(r3.escalation.decision_path));

  // Verify decision file shape
  const decision = JSON.parse(fs.readFileSync(r3.escalation.decision_path, "utf8"));
  assert.equal(decision.status, "open");
  assert.equal(decision.type, "parent_resume_escalation");
  assert.equal(decision.mission_id, "M-VC008");
  assert.equal(decision.subagent_id, "sub-1");
  assert.equal(decision.retry_count, 3);
});

// ─── 4. Mission validation (2) ─────────────────────────────────────────────

test("VC-008 M1: mission_id exists in .agent/missions/ — accepted", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  const r = parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  assert.equal(r.ack, true);
});

test("VC-008 M2: mission_id not in .agent/missions/ — rejected (security)", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  const r = parentResume.handle(makeEvent("subagent_spawned", { missionId: "M-NONEXISTENT-EVIL", payload: { subagent_role: "explore", task_description: "t" } }));
  assert.equal(r.ack, false);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /M-NONEXISTENT-EVIL.*not found/);
});

// ─── 5. P-003 integration (3) ─────────────────────────────────────────────

test("VC-008 P1: P-003 inbox write succeeds (mission present in .agent/missions/)", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  // Inbox write enabled (default) — verify it succeeds

  const r = parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  assert.equal(r.ack, true);
  assert.ok(r.inbox_write);
  assert.equal(r.inbox_write.ok, true);
  assert.ok(r.inbox_write.path);

  // Verify file exists on disk
  assert.ok(fs.existsSync(r.inbox_write.path));
  // Verify it's a valid bridge event
  const fileContent = JSON.parse(fs.readFileSync(r.inbox_write.path, "utf8"));
  assert.equal(fileContent.source_project_id, "M-VC008");
  assert.ok(fileContent.bridge_event_id);
});

test("VC-008 P2: P-003 subscriptions read — count surfaced in result", () => {
  const root = freshRoot();
  // Add a subscription entry to .agent-runtime/cross-project/subscriptions.json
  const crossDir = path.join(root, ".agent-runtime", "cross-project");
  fs.mkdirSync(crossDir, { recursive: true });
  fs.writeFileSync(
    path.join(crossDir, "subscriptions.json"),
    JSON.stringify({ subscriptions: [
      { source_project_id: "M-VC008", event_types: ["task.state_changed"] },
    ] }),
    "utf8",
  );
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  const r = parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  assert.equal(r.ack, true);
  assert.ok(r.p3_subscriptions);
  assert.equal(r.p3_subscriptions.count, 1);
  assert.equal(r.p3_subscriptions.matches, 1);
});

test("VC-008 P3: terminal state triggers bridge sync (mock)", () => {
  const root = freshRoot();
  parentResume.setRootDir(root);
  parentResume.setLeaseProvider(makeActiveLeaseProvider("M-VC008"));
  parentResume.setInboxWriteEnabled(false);

  let triggerCalled = null;
  parentResume.setBridgeSyncTrigger(function (args) {
    triggerCalled = args;
    return { ok: true, mocked: true, ...args };
  });

  parentResume.handle(makeEvent("subagent_spawned", { payload: { subagent_role: "explore", task_description: "t" } }));
  const r = parentResume.handle(makeEvent("subagent_completed", { payload: { status: "success", output_summary: "ok" } }));
  assert.equal(r.ack, true);
  assert.equal(r.next_state, "DONE");
  assert.ok(r.bridge_sync);
  assert.equal(r.bridge_sync.ok, true);
  assert.equal(r.bridge_sync.missionId, "M-VC008");
  assert.equal(r.bridge_sync.eventName, "subagent_completed");
  assert.ok(triggerCalled);
  assert.equal(triggerCalled.state, "DONE");
});
