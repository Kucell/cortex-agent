"use strict";

// ─── Reusable Dispatch Plan Resolver tests (FAE-003 / M-013 MS-004) ──────
//
// Coverage: pure resolver, idempotency, lock conflict, lease conflict,
// would_proceed decision, snapshot composition, mutation evidence.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dispatchPlan = require("../../lib/dispatch/plan.js");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m013-plan-"));
  for (const sub of ["runs", "queues", "sessions", "decisions", "waitpoints", "locks"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

test("VC-013-04-01 resolveDispatchPlan returns well-formed plan for unknown task", () => {
  const root = mkProject();
  try {
    const plan = dispatchPlan.resolveDispatchPlan(root, "T-PLAN-1");
    assert.equal(plan.task_id, "T-PLAN-1");
    assert.equal(plan.would_proceed, true);
    assert.equal(plan.idempotency.would_duplicate, false);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.warnings.length, 0);
    assert.ok(plan.worktree.would_create.endsWith("T-PLAN-1"));
    assert.ok(plan.next_run_event);
  } finally { rmProject(root); }
});

test("VC-013-04-02 resolveDispatchPlan would_duplicate true when run exists", () => {
  const root = mkProject();
  try {
    fs.writeFileSync(
      path.join(root, ".agent/runs/R-EXISTING.json"),
      JSON.stringify({ run_id: "R-EXISTING", task_id: "T-EXIST", phase: "EXECUTE_FEATURE", started_at: "2026-07-29T12:00:00.000Z" })
    );
    const plan = dispatchPlan.resolveDispatchPlan(root, "T-EXIST");
    assert.equal(plan.idempotency.existing_run_id, "R-EXISTING");
    assert.equal(plan.idempotency.would_duplicate, true);
    assert.equal(plan.would_proceed, false);
    assert.ok(plan.warnings.length > 0);
  } finally { rmProject(root); }
});

test("VC-013-04-03 resolveDispatchPlan surfaces lock conflict", () => {
  const root = mkProject();
  try {
    fs.writeFileSync(path.join(root, ".agent/locks/task-T-LOCK.json"), "{\"lock\":true}");
    const plan = dispatchPlan.resolveDispatchPlan(root, "T-LOCK");
    assert.ok(plan.locks.would_conflict_with.length >= 1);
    assert.equal(plan.would_proceed, false);
    assert.ok(plan.errors.length > 0);
  } finally { rmProject(root); }
});

test("VC-013-04-04 resolveDispatchPlan surfaces lease conflict from .agent-runtime/coordination/leases", () => {
  const root = mkProject();
  try {
    const leasesDir = path.join(root, ".agent-runtime", "coordination", "leases");
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(path.join(leasesDir, "state.json"), JSON.stringify({
      version: 1,
      leases: [{
        leaseId: "LEASE-1",
        scope: "task:T-LEASE",
        owner: "agent-pi",
        actorId: "agent-pi",
        fencingToken: 1,
        acquiredAt: "2026-07-29T12:00:00.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z",
        releasedAt: null,
        staleAt: null,
        takeover: false,
        recoveredFrom: null,
        idempotencyKey: null,
      }],
      fencing: { "task:T-LEASE": 1 },
      takeovers: [],
      audit: [],
      counters: { lease: 1, audit: 0, takeover: 0 },
    }));
    const plan = dispatchPlan.resolveDispatchPlan(root, "T-LEASE");
    assert.ok(plan.locks.active_leases.length >= 1);
    assert.equal(plan.would_proceed, false);
    assert.ok(plan.errors.some((e) => /lease|task:T-LEASE/.test(e)));
  } finally { rmProject(root); }
});

test("VC-013-04-05 resolveDispatchPlan captures mutation evidence (zero mutation on success)", () => {
  const root = mkProject();
  try {
    const plan = dispatchPlan.resolveDispatchPlan(root, "T-ZMUT");
    assert.equal(plan.mutation_evidence.mutated_count, 0);
    assert.deepEqual(plan.mutation_evidence.mutated_files, []);
  } finally { rmProject(root); }
});

test("VC-013-04-06 resolveDispatchPlan rejects missing taskId", () => {
  const root = mkProject();
  try {
    let threw = false;
    try { dispatchPlan.resolveDispatchPlan(root, ""); } catch (e) { threw = e.code === "ERR_TASK_ID_REQUIRED"; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-04-07 resolveDispatchPlan composes capability-aware matcher snapshot", () => {
  const root = mkProject();
  try {
    const plan = dispatchPlan.resolveDispatchPlan(root, "T-MATCH");
    assert.ok(plan.snapshot);
    assert.ok(typeof plan.snapshot.plan_revision === "string");
    assert.ok(plan.snapshot.plan_revision.length > 0);
    assert.ok(Array.isArray(plan.snapshot.candidates));
  } finally { rmProject(root); }
});

test("VC-013-04-08 dispatch-plan module is pure (no fs write or subprocess)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../lib/dispatch/plan.js"), "utf8");
  // Note: fs.readFileSync IS allowed (read-only). writeFile/appendFile/rename are not.
  assert.ok(!/fs\.(writeFile|appendFile|rename|chmod|chown|unlink|rm|rmdir)/.test(src), "dispatch-plan must not write to disk");
  assert.ok(!/child_process/.test(src), "dispatch-plan must not import child_process");
  assert.ok(!/\bnet\.Socket\b/.test(src), "dispatch-plan must not use net.Socket");
});