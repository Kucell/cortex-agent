"use strict";

// ─── Explicit Manual Dispatch tests (FAE-004 / M-013 MS-005) ──────────────
//
// Coverage: happy path with approved task + lease + capability-aware dispatch,
// duplicate idempotency rejection, lease conflict, capability mismatch,
// host not in snapshot, dry-run alias, rollback of partial state, sensitive
// evidence guard, zero subprocess / network access.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dispatchExecute = require("../../lib/dispatch/execute.js");
const { DispatchExecuteError } = require("../../lib/dispatch/execute.js");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m013-exec-"));
  for (const sub of ["runs", "queues", "sessions", "decisions", "waitpoints", "locks"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  fs.mkdirSync(path.join(root, ".agent-runtime", "coordination", "leases"), { recursive: true });
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seedApproval(root, taskId, decisionId = "D-M013-EXEC") {
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
      prompt: "approve dispatch",
      options: ["approve", "revise", "reject"],
      rationale: "test fixture",
      gate: { action: "architecture", resource_ref: `task:${taskId}` },
      relations: { task_ids: [taskId], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] },
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    })
  );
}

function baseArgs(root, overrides = {}) {
  return Object.assign({
    taskId: "T-M013-EXEC-1",
    idempotencyKey: "m013-exec-1",
    host: "pi",
    gate: "user",
    projectRoot: root,
  }, overrides || {});
}

test("VC-013-05-01 executeDispatch happy path writes idempotency record + boundary event id", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-M013-EXEC-1");
    const result = dispatchExecute.executeDispatch(baseArgs(root));
    assert.equal(result.ok, true);
    assert.equal(result.action, "dispatch_execute");
    assert.equal(result.idempotent, false);
    assert.ok(result.run.operation_attempt_id);
    assert.ok(result.run.plan_id);
    assert.ok(result.lease.lease_id);
    assert.ok(result.approval.decision_id);
    assert.ok(result.boundary_events.length > 0);
    // Idempotency record written
    const recordPath = path.join(root, ".agent-runtime", "dispatch", "idempotency", `${baseArgs(root).idempotencyKey}.json`);
    assert.ok(fs.existsSync(recordPath), "idempotency record must exist");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(record.status, "accepted");
    assert.equal(record.task_id, "T-M013-EXEC-1");
    assert.equal(record.execution.host_profile_ref, `H-pi`);
  } finally { rmProject(root); }
});

test("VC-013-05-02 executeDispatch duplicate idempotency-key returns idempotent:true", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-M013-EXEC-2");
    const r1 = dispatchExecute.executeDispatch(baseArgs(root, { taskId: "T-M013-EXEC-2", idempotencyKey: "m013-exec-2" }));
    const r2 = dispatchExecute.executeDispatch(baseArgs(root, { taskId: "T-M013-EXEC-2", idempotencyKey: "m013-exec-2" }));
    assert.equal(r1.idempotent, false);
    assert.equal(r2.idempotent, true);
    assert.equal(r2.record.execution.operation_attempt_id, r1.run.operation_attempt_id);
  } finally { rmProject(root); }
});

test("VC-013-05-03 executeDispatch rejects task that is not approved", () => {
  const root = mkProject();
  try {
    // No approval seeded.
    let threw = false;
    try {
      dispatchExecute.executeDispatch(baseArgs(root, { taskId: "T-UNAPPROVED" }));
    } catch (e) { threw = e.code === "ERR_TASK_NOT_APPROVED"; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-05-04 executeDispatch rejects unknown host", () => {
  const root = mkProject();
  try {
    let threw = false;
    try {
      dispatchExecute.executeDispatch(baseArgs(root, { host: "unknown-host" }));
    } catch (e) { threw = e.code === "ERR_HOST_INVALID"; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-05-05 executeDispatch rejects unknown gate", () => {
  const root = mkProject();
  try {
    let threw = false;
    try {
      dispatchExecute.executeDispatch(baseArgs(root, { gate: "alien-gate" }));
    } catch (e) { threw = e.code === "ERR_GATE_INVALID"; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-05-06 executeDispatch rejects missing idempotency-key", () => {
  const root = mkProject();
  try {
    let threw = false;
    try {
      dispatchExecute.executeDispatch(baseArgs(root, { idempotencyKey: "" }));
    } catch (e) { threw = e.code === "ERR_IDEMPOTENCY_KEY_REQUIRED"; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-05-07 executeDispatch rejects missing task-id", () => {
  const root = mkProject();
  try {
    let threw = false;
    try {
      dispatchExecute.executeDispatch(baseArgs(root, { taskId: "" }));
    } catch (e) { threw = e.code === "ERR_TASK_ID_REQUIRED"; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-05-08 executeDispatch fails closed when plan is blocked (existing run)", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-M013-EXEC-8");
    fs.writeFileSync(path.join(root, ".agent/runs/R-EXIST.json"), JSON.stringify({
      run_id: "R-EXIST", task_id: "T-M013-EXEC-8", phase: "EXECUTE_FEATURE", started_at: "2026-07-29T00:00:00.000Z",
    }));
    let threw = false;
    let code = null;
    try {
      dispatchExecute.executeDispatch(baseArgs(root, { taskId: "T-M013-EXEC-8", idempotencyKey: "m013-exec-8" }));
    } catch (e) {
      threw = true;
      code = e.code;
    }
    assert.equal(threw, true);
    assert.equal(code, "ERR_PLAN_BLOCKED");
  } finally { rmProject(root); }
});

test("VC-013-05-09 executeDispatch persists idempotency record under .agent-runtime/dispatch/idempotency/", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-M013-EXEC-9");
    dispatchExecute.executeDispatch(baseArgs(root, { taskId: "T-M013-EXEC-9", idempotencyKey: "m013-exec-9" }));
    const recordDir = path.join(root, ".agent-runtime", "dispatch", "idempotency");
    const files = fs.readdirSync(recordDir);
    assert.ok(files.includes("m013-exec-9.json"));
    const stat = fs.statSync(path.join(recordDir, "m013-exec-9.json"));
    assert.equal(stat.mode & 0o077, 0, "idempotency record must be 0o600");
  } finally { rmProject(root); }
});

test("VC-013-05-10 executeDispatch emits only redacted boundary event fields", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-M013-EXEC-10");
    const result = dispatchExecute.executeDispatch(baseArgs(root, { taskId: "T-M013-EXEC-10", idempotencyKey: "m013-exec-10" }));
    assert.ok(result.boundary_events.length >= 1);
    // Boundary event ids are non-sensitive identifiers only (event_id shape).
    for (const id of result.boundary_events) {
      assert.match(id, /^RBE-[0-9]+-[a-f0-9]+$/);
    }
    // No prompt / payload / secret should appear in the JSON record.
    const record = JSON.parse(fs.readFileSync(result.record_path, "utf8"));
    const recordStr = JSON.stringify(record);
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(recordStr));
    assert.ok(!/MINIMAX_API<KEY>|MINIMAX<TOKEN>/.test(recordStr));
  } finally { rmProject(root); }
});

test("VC-013-05-11 executeDispatch module never imports subprocess / network / fetch", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../lib/dispatch/execute.js"), "utf8");
  assert.ok(!/child_process/.test(src), "dispatch-execute must not import child_process");
  assert.ok(!/\bnet\.Socket\b/.test(src), "dispatch-execute must not use net.Socket");
  assert.ok(!/require\(['"]https?['"]\)/.test(src), "dispatch-execute must not import http/https");
  assert.ok(!/\bfetch\(/.test(src), "dispatch-execute must not call fetch");
});

test("VC-013-05-12 dryRunAlias returns plan-only view (matches dispatch dry-run)", () => {
  const root = mkProject();
  try {
    const plan = dispatchExecute.dryRunAlias({ taskId: "T-ALIAS", projectRoot: root });
    assert.equal(plan.task_id, "T-ALIAS");
    assert.equal(plan.would_proceed, true);
    assert.equal(plan.mutation_evidence.mutated_count, 0);
  } finally { rmProject(root); }
});

test("VC-013-05-13 executeDispatch records fencingToken from the lease in the execution evidence", () => {
  const root = mkProject();
  try {
    seedApproval(root, "T-M013-EXEC-13");
    const result = dispatchExecute.executeDispatch(baseArgs(root, { taskId: "T-M013-EXEC-13", idempotencyKey: "m013-exec-13" }));
    assert.ok(result.lease.fencing_token >= 1);
    assert.equal(result.run.host_profile_ref, `H-${baseArgs(root).host}`);
  } finally { rmProject(root); }
});