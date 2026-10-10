"use strict";

// ISOLATED SCRATCH TESTS: fixture-only, not project CI / G0 / AUTH E2E.
const assert = require("node:assert/strict");
const test = require("node:test");
const { validateL3Authorization, validateL3CachedReturn } = require("../../lib/dispatch/l3-authorization.js");

const NOW = "2026-10-09T06:00:00.000Z";
const REV = { store_kind: "git", value: "b".repeat(40) };
const DIGEST = "sha256:" + "a".repeat(64);
const RESOURCE = "mission:M-001@" + DIGEST;

function valid() {
  const project = "project:scratch";
  const mission = "mission:M-001";
  const task = "task:T-001";
  const owner = "owner:coordinator";
  const approval = {
    project_ref: project, mission_ref: mission, task_refs: [task],
    plan_digest: DIGEST, plan_revision: "plan-r1", governance_revision: structuredClone(REV),
    owner_ref: owner, repository_ref: "repository:cortex-agent", branch_ref: "feat/l3-scratch",
    allowed_paths: ["lib/dispatch/**"], allowed_operations: ["implement", "test"],
    host_ref: "host:scratch", budget: {
      max_attempts: 2, max_tokens: 10000, max_wall_minutes: 30, max_cost_usd: 2,
    },
    valid_from: "2026-10-09T04:00:00.000Z", expires_at: "2026-10-09T08:00:00.000Z",
    risk_limit: "medium",
  };
  const request = {
    project_ref: project, binding_ref: "governance:bound-repo", mission_ref: mission,
    task_ref: task, decision_id: "D-SCRATCH-1", waitpoint_id: "WP-SCRATCH-1",
    plan_digest: DIGEST, plan_revision: "plan-r1", governance_revision: structuredClone(REV),
    owner_ref: owner, action: "external_side_effect", resource_ref: RESOURCE,
    repository_ref: "repository:cortex-agent", branch_ref: "feat/l3-scratch",
    relative_path: "lib/dispatch/l3-authorization.js", host_ref: "host:scratch",
    operation: "implement", risk_tier: "medium", lease_ref: "lease:scoped",
    fencing_epoch: 10, idempotency_key: "one-task-only",
    usage: { attempt: 1, tokens: 100, wall_minutes: 1, cost_usd: 0.01 },
  };
  const snapshot = {
    provenance: {
      source_type: "canonical_governance_fixture", project_ref: project,
      binding_ref: "governance:bound-repo", governance_revision: structuredClone(REV),
      observed_at: "2026-10-09T05:59:30.000Z",
    },
    project: { project_ref: project, binding_ref: "governance:bound-repo", owner_ref: owner },
    mission: {
      mission_ref: mission, project_ref: project, owner_ref: owner, plan_digest: DIGEST,
      plan_revision: "plan-r1", task_refs: [task], owner_workflow: "/mission", workflow_actor_ref: "mission-coordinator",
    },
    task: {
      task_ref: task, mission_ref: mission, project_ref: project,
      plan_digest: DIGEST, plan_revision: "plan-r1", dependencies_accepted: true, risk_tier: "medium",
    },
    decision: {
      decision_id: "D-SCRATCH-1", status: "approved", selected_option: "approve",
      resolved_by: "interactive-user", resolved_at: "2026-10-09T05:00:00.000Z",
      revoked_at: null, expires_at: "2026-10-09T08:00:00.000Z",
      gate: { action: "external_side_effect", resource_ref: RESOURCE },
      relations: { task_ids: [task], mission_ids: [mission] }, approved_scope: approval,
    },
    waitpoint: {
      waitpoint_id: "WP-SCRATCH-1", status: "released", decision_id: "D-SCRATCH-1",
      owner_workflow: "/mission", released_by: "mission-coordinator",
      released_at: "2026-10-09T05:01:00.000Z", expires_at: null, revoked_at: null,
      gate: { action: "external_side_effect", resource_ref: RESOURCE },
      relations: { task_ids: [task], mission_ids: [mission] },
    },
    ownership: {
      owner_ref: owner, lease_ref: "lease:scoped", fencing_epoch: 10,
      active: true, expires_at: "2026-10-09T06:30:00.000Z",
    },
  };
  return { snapshot, request, now_iso: NOW };
}

function denial(label, mutation, expectedCode) {
  test(label, () => {
    const input = valid();
    mutation(input);
    const v = validateL3Authorization(input);
    assert.equal(v.status, "BLOCKED");
    assert.equal(v.matched, false);
    assert.equal(v.execution_authorized, false);
    assert.equal(v.effect_permitted, false);
    if (expectedCode) assert.equal(v.code, expectedCode);
  });
}

test("scratch baseline: matched fixture cannot grant authorization or effect", () => {
  const v = validateL3Authorization(valid());
  assert.equal(v.matched, true);
  assert.equal(v.status, "SCOPE_MATCHED_FIXTURE_ONLY");
  assert.equal(v.execution_authorized, false);
  assert.equal(v.effect_permitted, false);
  assert.equal(Object.isFrozen(v), true);
  assert.ok(v.pending_real_gates.includes("fence_at_effect_sink"));
});

// AUTH-01: no implicit `resolved`/`closed` acceptance or missing pair.
denial("AUTH-01 empty injected Decision", (x) => { x.snapshot.decision = null; }, "ERR_L3_DECISION_NOT_APPROVED");
denial("AUTH-01 absent explicit decision ID", (x) => { x.request.decision_id = ""; }, "ERR_L3_DECISION_NOT_APPROVED");
denial("AUTH-01 missing Waitpoint", (x) => { x.snapshot.waitpoint = null; }, "ERR_L3_WAITPOINT_NOT_RELEASED");
denial("AUTH-01 missing Waitpoint ID", (x) => { x.request.waitpoint_id = ""; }, "ERR_L3_WAITPOINT_NOT_RELEASED");
denial("AUTH-01 non-released pending Waitpoint", (x) => { x.snapshot.waitpoint.status = "blocked"; }, "ERR_L3_WAITPOINT_NOT_RELEASED");
denial("AUTH-01 closed is not owning released", (x) => { x.snapshot.waitpoint.status = "closed"; }, "ERR_L3_WAITPOINT_NOT_RELEASED");
denial("AUTH-01 resolved is not approved", (x) => { x.snapshot.decision.status = "resolved"; }, "ERR_L3_DECISION_NOT_APPROVED");
denial("AUTH-01 approved status with rejected choice", (x) => { x.snapshot.decision.selected_option = "reject"; }, "ERR_L3_DECISION_NOT_APPROVED");
denial("AUTH-01 wrong Waitpoint decision", (x) => { x.snapshot.waitpoint.decision_id = "D-OTHER"; }, "ERR_L3_WAITPOINT_NOT_RELEASED");
denial("AUTH-01 wrong owning workflow", (x) => { x.snapshot.waitpoint.owner_workflow = "/start-task"; }, "ERR_L3_WAITPOINT_OWNER_MISMATCH");
denial("AUTH-01 non-owner released_by", (x) => { x.snapshot.waitpoint.released_by = "random-agent"; }, "ERR_L3_WAITPOINT_OWNER_MISMATCH");
denial("AUTH-01 forged release timestamp before decision", (x) => { x.snapshot.waitpoint.released_at = "2026-10-09T04:59:00.000Z"; }, "ERR_L3_RELEASE_PROVENANCE_INVALID");
denial("AUTH-01 missing release provenance", (x) => { x.snapshot.waitpoint.released_at = null; }, "ERR_L3_RELEASE_PROVENANCE_INVALID");

// AUTH-02: canonical project/Mission/Task/plan/revision binding.
denial("AUTH-02 wrong project", (x) => { x.request.project_ref = "project:another"; }, "ERR_L3_PROJECT_MISMATCH");
denial("AUTH-02 wrong project binding", (x) => { x.request.binding_ref = "governance:another"; }, "ERR_L3_BINDING_MISMATCH");
denial("AUTH-02 wrong Mission", (x) => { x.request.mission_ref = "mission:M-OTHER"; }, "ERR_L3_MISSION_MISMATCH");
denial("AUTH-02 wrong Task", (x) => { x.request.task_ref = "task:T-OTHER"; }, "ERR_L3_TASK_MISMATCH");
denial("AUTH-02 Task missing from approved Mission", (x) => { x.snapshot.mission.task_refs = []; }, "ERR_L3_TASK_NOT_READY");
denial("AUTH-02 unaccepted dependencies", (x) => { x.snapshot.task.dependencies_accepted = false; }, "ERR_L3_TASK_NOT_READY");
denial("AUTH-02 stale plan digest", (x) => { x.request.plan_digest = "sha256:" + "b".repeat(64); }, "ERR_L3_PLAN_MISMATCH");
denial("AUTH-02 plan revision mismatch", (x) => { x.request.plan_revision = "plan-r2"; }, "ERR_L3_PLAN_REVISION_MISMATCH");
denial("AUTH-02 same revision value wrong kind", (x) => { x.request.governance_revision = { store_kind: "filesystem", value: REV.value }; }, "ERR_L3_REVISION_MISMATCH");
denial("AUTH-02 different Git revision", (x) => { x.request.governance_revision.value = "c".repeat(40); }, "ERR_L3_REVISION_MISMATCH");
denial("AUTH-02 missing source revision", (x) => { x.snapshot.provenance.governance_revision = null; }, "ERR_L3_REVISION_MISMATCH");
denial("AUTH-02 mismatching Decision scope kind", (x) => { x.snapshot.decision.approved_scope.governance_revision = { store_kind: "filesystem", value: "sha256:" + "b".repeat(64) }; }, "ERR_L3_SCOPE_MISMATCH");
denial("AUTH-02 scope not bound to Task", (x) => { x.snapshot.decision.approved_scope.task_refs = []; }, "ERR_L3_SCOPE_MISMATCH");
denial("AUTH-02 string cannot forge Task allowlist", (x) => { x.snapshot.decision.approved_scope.task_refs = x.request.task_ref; }, "ERR_L3_SCOPE_MISMATCH");
denial("AUTH-02 stale observation", (x) => { x.snapshot.provenance.observed_at = "2026-10-09T05:00:00.000Z"; }, "ERR_L3_SOURCE_STALE");
denial("AUTH-02 source unknown cannot imply authority", (x) => { x.snapshot.provenance.source_type = "host_claim"; }, "ERR_L3_SOURCE_UNVERIFIED");

// AUTH-03: bounded approval and live owner surface (fixture only).
denial("AUTH-03 Decision expired", (x) => { x.snapshot.decision.expires_at = "2026-10-09T06:00:00.000Z"; }, "ERR_L3_APPROVAL_EXPIRED");
denial("AUTH-03 Decision revoked", (x) => { x.snapshot.decision.revoked_at = "2026-10-09T05:55:00.000Z"; }, "ERR_L3_DECISION_REVOKED_OR_STALE");
denial("AUTH-03 Waitpoint revoked", (x) => { x.snapshot.waitpoint.revoked_at = "2026-10-09T05:55:00.000Z"; }, "ERR_L3_WAITPOINT_OWNER_MISMATCH");
denial("AUTH-03 Waitpoint expired", (x) => { x.snapshot.waitpoint.expires_at = "2026-10-09T06:00:00.000Z"; }, "ERR_L3_APPROVAL_EXPIRED");
denial("AUTH-03 owner rotated", (x) => { x.snapshot.ownership.owner_ref = "owner:other"; }, "ERR_L3_OWNER_OR_LEASE_MISMATCH");
denial("AUTH-03 lease expired", (x) => { x.snapshot.ownership.expires_at = "2026-10-09T05:59:59.000Z"; }, "ERR_L3_OWNER_OR_LEASE_MISMATCH");
denial("AUTH-03 fence changed", (x) => { x.request.fencing_epoch = 9; }, "ERR_L3_FENCE_MISMATCH");
denial("AUTH-03 invalid missing physical lease", (x) => { x.snapshot.ownership.lease_ref = null; }, "ERR_L3_OWNER_OR_LEASE_MISMATCH");

// AUTH-04: file/operation/Host and cost boundaries (not a realpath proof).
denial("AUTH-04 path traversal", (x) => { x.request.relative_path = "lib/dispatch/../secret.js"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("AUTH-04 root escape", (x) => { x.request.relative_path = "../../secret"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("AUTH-04 absolute path", (x) => { x.request.relative_path = "/tmp/secret"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("AUTH-04 protected governance path", (x) => { x.request.relative_path = ".agent/decisions/D-1.json"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("AUTH-04 unlisted path", (x) => { x.request.relative_path = "src/unlisted.js"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("AUTH-04 unlisted branch", (x) => { x.request.branch_ref = "main"; }, "ERR_L3_TARGET_MISMATCH");
denial("AUTH-04 protected branch even if scope was forged", (x) => { x.request.branch_ref = "main"; x.snapshot.decision.approved_scope.branch_ref = "main"; }, "ERR_L3_TARGET_MISMATCH");
denial("AUTH-04 wrong repository", (x) => { x.request.repository_ref = "repository:other"; }, "ERR_L3_TARGET_MISMATCH");
denial("AUTH-04 remote Host mismatch", (x) => { x.request.host_ref = "host:unapproved"; }, "ERR_L3_TARGET_MISMATCH");
denial("AUTH-04 merge is always separately gated", (x) => { x.request.operation = "merge"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("AUTH-04 no writable scope wildcard", (x) => { x.snapshot.decision.approved_scope.allowed_paths = ["**"]; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("AUTH-04 expanded risk", (x) => { x.request.risk_tier = "high"; x.snapshot.task.risk_tier = "high"; }, "ERR_L3_RISK_ESCALATION");
denial("AUTH-04 over budget", (x) => { x.request.usage.attempt = 3; }, "ERR_L3_BUDGET_EXCEEDED");
denial("AUTH-04 unknown extra scope field", (x) => { x.snapshot.decision.approved_scope.admin = true; }, "ERR_L3_SCOPE_INVALID");

// AUTH-05/11: untrusted advisor, Host or synthetic plan cannot replace truth.
denial("AUTH-05 synthetic Host approved flag does not supply Decision", (x) => {
  x.snapshot.decision = null;
  x.snapshot.host = { governance: { approved: true }, synthetic: true };
}, "ERR_L3_DECISION_NOT_APPROVED");
denial("AUTH-05 ADVICE_READY cannot release Waitpoint", (x) => {
  x.snapshot.waitpoint = null;
  x.snapshot.advice = { advice_status: "ADVICE_READY", execution_authorized: false };
}, "ERR_L3_WAITPOINT_NOT_RELEASED");
denial("AUTH-11 Phase-0 or dry-run result cannot be authority", (x) => {
  x.snapshot.provenance.source_type = "dry_run_snapshot";
  x.snapshot.dry_run = { would_proceed: true, governance: { approved: true } };
}, "ERR_L3_SOURCE_UNVERIFIED");
denial("AUTH-11 omitted gate input never becomes eligible", (x) => { x.snapshot.decision = undefined; x.snapshot.waitpoint = undefined; }, "ERR_L3_DECISION_NOT_APPROVED");

test("AUTH-03 idempotent cached accepted record after revocation is BLOCKED (never cached success)", () => {
  const input = valid();
  const cache = {
    status: "accepted", idempotency_key: input.request.idempotency_key,
    project_ref: input.request.project_ref, mission_ref: input.request.mission_ref,
    task_ref: input.request.task_ref, plan_digest: input.request.plan_digest,
    decision_id: input.request.decision_id, waitpoint_id: input.request.waitpoint_id,
  };
  const first = validateL3CachedReturn({ ...input, cached_result: cache });
  assert.equal(first.status, "CACHED_SCOPE_MATCHED_FIXTURE_ONLY");
  assert.equal(first.execution_authorized, false);
  input.snapshot.decision.revoked_at = "2026-10-09T05:59:59.000Z";
  const afterRevocation = validateL3CachedReturn({ ...input, cached_result: cache });
  assert.equal(afterRevocation.status, "BLOCKED");
  assert.equal(afterRevocation.code, "ERR_L3_DECISION_REVOKED_OR_STALE");
});

test("AUTH-03 stale idempotent record of another Task cannot return matched", () => {
  const input = valid();
  const v = validateL3CachedReturn({ ...input, cached_result: {
    status: "accepted", idempotency_key: input.request.idempotency_key,
    project_ref: input.request.project_ref, mission_ref: input.request.mission_ref,
    task_ref: "task:T-OTHER", plan_digest: input.request.plan_digest,
    decision_id: input.request.decision_id, waitpoint_id: input.request.waitpoint_id,
  } });
  assert.equal(v.status, "BLOCKED");
  assert.equal(v.code, "ERR_L3_CACHED_SCOPE_MISMATCH");
});

test("pure validator never invokes a provided effect/cached-lookup hook", () => {
  const input = valid();
  let effects = 0;
  input.request.tool = () => { effects++; };
  input.request.read_cache = () => { effects++; };
  input.snapshot.host = { dispatch: () => { effects++; } };
  const result = validateL3Authorization(input);
  assert.equal(result.matched, true);
  assert.equal(effects, 0);
});

// Additional hardening/edge coverage for the scratch-only pure parser.
denial("missing request object rejects", (x) => { x.request = null; }, "ERR_L3_INPUT_MISSING");
denial("missing snapshot object rejects", (x) => { x.snapshot = null; }, "ERR_L3_INPUT_MISSING");
denial("invalid injected clock rejects", (x) => { x.now_iso = "2026-10-09"; }, "ERR_L3_TIME_UNVERIFIED");
denial("future source observation rejects", (x) => { x.snapshot.provenance.observed_at = "2026-10-09T06:00:01.000Z"; }, "ERR_L3_SOURCE_STALE");
denial("unbound project provenance rejects", (x) => { x.snapshot.provenance.project_ref = "project:elsewhere"; }, "ERR_L3_PROJECT_MISMATCH");
denial("unknown revision store kind rejects", (x) => { x.request.governance_revision.store_kind = "postgres"; }, "ERR_L3_REVISION_MISMATCH");
denial("revision unknown field rejects", (x) => { x.request.governance_revision.extra = "abc"; }, "ERR_L3_REVISION_MISMATCH");
denial("untyped bare Git SHA rejects", (x) => { x.request.governance_revision = REV.value; }, "ERR_L3_REVISION_MISMATCH");
denial("wrong typed revision algorithm rejects", (x) => { x.request.governance_revision.value = "sha256:" + "a".repeat(64); }, "ERR_L3_REVISION_MISMATCH");
denial("empty relation denies", (x) => { x.snapshot.decision.relations = {}; }, "ERR_L3_GATE_RELATION_MISMATCH");
denial("wrong Waitpoint Task relation denies", (x) => { x.snapshot.waitpoint.relations.task_ids = []; }, "ERR_L3_GATE_RELATION_MISMATCH");
denial("wrong gate resource denies", (x) => { x.snapshot.waitpoint.gate.resource_ref += ":tampered"; }, "ERR_L3_GATE_RESOURCE_MISMATCH");
denial("wrong gate action denies", (x) => { x.request.action = "merge"; }, "ERR_L3_GATE_RESOURCE_MISMATCH");
denial("missing gate object denies", (x) => { x.snapshot.waitpoint.gate = null; }, "ERR_L3_GATE_RESOURCE_MISMATCH");
denial("decision not yet resolved denies", (x) => { x.snapshot.decision.resolved_at = "2026-10-09T07:00:00.000Z"; }, "ERR_L3_DECISION_REVOKED_OR_STALE");
denial("future release timestamp denies", (x) => { x.snapshot.waitpoint.released_at = "2026-10-09T06:00:01.000Z"; }, "ERR_L3_RELEASE_PROVENANCE_INVALID");
denial("missing scope denies", (x) => { x.snapshot.decision.approved_scope = null; }, "ERR_L3_SCOPE_INVALID");
denial("scope not yet valid denies", (x) => { x.snapshot.decision.approved_scope.valid_from = "2026-10-09T06:00:01.000Z"; }, "ERR_L3_APPROVAL_EXPIRED");
denial("scope expired denies", (x) => { x.snapshot.decision.approved_scope.expires_at = NOW; }, "ERR_L3_APPROVAL_EXPIRED");
denial("missing Decision expiry denies", (x) => { x.snapshot.decision.expires_at = null; }, "ERR_L3_APPROVAL_EXPIRED");
denial("wrong path backslash denies", (x) => { x.request.relative_path = "lib\\dispatch\\x.js"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("double slash in path denies", (x) => { x.request.relative_path = "lib//dispatch/a.js"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("literal dot segment in path denies", (x) => { x.request.relative_path = "lib/./dispatch/a.js"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("local hidden runtime path denies", (x) => { x.request.relative_path = ".agent-runtime/sessions/a.json"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("path wildcard input denies", (x) => { x.request.relative_path = "lib/dispatch/*.js"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("unknown operation denies", (x) => { x.request.operation = "unknown"; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("no allowed operation denies", (x) => { x.snapshot.decision.approved_scope.allowed_operations = []; }, "ERR_L3_EFFECT_OUT_OF_SCOPE");
denial("unknown risk tier denies", (x) => { x.snapshot.task.risk_tier = "unknown"; x.request.risk_tier = "unknown"; }, "ERR_L3_RISK_ESCALATION");
denial("negative token budget denies", (x) => { x.request.usage.tokens = -1; }, "ERR_L3_BUDGET_EXCEEDED");
denial("over token budget denies", (x) => { x.request.usage.tokens = 10001; }, "ERR_L3_BUDGET_EXCEEDED");
denial("over time budget denies", (x) => { x.request.usage.wall_minutes = 31; }, "ERR_L3_BUDGET_EXCEEDED");
denial("over cost budget denies", (x) => { x.request.usage.cost_usd = 2.1; }, "ERR_L3_BUDGET_EXCEEDED");
denial("fractional attempt denies", (x) => { x.request.usage.attempt = 1.5; }, "ERR_L3_BUDGET_EXCEEDED");
denial("fractional declared max attempts denies", (x) => { x.snapshot.decision.approved_scope.budget.max_attempts = 2.5; }, "ERR_L3_BUDGET_EXCEEDED");
denial("no usage ledger denies", (x) => { x.request.usage = null; }, "ERR_L3_BUDGET_EXCEEDED");
denial("owner active false denies", (x) => { x.snapshot.ownership.active = false; }, "ERR_L3_OWNER_OR_LEASE_MISMATCH");
denial("fence epoch invalid denies", (x) => { x.snapshot.ownership.fencing_epoch = 0; }, "ERR_L3_OWNER_OR_LEASE_MISMATCH");
denial("different lease ref denies", (x) => { x.request.lease_ref = "lease:stale"; }, "ERR_L3_FENCE_MISMATCH");

test("filesystem sha256 source revision may match fixture (still no effect authorization)", () => {
  const input = valid();
  const rev = { store_kind: "filesystem", value: "sha256:" + "b".repeat(64) };
  input.request.governance_revision = structuredClone(rev);
  input.snapshot.provenance.governance_revision = structuredClone(rev);
  input.snapshot.decision.approved_scope.governance_revision = structuredClone(rev);
  const v = validateL3Authorization(input);
  assert.equal(v.matched, true);
  assert.equal(v.effect_permitted, false);
});

test("exact approved path is acceptable fixture, no execution", () => {
  const input = valid();
  input.snapshot.decision.approved_scope.allowed_paths = [input.request.relative_path];
  const v = validateL3Authorization(input);
  assert.equal(v.matched, true);
  assert.equal(v.execution_authorized, false);
});

test("cached result is never treated as authorization when authoritative fixture is absent", () => {
  const v = validateL3CachedReturn({ snapshot: null, request: valid().request, now_iso: NOW, cached_result: { status: "accepted" } });
  assert.equal(v.status, "BLOCKED");
  assert.equal(v.execution_authorized, false);
});
