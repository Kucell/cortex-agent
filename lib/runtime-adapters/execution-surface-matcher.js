"use strict";

// ─── Execution Surface Matcher (MS-007 / P-004) ─────────────────────────────
//
// Pure, deterministic matcher that takes a frozen ExecutionRequirement +
// a set of frozen RuntimeSnapshots and emits a frozen DispatchPlan.
//
// Hard filters (mandatory pass; soft scoring CANNOT override):
//   * Every required_capability must be present in the snapshot at level
//     ≥ the required minimum (native > adapter > explicit > unobservable).
//     `unsupported` always fails.
//   * Governance gate: if the requirement demands an approved Decision,
//     the snapshot must reference the same Decision.
//   * Lease: if the requirement requires an active lease, the snapshot
//     must carry one.
//   * TTL: snapshot age must be < requirement.ttl_at - snapshot.taken_at.
//
// Soft scoring (advisory only):
//   * reliability, cost, latency — combined into a deterministic score.
//   * Never overrides a hard filter.
//
// Determinism:
//   * Identical inputs always produce identical output.
//   * Candidate ordering is total: score desc → host_profile_ref asc.

const capabilityContract = require("./capability-contract");

const SCHEMA_VERSION = "1.0";
const CAPABILITY_LEVEL_RANK = Object.freeze({
  native: 4,
  adapter: 3,
  explicit: 2,
  unobservable: 1,
  unsupported: 0,
});

const REJECTION_REASONS = Object.freeze([
  "missing_capability",
  "insufficient_capability_level",
  "governance_unapproved",
  "governance_decision_mismatch",
  "lease_inactive",
  "lease_holder_mismatch",
  "snapshot_expired",
  "snapshot_invalid",
  "host_profile_invalid",
]);

class ExecutionSurfaceError extends Error {
  constructor(code, details) {
    super(`[execution-surface:${code}] ${JSON.stringify(details || {})}`);
    this.name = "ExecutionSurfaceError";
    this.code = code;
    this.details = details || {};
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value, where) {
  if (!Array.isArray(value)) {
    throw new ExecutionSurfaceError("ERR_NOT_ARRAY", { where });
  }
  return value;
}

function asNonEmptyString(value, where, max = 4096) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where, reason: "not_string" });
  }
  if (value.length > max) {
    throw new ExecutionSurfaceError("ERR_FIELD_TOO_LONG", { where, max });
  }
  return value;
}

function asIdentifier(value, where, max = 128) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where, reason: "identifier_format" });
  }
  if (value.length > max) {
    throw new ExecutionSurfaceError("ERR_FIELD_TOO_LONG", { where, max });
  }
  return value;
}

function asNumber(value, where, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where, reason: "not_finite_number" });
  }
  if (value < min || value > max) {
    throw new ExecutionSurfaceError("ERR_FIELD_OUT_OF_RANGE", { where, min, max });
  }
  return value;
}

function asIso(value, where) {
  if (typeof value !== "string") {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where, reason: "not_iso" });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ExecutionSurfaceError("ERR_TIMESTAMP_INVALID", { where });
  }
  return date.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function validateRequirement(input) {
  if (!plain(input)) throw new ExecutionSurfaceError("ERR_REQUIREMENT_INVALID", {});
  if (typeof input.schema_version !== "string" || input.schema_version !== SCHEMA_VERSION) {
    if (typeof input.schema_version !== "string") {
      throw new ExecutionSurfaceError("ERR_REQUIREMENT_INVALID", { reason: "missing_schema_version" });
    }
    throw new ExecutionSurfaceError("ERR_SCHEMA_VERSION_UNKNOWN", { value: input.schema_version });
  }
  asIdentifier(input.requirement_id, "requirement.requirement_id", 64);
  asIdentifier(input.task_id, "requirement.task_id", 64);
  const createdAt = asIso(input.created_at, "requirement.created_at");

  const requiredCapabilities = asArray(input.required_capabilities || [], "requirement.required_capabilities");
  for (let i = 0; i < requiredCapabilities.length; i += 1) {
    const cap = requiredCapabilities[i];
    if (!capabilityContract.isKnownCapability(cap)) {
      throw new ExecutionSurfaceError("ERR_CAPABILITY_UNKNOWN", { where: `requirement.required_capabilities[${i}]`, value: cap });
    }
  }
  // dedupe capabilities while preserving order
  const seen = new Set();
  const dedupedCapabilities = [];
  for (const cap of requiredCapabilities) {
    if (!seen.has(cap)) { seen.add(cap); dedupedCapabilities.push(cap); }
  }
  if (dedupedCapabilities.length > 32) {
    throw new ExecutionSurfaceError("ERR_REQUIREMENT_TOO_MANY_CAPABILITIES", { count: dedupedCapabilities.length });
  }

  const minimumLevels = plain(input.minimum_capability_levels) ? input.minimum_capability_levels : {};
  for (const key of Object.keys(minimumLevels)) {
    if (!capabilityContract.isKnownCapability(key)) {
      throw new ExecutionSurfaceError("ERR_CAPABILITY_UNKNOWN", { where: `requirement.minimum_capability_levels.${key}` });
    }
    if (!(minimumLevels[key] in CAPABILITY_LEVEL_RANK)) {
      throw new ExecutionSurfaceError("ERR_CAPABILITY_LEVEL_UNKNOWN", { value: minimumLevels[key] });
    }
  }

  const governance = plain(input.governance) ? input.governance : {};
  if ("approved_decision_id" in governance) {
    if (governance.approved_decision_id !== null) {
      asIdentifier(governance.approved_decision_id, "requirement.governance.approved_decision_id", 64);
    }
  }
  if ("require_active_lease" in governance && typeof governance.require_active_lease !== "boolean") {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: "requirement.governance.require_active_lease" });
  }

  const ttlAt = input.ttl_at ? asIso(input.ttl_at, "requirement.ttl_at") : null;

  const preferred = plain(input.preferred) ? input.preferred : {};
  for (const key of Object.keys(preferred)) {
    if (!["region", "cost_class", "latency_class"].includes(key)) {
      throw new ExecutionSurfaceError("ERR_FIELD_UNKNOWN", { where: `requirement.preferred.${key}` });
    }
    if (typeof preferred[key] !== "string") {
      throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: `requirement.preferred.${key}` });
    }
  }

  return deepFreeze({
    schema_version: SCHEMA_VERSION,
    requirement_id: input.requirement_id,
    task_id: input.task_id,
    created_at: createdAt,
    required_capabilities: Object.freeze(dedupedCapabilities),
    minimum_capability_levels: Object.freeze({ ...minimumLevels }),
    governance: Object.freeze({
      approved_decision_id: governance.approved_decision_id == null ? null : governance.approved_decision_id,
      require_active_lease: governance.require_active_lease === true,
    }),
    preferred: Object.freeze({ ...preferred }),
    ttl_at: ttlAt,
  });
}

function validateSnapshot(input) {
  if (!plain(input)) throw new ExecutionSurfaceError("ERR_SNAPSHOT_INVALID", {});
  if (input.schema_version !== SCHEMA_VERSION) {
    throw new ExecutionSurfaceError("ERR_SCHEMA_VERSION_UNKNOWN", { where: "snapshot", value: input.schema_version });
  }
  asIdentifier(input.snapshot_id, "snapshot.snapshot_id", 64);
  asIdentifier(input.host_profile_ref, "snapshot.host_profile_ref", 64);
  const takenAt = asIso(input.taken_at, "snapshot.taken_at");

  const capabilities = plain(input.capabilities) ? input.capabilities : {};
  for (const key of Object.keys(capabilities)) {
    if (!capabilityContract.isKnownCapability(key)) {
      throw new ExecutionSurfaceError("ERR_CAPABILITY_UNKNOWN", { where: `snapshot.capabilities.${key}`, value: key });
    }
    if (!(capabilities[key] in CAPABILITY_LEVEL_RANK)) {
      throw new ExecutionSurfaceError("ERR_CAPABILITY_LEVEL_UNKNOWN", { where: `snapshot.capabilities.${key}`, value: capabilities[key] });
    }
  }

  const governance = plain(input.governance) ? input.governance : {};
  if ("approved" in governance && typeof governance.approved !== "boolean") {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: "snapshot.governance.approved" });
  }
  if ("decision_id" in governance && governance.decision_id !== null && governance.decision_id !== undefined) {
    asIdentifier(governance.decision_id, "snapshot.governance.decision_id", 64);
  }

  const lease = plain(input.lease) ? input.lease : {};
  if ("active" in lease && typeof lease.active !== "boolean") {
    throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: "snapshot.lease.active" });
  }
  if ("holder" in lease && lease.holder !== null && lease.holder !== undefined) {
    if (typeof lease.holder !== "string") {
      throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: "snapshot.lease.holder" });
    }
  }

  // Advisory metrics: must declare source and quality; unknown values remain neutral.
  function advisoryMetric(field, where, { min = -Infinity, max = Infinity } = {}) {
    if (!(field in input)) return { value: null, source: "unavailable", quality: "unavailable" };
    const m = plain(input[field]) ? input[field] : null;
    if (!m) {
      throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where });
    }
    if ("value" in m && m.value !== null && m.value !== "unknown") {
      if (typeof m.value !== "number" || !Number.isFinite(m.value)) {
        throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: `${where}.value` });
      }
      if (m.value < min || m.value > max) {
        throw new ExecutionSurfaceError("ERR_FIELD_OUT_OF_RANGE", { where: `${where}.value`, min, max });
      }
    }
    if (m.source !== "unavailable" && typeof m.source !== "string") {
      throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: `${where}.source` });
    }
    if (!["unavailable", "low", "medium", "high"].includes(m.quality)) {
      throw new ExecutionSurfaceError("ERR_FIELD_INVALID", { where: `${where}.quality` });
    }
    return deepFreeze({ ...m });
  }

  return deepFreeze({
    schema_version: SCHEMA_VERSION,
    snapshot_id: input.snapshot_id,
    host_profile_ref: input.host_profile_ref,
    taken_at: takenAt,
    capabilities: Object.freeze({ ...capabilities }),
    governance: Object.freeze({
      approved: governance.approved === true,
      decision_id: governance.decision_id == null ? null : governance.decision_id,
    }),
    lease: Object.freeze({
      active: lease.active === true,
      holder: lease.holder == null ? null : lease.holder,
    }),
    reliability: advisoryMetric("reliability", "snapshot.reliability", { min: 0, max: 1 }),
    cost: advisoryMetric("cost", "snapshot.cost", { min: 0, max: 1_000_000 }),
    latency: advisoryMetric("latency", "snapshot.latency", { min: 0, max: 1_000_000 }),
  });
}

function matchExecutionSurface(requirement, snapshots, options) {
  const req = validateRequirement(requirement);
  const list = asArray(snapshots || [], "snapshots").map(validateSnapshot);
  const opts = options || {};
  const now = opts.now ? asIso(opts.now, "options.now") : new Date().toISOString();
  const nowMs = new Date(now).getTime();

  const candidates = list.map((snapshot) => evaluateCandidate(req, snapshot, nowMs));

  candidates.sort((a, b) => {
    if (a.hard_pass !== b.hard_pass) return a.hard_pass ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    if (a.host_profile_ref < b.host_profile_ref) return -1;
    if (a.host_profile_ref > b.host_profile_ref) return 1;
    return 0;
  });

  const top = candidates.find((c) => c.hard_pass) || null;
  const selection = top ? top.host_profile_ref : null;
  const reasoning = buildReasoning(req, candidates, selection);

  return deepFreeze({
    schema_version: SCHEMA_VERSION,
    plan_id: `P-${req.requirement_id}-${derivePlanRevision(req, list, now)}`,
    requirement_id: req.requirement_id,
    snapshot_revision: derivePlanRevision(req, list, now),
    created_at: now,
    candidates: Object.freeze(candidates),
    selection,
    reasoning,
  });
}

function evaluateCandidate(req, snapshot, nowMs) {
  const rejected = [];

  // Snapshot TTL
  const snapshotMs = new Date(snapshot.taken_at).getTime();
  const maxAgeMs = req.ttl_at ? new Date(req.ttl_at).getTime() - snapshotMs : Infinity;
  const ageMs = nowMs - snapshotMs;
  if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) {
    return rejectedCandidate(snapshot.host_profile_ref, ["snapshot_expired"], { snapshot_taken_at: snapshot.taken_at, ttl_at: req.ttl_at });
  }

  // Required capabilities
  for (const cap of req.required_capabilities) {
    const level = snapshot.capabilities[cap];
    if (!level) {
      rejected.push(`missing_capability:${cap}`);
      continue;
    }
    const requiredLevel = req.minimum_capability_levels[cap] || "adapter";
    if (CAPABILITY_LEVEL_RANK[level] < CAPABILITY_LEVEL_RANK[requiredLevel]) {
      rejected.push(`insufficient_capability_level:${cap}:${level}<${requiredLevel}`);
    }
  }

  // Governance
  if (req.governance.approved_decision_id !== null) {
    if (!snapshot.governance.approved) {
      rejected.push("governance_unapproved");
    } else if (snapshot.governance.decision_id !== req.governance.approved_decision_id) {
      rejected.push(`governance_decision_mismatch:${snapshot.governance.decision_id || "null"}!=${req.governance.approved_decision_id}`);
    }
  }

  // Lease
  if (req.governance.require_active_lease && !snapshot.lease.active) {
    rejected.push("lease_inactive");
  }

  const hard_pass = rejected.length === 0;
  const score = hard_pass ? advisoryScore(req, snapshot) : 0;

  return deepFreeze({
    host_profile_ref: snapshot.host_profile_ref,
    snapshot_id: snapshot.snapshot_id,
    hard_pass,
    rejected_reasons: Object.freeze([...rejected]),
    score,
    metrics: deepFreeze({
      reliability: snapshot.reliability,
      cost: snapshot.cost,
      latency: snapshot.latency,
    }),
  });
}

function rejectedCandidate(host_profile_ref, reasons, extras) {
  return deepFreeze({
    host_profile_ref,
    snapshot_id: null,
    hard_pass: false,
    rejected_reasons: Object.freeze([...reasons]),
    score: 0,
    metrics: deepFreeze({
      reliability: { value: null, source: "unavailable", quality: "unavailable" },
      cost: { value: null, source: "unavailable", quality: "unavailable" },
      latency: { value: null, source: "unavailable", quality: "unavailable" },
    }),
    ...(extras || {}),
  });
}

function advisoryScore(req, snapshot) {
  // Reliability contributes positively (0..1); cost + latency contribute inversely.
  // Unknown metrics contribute 0 (neutral); scoring therefore never *promotes*
  // an unobserved host above an observed one.
  let score = 0;
  let weight = 0;
  if (snapshot.reliability.value !== null && snapshot.reliability.value !== "unknown") {
    score += Number(snapshot.reliability.value) * 0.5;
    weight += 0.5;
  }
  if (snapshot.cost.value !== null && snapshot.cost.value !== "unknown") {
    const normalised = Math.max(0, 1 - (Number(snapshot.cost.value) / 1.0));
    score += normalised * 0.3;
    weight += 0.3;
  }
  if (snapshot.latency.value !== null && snapshot.latency.value !== "unknown") {
    const normalised = Math.max(0, 1 - (Number(snapshot.latency.value) / 1000));
    score += normalised * 0.2;
    weight += 0.2;
  }
  if (weight === 0) return 0; // unknown metrics remain neutral
  return Math.round((score / weight) * 1000) / 1000;
}

function buildReasoning(req, candidates, selection) {
  const hardPassCount = candidates.filter((c) => c.hard_pass).length;
  const summary = `requirement ${req.requirement_id} has ${req.required_capabilities.length} required capabilities; ${hardPassCount}/${candidates.length} snapshots passed hard filters.`;
  if (!selection) {
    return `${summary} No candidate satisfied all hard filters; selection is null.`;
  }
  const chosen = candidates.find((c) => c.host_profile_ref === selection);
  return `${summary} Selected ${selection} with score ${chosen.score}; soft scoring could not have overridden the hard filters.`;
}

function derivePlanRevision(req, snapshots, now) {
  const crypto = require("node:crypto");
  const material = JSON.stringify({
    requirement: req,
    snapshot_ids: snapshots.map((s) => s.snapshot_id).sort(),
    taken_at: snapshots.map((s) => s.taken_at).sort(),
    now,
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

module.exports = {
  CAPABILITY_LEVEL_RANK,
  REJECTION_REASONS,
  SCHEMA_VERSION,
  ExecutionSurfaceError,
  matchExecutionSurface,
  validateRequirement,
  validateSnapshot,
};