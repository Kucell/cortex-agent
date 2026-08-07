"use strict";

// ─── Capability-aware Manual Dispatch tests (MS-009 / P-004 / VC-009) ───────
//
// VC-009-01 (security): Manual dispatch revalidates revision, snapshot TTL,
// authorization, ownership, and lease before starting a new Operation attempt.
// VC-009-02 (test): Explicit dispatch succeeds only through existing owning
// services and remains idempotent.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  dispatch,
  revalidatePlan,
  isIdempotent,
  CapabilityAwareDispatchError,
  createAuthoritativeOwner,
} = require("../../lib/runtime-adapters/capability-aware-dispatch");

const NOW = "2026-07-28T12:00:00.000Z";

function requirement(overrides) {
  return Object.assign({
    schema_version: "1.0",
    requirement_id: "REQ-1",
    task_id: "T-1",
    created_at: "2026-07-28T11:00:00.000Z",
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: { approved_decision_id: "D-1", require_active_lease: false },
    preferred: {},
    ttl_at: "2026-07-28T13:00:00.000Z",
  }, overrides || {});
}

function snapshot(overrides) {
  return Object.assign({
    schema_version: "1.0",
    snapshot_id: "SNAP-A",
    host_profile_ref: "H-A",
    taken_at: "2026-07-28T11:55:00.000Z",
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
      "tool.update": "adapter",
    },
    governance: { approved: true, decision_id: "D-1" },
    lease: { active: true, holder: "owner-A" },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  }, overrides || {});
}

function ownerFactory(captured) {
  return function owner(request) {
    captured.push(request);
    return { operation_attempt_id: `OP-${captured.length}` };
  };
}

test("VC-009-01 manual dispatch revalidates and starts an Operation attempt via the owner", () => {
  const captured = [];
  const owner = ownerFactory(captured);
  const result = dispatch(requirement(), [snapshot()], owner, { now: NOW, ownerName: "ci-bot" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].host_profile_ref, "H-A");
  assert.equal(captured[0].issued_by, "ci-bot");
  assert.equal(captured[0].plan_id, result.plan_id);
  assert.equal(result.operation_attempt_id, "OP-1");
  assert.equal(result.idempotent, false);
  assert.equal(result.revalidation.revalidated, true);
  assert.ok(result.revalidation.plan_revision.length === 32);
});

test("VC-009-01 manual dispatch rejects the attempt when no candidate passes hard filters", () => {
  const owner = ownerFactory([]);
  const failing = snapshot({ capabilities: { "session.boundary": "native", "tool.before.block": "unsupported" } });
  assert.throws(
    () => dispatch(requirement(), [failing], owner, { now: NOW, ownerName: "ci-bot" }),
    (err) => err instanceof CapabilityAwareDispatchError && err.code === "ERR_NO_SELECTION"
  );
});

test("VC-009-01 manual dispatch revalidates and rejects when snapshot TTL has elapsed", () => {
  const owner = ownerFactory([]);
  const req = requirement({ ttl_at: "2026-07-28T11:30:00.000Z" });
  const snap = snapshot({ taken_at: "2026-07-28T06:00:00.000Z" });
  assert.throws(
    () => dispatch(req, [snap], owner, { now: NOW }),
    (err) => err instanceof CapabilityAwareDispatchError && err.code === "ERR_NO_SELECTION"
  );
});

test("VC-009-01 manual dispatch revalidates governance decision mismatch", () => {
  const owner = ownerFactory([]);
  const snap = snapshot({ governance: { approved: true, decision_id: "D-OTHER" } });
  assert.throws(
    () => dispatch(requirement(), [snap], owner, { now: NOW }),
    (err) => err instanceof CapabilityAwareDispatchError && err.code === "ERR_NO_SELECTION"
  );
});

test("VC-009-01 manual dispatch revalidates missing lease when required", () => {
  const owner = ownerFactory([]);
  const req = requirement({ governance: { approved_decision_id: "D-1", require_active_lease: true } });
  const snap = snapshot({ lease: { active: false, holder: null } });
  assert.throws(
    () => dispatch(req, [snap], owner, { now: NOW }),
    (err) => err instanceof CapabilityAwareDispatchError && err.code === "ERR_NO_SELECTION"
  );
});

test("VC-009-02 explicit dispatch remains idempotent across replays", () => {
  const captured = [];
  const owner = ownerFactory(captured);
  const opts = { now: NOW, ownerName: "ci-bot", idempotencyState: new Map() };
  const first = dispatch(requirement(), [snapshot()], owner, opts);
  const second = dispatch(requirement(), [snapshot()], owner, opts);
  assert.equal(captured.length, 1, "owner should be called once across two dispatches");
  assert.equal(first.operation_attempt_id, second.operation_attempt_id);
  assert.equal(second.idempotent, true);
  assert.ok(isIdempotent(second));
});

test("VC-009-02 dispatch rejects when owner returns a malformed response", () => {
  const badOwner = () => ({ not: "valid" });
  assert.throws(
    () => dispatch(requirement(), [snapshot()], badOwner, { now: NOW }),
    (err) => err instanceof CapabilityAwareDispatchError && err.code === "ERR_OWNER_INVALID_RESPONSE"
  );
});

test("VC-009-02 dispatch rejects when the owner throws", () => {
  const failingOwner = () => { throw new Error("downstream unavailable"); };
  assert.throws(
    () => dispatch(requirement(), [snapshot()], failingOwner, { now: NOW }),
    (err) => err instanceof CapabilityAwareDispatchError && err.code === "ERR_OWNER_REJECTED"
  );
});

test("VC-009-02 dispatch requires an owner function and options.now", () => {
  assert.throws(
    () => dispatch(requirement(), [snapshot()], null, { now: NOW }),
    (err) => err.code === "ERR_OWNER_REQUIRED"
  );
  assert.throws(
    () => dispatch(requirement(), [snapshot()], () => ({ operation_attempt_id: "OP-1" }), { ownerName: "ci-bot" }),
    (err) => err.code === "ERR_OPTIONS_NOW_REQUIRED"
  );
});

test("VC-009-02 revalidatePlan exposes the deterministic plan before the owner is called", () => {
  const plan = revalidatePlan(requirement(), [snapshot()], { now: NOW });
  assert.equal(plan.selection, "H-A");
  assert.ok(plan.plan_id.startsWith("P-REQ-1-"));
});

test("VC-009-02 authoritative owner creates a durable authorized Operation attempt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-dispatch-owner-"));
  const actor = { workflow: "/mission", agent_id: "pi-agent", task_id: "T-1", mission_id: "M-010", run_id: "R-M-010", session_id: "S-M-010", workspace_id: "W-PILOT" };
  const readiness = {
    schema_version: "1.0", readiness_id: "RD-PILOT", revision: "REV-1", verdict: "ready",
    operation: { kind: "manual_dispatch" }, resolved: {}, decisions_required: [], warnings: [], blocked_by: [], next_actions: [], inspected_at: NOW,
  };
  const authorization = {
    schema_version: "1.0", authorization_id: "AUTH-PILOT", decision_id: "D-1", decision_source: "management-api",
    policy: "frozen-revision", reason: "approved pilot", scope: { repository: "cortex-agent", revision: "REV-1" }, validity: { mode: "single" },
    child_inheritance: false, consumed_operation_ids: [], revoked_at: null, expires_at: null, created_at: NOW, revision: "AUTH-REV-1",
  };
  const owner = createAuthoritativeOwner({ root, operationId: "OP-DISPATCH-1", taskId: "T-1", runId: "R-M-010", sessionId: "S-M-010", workspaceId: "W-PILOT", actor, authorization, readiness, targetRevision: "REV-1" });
  const result = dispatch(requirement({ governance: { approved_decision_id: "D-1", require_active_lease: true } }), [snapshot()], owner, { now: NOW, ownerName: "operation-lifecycle" });
  assert.equal(result.operation_attempt_id, "OP-DISPATCH-1:1");
  const durable = JSON.parse(fs.readFileSync(path.join(root, ".agent", "operations", "OP-DISPATCH-1.json"), "utf8"));
  assert.equal(durable.status, "authorized");
  assert.equal(durable.relations.run_id, "R-M-010");
  assert.equal(durable.authorization_ref, "AUTH-PILOT");
  assert.equal(fs.readFileSync(path.join(root, ".agent", "operations", "events.jsonl"), "utf8").trim().split("\n").length, 3);
});

test("VC-009-02 authoritative owner fails closed for consumed authorization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-dispatch-owner-deny-"));
  const owner = createAuthoritativeOwner({ root, operationId: "OP-DISPATCH-2", taskId: "T-1", runId: "R-1", sessionId: "S-1", workspaceId: "W-1", actor: { workflow: "/mission", agent_id: "pi-agent" }, targetRevision: "REV-1", readiness: { readiness_id: "RD-1" }, authorization: { authorization_id: "AUTH-1", validity: { mode: "single" }, consumed_operation_ids: ["OP-OTHER"], scope: { revision: "REV-1", repository: "cortex-agent" }, revoked_at: null, expires_at: null } });
  assert.throws(() => dispatch(requirement(), [snapshot()], owner, { now: NOW }), (error) => error.code === "ERR_OWNER_REJECTED");
  assert.equal(fs.existsSync(path.join(root, ".agent", "operations", "OP-DISPATCH-2.json")), false);
});

test("VC-009-02 dispatch issues a unique plan_id when TTL changes between calls", () => {
  const owner = ownerFactory([]);
  const opts1 = { now: NOW, ownerName: "ci-bot", idempotencyState: new Map() };
  const opts2 = { now: NOW, ownerName: "ci-bot", idempotencyState: new Map() };
  const a = dispatch(requirement(), [snapshot()], owner, opts1);
  const b = dispatch(requirement({ ttl_at: "2026-07-28T14:00:00.000Z" }), [snapshot()], owner, opts2);
  assert.notEqual(a.plan_id, b.plan_id);
});

test("VC-009-02 automatic dispatch and daemon are explicitly disabled and never flipped on by the module", () => {
  const { AUTOMATIC_DISPATCH_ENABLED, DAEMON_ENABLED } = require("../../lib/runtime-adapters/capability-aware-dispatch");
  assert.equal(AUTOMATIC_DISPATCH_ENABLED, false);
  assert.equal(DAEMON_ENABLED, false);
});

test("VC-009-02 dispatch is idempotent across a process restart via the durable operations directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-dispatch-durable-"));
  const actor = { workflow: "/mission", agent_id: "pi-agent", task_id: "T-1", mission_id: "M-010", run_id: "R-M-010", session_id: "S-M-010", workspace_id: "W-PILOT" };
  const readiness = { schema_version: "1.0", readiness_id: "RD-DURABLE", revision: "REV-1", verdict: "ready", operation: { kind: "manual_dispatch" }, resolved: {}, decisions_required: [], warnings: [], blocked_by: [], next_actions: [], inspected_at: NOW };
  const authorization = { schema_version: "1.0", authorization_id: "AUTH-DURABLE", decision_id: "D-1", decision_source: "management-api", policy: "frozen-revision", reason: "durable test", scope: { repository: "cortex-agent", revision: "REV-1" }, validity: { mode: "single" }, child_inheritance: false, consumed_operation_ids: [], revoked_at: null, expires_at: null, created_at: NOW, revision: "AUTH-DURABLE-REV" };
  const owner = createAuthoritativeOwner({ root, operationId: "OP-DURABLE-1", taskId: "T-1", runId: "R-M-010", sessionId: "S-M-010", workspaceId: "W-PILOT", actor, authorization, readiness, targetRevision: "REV-1" });
  const first = dispatch(requirement(), [snapshot()], owner, { now: NOW, ownerName: "operation-lifecycle", root });
  assert.equal(first.idempotent, false);
  assert.equal(first.idempotency_source, "new");
  // Simulate process restart: a fresh idempotencyState, same root, fresh owner
  // capture so we can prove the owner is NOT called on a durable hit.
  const calls = [];
  const restartOwner = (request) => { calls.push(request); throw new Error("owner must not be called on durable hit"); };
  const second = dispatch(requirement(), [snapshot()], restartOwner, { now: NOW, ownerName: "operation-lifecycle", root, idempotencyState: new Map() });
  assert.equal(second.idempotent, true);
  assert.equal(second.idempotency_source, "durable");
  assert.equal(second.operation_attempt_id, first.operation_attempt_id);
  assert.equal(calls.length, 0, "owner must not be called when a durable attempt already exists");
});