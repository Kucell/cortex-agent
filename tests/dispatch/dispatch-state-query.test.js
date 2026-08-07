"use strict";

// ─── Read-only Dispatch State Query tests (FAE-002 / M-013 MS-003) ────────
//
// Coverage: empty-state and populated-state shape parity, runs / queues /
// sessions / decisions / waitpoints composition, dispatch-plan 5 fields,
// query triggers empty, no mutation primitives, deterministic.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dispatchState = require("../../lib/coordination/dispatch-state");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m013-state-"));
  for (const sub of ["runs", "queues", "sessions", "decisions", "waitpoints", "locks"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

test("VC-013-03-01 dispatch-state returns stable shape even when .agent/ is empty", () => {
  const root = mkProject();
  try {
    const env = dispatchState.queryDispatchState(root);
    assert.equal(env._meta.schema_version, 1);
    assert.equal(env.summary.dispatch_status, "not_started");
    assert.equal(env.summary.active_dispatches, 0);
    assert.deepEqual(env.active, []);
    assert.deepEqual(env.queued, []);
    assert.deepEqual(env.blocked, { by_decision: [], by_waitpoint: [] });
    assert.deepEqual(env.stale_sessions, []);
    assert.deepEqual(env.recent_history, []);
    assert.equal(typeof env.next_action, "string");
    assert.ok(env.next_action.length > 0);
  } finally { rmProject(root); }
});

test("VC-013-03-02 dispatch-state aggregates active runs", () => {
  const root = mkProject();
  try {
    const future = "2026-07-29T12:00:00.000Z";
    writeJson(path.join(root, ".agent/runs/R-A.json"), {
      run_id: "R-A", task_id: "T-A", phase: "EXECUTE_FEATURE", started_at: future, status: "active",
    });
    writeJson(path.join(root, ".agent/runs/R-B.json"), {
      run_id: "R-B", task_id: "T-B", phase: "EXECUTE_FEATURE", completed_at: future, status: "completed",
    });
    const env = dispatchState.queryDispatchState(root);
    assert.equal(env.summary.active_dispatches, 1);
    assert.equal(env.active.length, 1);
    assert.equal(env.active[0].run_id, "R-A");
    assert.equal(env.summary.dispatch_status, "active");
    assert.equal(env.recent_history.length, 1);
    assert.equal(env.recent_history[0].run_id, "R-B");
  } finally { rmProject(root); }
});

test("VC-013-03-03 dispatch-state counts queued + blocked + stale", () => {
  const root = mkProject();
  try {
    writeJson(path.join(root, ".agent/queues/Q1.json"), {
      queue_id: "Q1", items: [{ task_id: "T-X", status: "queued" }],
    });
    writeJson(path.join(root, ".agent/decisions/D-1.json"), {
      decision_id: "D-1", status: "open", relations: { task_ids: ["T-Y"] },
    });
    writeJson(path.join(root, ".agent/waitpoints/WP-1.json"), {
      waitpoint_id: "WP-1", status: "pending", relations: { task_ids: ["T-Z"] },
    });
    // Stale session: last heartbeat > 5 minutes ago.
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeJson(path.join(root, ".agent/sessions/S1.json"), {
      session_id: "S1", status: "open", last_heartbeat_at: staleTime,
    });
    const env = dispatchState.queryDispatchState(root);
    assert.equal(env.summary.queued_tasks, 1);
    assert.equal(env.summary.blocked_by_decision, 1);
    assert.equal(env.summary.blocked_by_waitpoint, 1);
    assert.equal(env.summary.stale_sessions, 1);
    assert.equal(env.queued[0].queue_id, "Q1");
    assert.equal(env.blocked.by_decision[0].decision_id, "D-1");
    assert.equal(env.blocked.by_waitpoint[0].waitpoint_id, "WP-1");
    assert.equal(env.stale_sessions[0].session_id, "S1");
  } finally { rmProject(root); }
});

test("VC-013-03-04 triggers projection is read-only and always empty in Phase 0", () => {
  const root = mkProject();
  try {
    const env = dispatchState.queryTriggers(root);
    assert.equal(env._meta.schema_version, 1);
    assert.equal(env.summary.total, 0);
    assert.equal(env.summary.by_type.manual, 0);
    assert.equal(env.triggers.length, 0);
  } finally { rmProject(root); }
});

test("VC-013-03-05 dispatch-plan returns 5+ fields for an unknown task", () => {
  const root = mkProject();
  try {
    const plan = dispatchState.queryDispatchPlan(root, "T-DEMO");
    assert.equal(plan.task_id, "T-DEMO");
    assert.equal(typeof plan.would_proceed, "boolean");
    assert.ok(plan.idempotency);
    assert.ok(plan.concurrency);
    assert.ok(plan.locks);
    assert.ok(plan.worktree);
    assert.ok(Array.isArray(plan.required_gates));
    assert.ok(Array.isArray(plan.warnings));
    assert.ok(Array.isArray(plan.errors));
  } finally { rmProject(root); }
});

test("VC-013-03-06 dispatch-plan marks would_duplicate when a run already exists", () => {
  const root = mkProject();
  try {
    writeJson(path.join(root, ".agent/runs/R-1.json"), {
      run_id: "R-1", task_id: "T-EXISTING", phase: "EXECUTE_FEATURE", started_at: "2026-07-29T12:00:00.000Z",
    });
    const plan = dispatchState.queryDispatchPlan(root, "T-EXISTING");
    assert.equal(plan.idempotency.existing_run_id, "R-1");
    assert.equal(plan.idempotency.would_duplicate, true);
    assert.equal(plan.would_proceed, false);
    assert.ok(plan.warnings.length > 0);
  } finally { rmProject(root); }
});

test("VC-013-03-07 dispatch-plan surfaces conflicts in .agent/locks/", () => {
  const root = mkProject();
  try {
    fs.writeFileSync(path.join(root, ".agent/locks/task-T-CONFLICT.json"), "{\"lock\":true}");
    const plan = dispatchState.queryDispatchPlan(root, "T-CONFLICT");
    assert.ok(plan.locks.would_conflict_with.length >= 1);
    assert.equal(plan.would_proceed, false);
    assert.ok(plan.errors.length > 0);
  } finally { rmProject(root); }
});

test("VC-013-03-08 dispatch-plan requires taskId argument", () => {
  const root = mkProject();
  try {
    let threw = false;
    try { dispatchState.queryDispatchPlan(root, ""); } catch (e) { threw = true; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-03-09 dispatch-state module is read-only (no fs write or mutation verbs)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/coordination/dispatch-state.js"), "utf8");
  // No writeFileSync / rename / appendFile
  assert.ok(!/fs\.(writeFile|appendFile|rename|chmod|chown|unlink|rm|rmdir)/.test(src), "dispatch-state must not write to disk");
  // No mutation verbs leak through schema
  assert.ok(!/"runs upsert"|"queues upsert"|"decisions resolve"|"inbox send"/.test(src), "schema must forbid mutation primitives");
});

test("VC-013-03-10 query dispatch-state is queryable via management-api index.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "../.agent/skills/management-api/scripts/index.js"), "utf8");
  assert.ok(src.includes('"dispatch-state"'), "management-api must register dispatch-state");
  assert.ok(src.includes('"dispatch-plan"'), "management-api must register dispatch-plan");
  assert.ok(src.includes('triggers'), "management-api must register triggers");
});