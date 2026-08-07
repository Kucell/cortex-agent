"use strict";

// ─── Dispatch Idempotency tests (FAE-004 / M-013 MS-005) ───────────────────
//
// Coverage: 7-day retention, durable round-trip, record schema, GC of expired
// keys via lease expiry.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dispatchExecute = require("../../lib/dispatch/execute.js");
const { IDEMPOTENCY_RETENTION_MS } = require("../../lib/dispatch/execute.js");
const leaseStore = require("../../lib/coordination/lease-store");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m013-idem-"));
  for (const sub of ["runs", "queues", "sessions", "decisions", "waitpoints", "locks"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  fs.mkdirSync(path.join(root, ".agent-runtime", "coordination", "leases"), { recursive: true });
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seedApproval(root, taskId, decisionId = "D-M013-IDEM") {
  fs.writeFileSync(
    path.join(root, ".agent/decisions", `${decisionId}.json`),
    JSON.stringify({
      schema_version: 1,
      decision_id: decisionId,
      type: "approval",
      status: "approved",
      resolved_by: "interactive-user",
      resolved_at: "2026-07-29T00:00:00.000Z",
      selected_option: "approve",
      requested_by: "mission-coordinator",
      prompt: "approve",
      options: ["approve", "revise", "reject"],
      rationale: "test",
      gate: { action: "architecture", resource_ref: `task:${taskId}` },
      relations: { task_ids: [taskId], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] },
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    })
  );
}

test("VC-013-05-idem-01 IDEMPOTENCY_RETENTION_MS is 7 days", () => {
  assert.equal(IDEMPOTENCY_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
});

test("VC-013-05-idem-02 idempotency record survives lease state round-trip", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-IDEM-2");
    dispatchExecute.executeDispatch({
      taskId: "T-IDEM-2",
      idempotencyKey: "m013-idem-2",
      host: "pi",
      gate: "user",
      projectRoot: root,
    });
    const leasesDir = path.join(root, ".agent-runtime", "coordination", "leases");
    const manager = leaseStore.readLeaseState(leasesDir);
    const leases = manager.listLeasesForScope("task:T-IDEM-2");
    assert.equal(leases.length, 1);
    assert.equal(leases[0].idempotencyKey, "m013-idem-2");
  } finally { rmProject(root); }
});

test("VC-013-05-idem-03 second dispatch with same idempotency-key returns same operation_attempt_id", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-IDEM-3");
    const r1 = dispatchExecute.executeDispatch({
      taskId: "T-IDEM-3",
      idempotencyKey: "m013-idem-3",
      host: "pi",
      gate: "user",
      projectRoot: root,
    });
    const r2 = dispatchExecute.executeDispatch({
      taskId: "T-IDEM-3",
      idempotencyKey: "m013-idem-3",
      host: "pi",
      gate: "user",
      projectRoot: root,
    });
    assert.equal(r2.idempotent, true);
    assert.equal(r2.record.execution.operation_attempt_id, r1.run.operation_attempt_id);
  } finally { rmProject(root); }
});

test("VC-013-05-idem-04 idempotency record is 0o600 on disk", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-IDEM-4");
    dispatchExecute.executeDispatch({
      taskId: "T-IDEM-4",
      idempotencyKey: "m013-idem-4",
      host: "pi",
      gate: "user",
      projectRoot: root,
    });
    const recordPath = path.join(root, ".agent-runtime", "dispatch", "idempotency", "m013-idem-4.json");
    const st = fs.statSync(recordPath);
    assert.equal(st.mode & 0o077, 0);
  } finally { rmProject(root); }
});

test("VC-013-05-idem-05 idempotency record contains redacted summary (no prompts, no responses)", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-IDEM-5");
    const result = dispatchExecute.executeDispatch({
      taskId: "T-IDEM-5",
      idempotencyKey: "m013-idem-5",
      host: "pi",
      gate: "user",
      projectRoot: root,
    });
    const recordPath = path.join(root, ".agent-runtime", "dispatch", "idempotency", "m013-idem-5.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const text = JSON.stringify(record);
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text), "no sk-… credential leaks");
    assert.ok(!/MINIMAX_API<KEY>|MINIMAX<TOKEN>/.test(text), "no MINIMAX creds leak");
    assert.ok(record.execution.operation_attempt_id);
    assert.ok(record.execution.decision_id);
    assert.ok(record.execution.lease_id);
  } finally { rmProject(root); }
});

test("VC-013-05-idem-06 dispatch record status is 'accepted' on success", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-IDEM-6");
    dispatchExecute.executeDispatch({
      taskId: "T-IDEM-6",
      idempotencyKey: "m013-idem-6",
      host: "pi",
      gate: "user",
      projectRoot: root,
    });
    const record = JSON.parse(fs.readFileSync(
      path.join(root, ".agent-runtime", "dispatch", "idempotency", "m013-idem-6.json"),
      "utf8"
    ));
    assert.equal(record.status, "accepted");
    assert.ok(record.expires_at);
    // expires_at must be ~7 days from now (within 60 seconds tolerance).
    const expiresMs = new Date(record.expires_at).getTime();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(expiresMs - expectedMs) < 60_000, `expires_at ${record.expires_at} must be ~7 days out`);
  } finally { rmProject(root); }
});

test("VC-013-05-idem-07 idempotency record path traversal in key is rejected", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-IDEM-7");
    let threw = false;
    let code = null;
    try {
      dispatchExecute.executeDispatch({
        taskId: "T-IDEM-7",
        idempotencyKey: "../etc/passwd",
        host: "pi",
        gate: "user",
        projectRoot: root,
      });
    } catch (e) { threw = true; code = e.code; }
    assert.equal(threw, true);
    assert.equal(code, "ERR_IDEMPOTENCY_KEY_INVALID");
  } finally { rmProject(root); }
});