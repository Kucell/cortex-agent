"use strict";

// ISOLATED SCRATCH PROTOTYPE, NOT CONNECTED TO REAL GOVERNANCE OR A HOST.
// This module compares *injected fixtures*. A matching result deliberately
// NEVER grants permission to enqueue, claim, access a tool, or dispatch a Run.
// A future approved integrator must load canonical records independently and
// enforce current live Owner/Lease, CAS, Host and effect-sink gates.

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const REFS = /^(?:project|mission|task|repository|host):[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ALLOWED_OPS = new Set(["plan", "implement", "test", "review", "local_commit"]);
const RISK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\r\n\0]/.test(value);
}
function ref(value) {
  return text(value) && REFS.test(value) && !value.includes("..");
}
function revision(value) {
  if (!object(value)) return false;
  if (Object.keys(value).some((key) => !["store_kind", "value"].includes(key))) return false;
  if (value.store_kind === "git") return /^[a-f0-9]{40}$/.test(value.value || "");
  if (value.store_kind === "filesystem") return SHA256.test(value.value || "");
  return false;
}
function sameRevision(a, b) {
  return revision(a) && revision(b) && a.store_kind === b.store_kind && a.value === b.value;
}
function iso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? epoch : null;
}
function blocked(code) {
  return Object.freeze({ matched: false, status: "BLOCKED", code,
    execution_authorized: false, effect_permitted: false });
}
function requireMatch(condition, code) {
  if (!condition) {
    const e = new Error(code);
    e.code = code;
    throw e;
  }
}
function safePath(value) {
  if (!text(value) || value.startsWith("/") || value.includes("\\") || value.includes("//") || /[\x00-\x1f]/.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("*") || part.includes("?"))) return false;
  if (new Set([".git", ".agent", ".agent-runtime"]).has(parts[0])) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return true;
}
function allowedPath(actual, patterns) {
  if (!safePath(actual) || !Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (!text(pattern) || pattern === "**" || pattern === "*") return false;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return safePath(prefix) && actual.startsWith(prefix + "/");
    }
    return safePath(pattern) && actual === pattern;
  });
}
function withinBudget(budget, request) {
  if (!object(budget) || !object(request.usage)) return false;
  const fields = ["max_attempts", "max_tokens", "max_wall_minutes", "max_cost_usd"];
  if (fields.some((field) => !Number.isFinite(budget[field]) || budget[field] <= 0)) return false;
  if (!Number.isSafeInteger(budget.max_attempts) || !Number.isSafeInteger(budget.max_tokens)) return false;
  const usage = request.usage;
  if (!Number.isSafeInteger(usage.attempt) || usage.attempt < 1 || usage.attempt > budget.max_attempts) return false;
  for (const [field, limit] of [["tokens", "max_tokens"], ["wall_minutes", "max_wall_minutes"], ["cost_usd", "max_cost_usd"]]) {
    if (!Number.isFinite(usage[field]) || usage[field] < 0 || usage[field] > budget[limit]) return false;
  }
  return true;
}
function idsInclude(relations, kind, id) {
  return object(relations) && Array.isArray(relations[kind]) && relations[kind].includes(id);
}

/**
 * Compare a pinned fixture of canonical records. This is not an authority loader
 * and cannot authorize any effect. Its success means only that the injected
 * objects are internally consistent; it is intentionally false for live grants.
 * Pure: no IO, Date.now, process, network, caching, or writes.
 */
function validateL3Authorization({ snapshot, request, now_iso } = {}) {
  try {
    requireMatch(object(snapshot) && object(request), "ERR_L3_INPUT_MISSING");
    const now = iso(now_iso);
    requireMatch(now !== null, "ERR_L3_TIME_UNVERIFIED");
    const { provenance: p, project, mission, task, decision: d, waitpoint: w, ownership: o } = snapshot;
    requireMatch(object(p) && p.source_type === "canonical_governance_fixture" && object(project) && object(mission) && object(task), "ERR_L3_SOURCE_UNVERIFIED");
    requireMatch(ref(p.project_ref) && ref(request.project_ref) && request.project_ref === p.project_ref && project.project_ref === p.project_ref, "ERR_L3_PROJECT_MISMATCH");
    requireMatch(text(p.binding_ref) && project.binding_ref === p.binding_ref && request.binding_ref === p.binding_ref, "ERR_L3_BINDING_MISMATCH");
    requireMatch(sameRevision(p.governance_revision, request.governance_revision), "ERR_L3_REVISION_MISMATCH");
    const observedAt = iso(p.observed_at);
    requireMatch(observedAt !== null && observedAt <= now && now - observedAt <= 60000, "ERR_L3_SOURCE_STALE");

    requireMatch(ref(request.mission_ref) && request.mission_ref === mission.mission_ref && mission.project_ref === p.project_ref, "ERR_L3_MISSION_MISMATCH");
    requireMatch(ref(request.task_ref) && task.task_ref === request.task_ref && task.project_ref === p.project_ref && task.mission_ref === request.mission_ref, "ERR_L3_TASK_MISMATCH");
    requireMatch(Array.isArray(mission.task_refs) && mission.task_refs.includes(request.task_ref) && task.dependencies_accepted === true, "ERR_L3_TASK_NOT_READY");
    requireMatch(SHA256.test(request.plan_digest || "") && mission.plan_digest === request.plan_digest && task.plan_digest === request.plan_digest, "ERR_L3_PLAN_MISMATCH");
    requireMatch(text(request.plan_revision) && mission.plan_revision === request.plan_revision && task.plan_revision === request.plan_revision, "ERR_L3_PLAN_REVISION_MISMATCH");

    requireMatch(object(d) && text(request.decision_id) && d.decision_id === request.decision_id && d.status === "approved" && d.selected_option === "approve" && text(d.resolved_by), "ERR_L3_DECISION_NOT_APPROVED");
    const resolvedAt = iso(d.resolved_at);
    requireMatch(resolvedAt !== null && resolvedAt <= now && d.revoked_at == null, "ERR_L3_DECISION_REVOKED_OR_STALE");
    requireMatch(object(w) && text(request.waitpoint_id) && w.waitpoint_id === request.waitpoint_id && w.decision_id === d.decision_id && w.status === "released", "ERR_L3_WAITPOINT_NOT_RELEASED");
    requireMatch(object(d.gate) && object(w.gate) && text(request.action) && text(request.resource_ref)
      && d.gate.action === request.action && d.gate.resource_ref === request.resource_ref
      && w.gate.action === d.gate.action && w.gate.resource_ref === d.gate.resource_ref,
    "ERR_L3_GATE_RESOURCE_MISMATCH");
    requireMatch(idsInclude(d.relations, "task_ids", task.task_ref) && idsInclude(d.relations, "mission_ids", mission.mission_ref)
      && idsInclude(w.relations, "task_ids", task.task_ref) && idsInclude(w.relations, "mission_ids", mission.mission_ref), "ERR_L3_GATE_RELATION_MISMATCH");
    requireMatch(text(w.owner_workflow) && w.owner_workflow === mission.owner_workflow && text(w.released_by)
      && w.released_by === mission.workflow_actor_ref && w.revoked_at == null, "ERR_L3_WAITPOINT_OWNER_MISMATCH");
    const releasedAt = iso(w.released_at);
    requireMatch(releasedAt !== null && releasedAt >= resolvedAt && releasedAt <= now, "ERR_L3_RELEASE_PROVENANCE_INVALID");

    const s = d.approved_scope;
    requireMatch(object(s) && Object.keys(s).every((k) => [
      "project_ref", "mission_ref", "task_refs", "plan_digest", "plan_revision", "governance_revision",
      "owner_ref", "repository_ref", "branch_ref", "allowed_paths", "allowed_operations", "host_ref",
      "budget", "valid_from", "expires_at", "risk_limit",
    ].includes(k)), "ERR_L3_SCOPE_INVALID");
    requireMatch(s.project_ref === p.project_ref && s.mission_ref === mission.mission_ref
      && Array.isArray(s.task_refs) && s.task_refs.includes(task.task_ref)
      && s.plan_digest === request.plan_digest && s.plan_revision === request.plan_revision
      && sameRevision(s.governance_revision, p.governance_revision), "ERR_L3_SCOPE_MISMATCH");
    const start = iso(s.valid_from);
    const expiry = iso(s.expires_at);
    const decisionExpiry = iso(d.expires_at);
    const waitpointExpiry = w.expires_at == null ? Infinity : iso(w.expires_at);
    requireMatch(start !== null && expiry !== null && start <= now && now < expiry && decisionExpiry !== null && now < decisionExpiry
      && waitpointExpiry !== null && now < waitpointExpiry, "ERR_L3_APPROVAL_EXPIRED");

    requireMatch(ref(s.repository_ref) && s.repository_ref === request.repository_ref
      && text(s.branch_ref) && s.branch_ref === request.branch_ref
      && !new Set(["main", "master", "production", "develop", "release"]).has(s.branch_ref)
      && ref(s.host_ref) && s.host_ref === request.host_ref, "ERR_L3_TARGET_MISMATCH");
    requireMatch(ALLOWED_OPS.has(request.operation) && Array.isArray(s.allowed_operations) && s.allowed_operations.includes(request.operation)
      && allowedPath(request.relative_path, s.allowed_paths), "ERR_L3_EFFECT_OUT_OF_SCOPE");
    requireMatch(Object.hasOwn(RISK, request.risk_tier) && Object.hasOwn(RISK, s.risk_limit)
      && RISK[request.risk_tier] <= RISK[s.risk_limit] && task.risk_tier === request.risk_tier, "ERR_L3_RISK_ESCALATION");
    requireMatch(withinBudget(s.budget, request), "ERR_L3_BUDGET_EXCEEDED");

    requireMatch(object(o) && o.active === true && text(o.owner_ref) && text(o.lease_ref) && Number.isSafeInteger(o.fencing_epoch)
      && o.fencing_epoch >= 1 && iso(o.expires_at) !== null && now < iso(o.expires_at)
      && o.owner_ref === s.owner_ref && project.owner_ref === o.owner_ref && mission.owner_ref === o.owner_ref
      && request.owner_ref === o.owner_ref, "ERR_L3_OWNER_OR_LEASE_MISMATCH");
    requireMatch(request.fencing_epoch === o.fencing_epoch && request.lease_ref === o.lease_ref, "ERR_L3_FENCE_MISMATCH");

    // There is deliberately no 'authorized:true' / 'run' / effect handle.
    return Object.freeze({ matched: true, status: "SCOPE_MATCHED_FIXTURE_ONLY",
      execution_authorized: false, effect_permitted: false,
      pending_real_gates: Object.freeze(["canonical_store_read", "atomic_lease_cas", "fence_at_effect_sink", "live_host_and_budget"]),
      decision_id: d.decision_id, waitpoint_id: w.waitpoint_id });
  } catch (err) {
    return blocked(err?.code || "ERR_L3_VALIDATOR_INPUT");
  }
}

// Pure review of a pre-supplied cache record. Future integration MUST perform
// a fresh authoritative load and this validation BEFORE its cache lookup.
function validateL3CachedReturn({ snapshot, request, now_iso, cached_result } = {}) {
  const gate = validateL3Authorization({ snapshot, request, now_iso });
  if (!gate.matched) return gate;
  if (cached_result == null) return gate;
  if (!object(cached_result) || cached_result.status !== "accepted"
    || !text(request.idempotency_key) || cached_result.idempotency_key !== request.idempotency_key
    || cached_result.project_ref !== request.project_ref
    || cached_result.mission_ref !== request.mission_ref
    || cached_result.task_ref !== request.task_ref
    || cached_result.plan_digest !== request.plan_digest
    || cached_result.decision_id !== request.decision_id
    || cached_result.waitpoint_id !== request.waitpoint_id) return blocked("ERR_L3_CACHED_SCOPE_MISMATCH");
  return Object.freeze({ ...gate, status: "CACHED_SCOPE_MATCHED_FIXTURE_ONLY" });
}

module.exports = Object.freeze({ validateL3Authorization, validateL3CachedReturn });
