"use strict";

const {
  normalizeEvidenceBundle, normalizeEvolutionCandidate, createReasoningHandoff,
} = require("../../packages/protocol/src/evolution.js");
const { normalizeRuntimeEndpoint } = require("../../packages/runtime-port/src/topology.js");
const { PROTOCOL_CURRENT } = require("../../packages/protocol/src/version.js");

const REQUIRED = Object.freeze([
  "runtime.discover", "runtime.health", "runtime.run.create",
  "runtime.run.status", "runtime.run.wait", "runtime.run.cancel",
]);
const RISK = Object.freeze({ medium: 1, high: 2, critical: 3 });

function error(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const part of Object.values(value)) freeze(part);
    Object.freeze(value);
  }
  return value;
}
function utc(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) throw error("ERR_REASONING_TIME");
  return Date.parse(value);
}
function scoped(input) {
  const bundle = normalizeEvidenceBundle(input.bundle);
  const candidate = normalizeEvolutionCandidate(input.candidate, input.bundle);
  if (bundle.scope !== "project") {
    throw error("ERR_REASONING_PROMOTION_REQUIRES_SEPARATE_WORKFLOW");
  }
  if (input.expected_project_ref !== candidate.project_ref
      || input.expected_source_revision !== candidate.source_revision) {
    throw error("ERR_REASONING_CURRENT_SCOPE_MISMATCH");
  }
  return { bundle, candidate };
}

/**
 * Pure preparation from observations. Never calls RuntimePort or creates a Run.
 * A fresh endpoint observation is not authority or proof of an AI Host.
 * The owning workflow must re-read current authority before any runtime effect.
 */
function prepareReasoningHandoff(input = {}) {
  const { bundle, candidate } = scoped(input);
  const now = utc(input.now);
  const ttl = input.max_age_seconds == null ? 300 : input.max_age_seconds;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw error("ERR_REASONING_TTL");
  for (const observation of bundle.observations) {
    const at = utc(observation.observed_at);
    if (at > now || now - at > ttl * 1000) throw error("ERR_REASONING_STALE_EVIDENCE");
  }
  const receipt = (status, reasons, handoff = null) => freeze({
    status, reason_codes: reasons, project_ref: candidate.project_ref,
    source_revision: candidate.source_revision, candidate_id: candidate.candidate_id,
    handoff, run_ref: null, execution_authorized: false, allowed_effects: [],
  });
  if (input.endpoint == null) return receipt("DEFERRED", ["host_not_observed"]);
  const endpoint = normalizeRuntimeEndpoint(input.endpoint);
  if (endpoint.descriptor.protocol_version.split(".")[0]
      !== PROTOCOL_CURRENT["cortex-runtime"].split(".")[0]) {
    return receipt("DEFERRED", ["host_protocol_incompatible"]);
  }
  const hostAt = utc(input.host_observed_at);
  if (hostAt > now || now - hostAt > ttl * 1000) {
    return receipt("DEFERRED", ["host_observation_stale"]);
  }
  if (endpoint.availability !== "available") return receipt("DEFERRED", ["host_unavailable"]);
  const caps = endpoint.descriptor.capabilities;
  if (REQUIRED.some((capability) => !caps.includes(capability))) {
    return receipt("DEFERRED", ["host_capability_missing"]);
  }
  const handoff = createReasoningHandoff({
    host_ref: endpoint.host_ref, host_capabilities: caps,
    required_capabilities: REQUIRED, budget: input.budget,
  }, input.candidate, input.bundle);
  return receipt("HANDOFF_PREPARED", [], handoff);
}

function texts(value, field, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max
      || value.some((item) => typeof item !== "string" || !item.trim()
        || item.length > 512 || /[\r\n\0]/.test(item))) {
    throw error("ERR_REASONING_RESPONSE_" + field);
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) throw error("ERR_REASONING_RESPONSE_DUPLICATE");
  return normalized;
}

/**
 * Model output stays a project-local proposal. It cannot assert approval, Run
 * completion, tests passed, consent, authority, or permission to execute checks.
 */
function normalizeReasoningResponse(response, context = {}) {
  const { candidate } = scoped(context);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw error("ERR_REASONING_RESPONSE_SHAPE");
  }
  const fields = new Set([
    "schema_version", "project_ref", "source_revision", "candidate_id",
    "hypothesis", "risk_tier", "evidence_refs", "proposed_checks", "limitations",
  ]);
  for (const field of Object.keys(response)) {
    if (!fields.has(field)) throw error("ERR_REASONING_RESPONSE_FIELD");
  }
  if (response.schema_version !== "1"
      || response.project_ref !== candidate.project_ref
      || response.source_revision !== candidate.source_revision
      || response.candidate_id !== candidate.candidate_id) {
    throw error("ERR_REASONING_RESPONSE_SCOPE");
  }
  if (!Object.hasOwn(RISK, response.risk_tier)
      || RISK[response.risk_tier] < RISK[candidate.risk_tier]) {
    throw error("ERR_REASONING_RESPONSE_RISK_DOWNGRADE");
  }
  const proposal = normalizeEvolutionCandidate({
    schema_version: "1", candidate_id: candidate.candidate_id,
    project_ref: candidate.project_ref, source_revision: candidate.source_revision,
    scope: "project", hypothesis: response.hypothesis, risk_tier: response.risk_tier,
    evidence_refs: response.evidence_refs,
  }, context.bundle);
  if (proposal.evidence_refs.some((ref) => !candidate.evidence_refs.includes(ref))) {
    throw error("ERR_REASONING_RESPONSE_EVIDENCE_SCOPE");
  }
  return freeze({
    status: "PROPOSAL_ONLY", candidate: proposal,
    proposed_checks: texts(response.proposed_checks, "CHECKS", 1, 16),
    limitations: texts(response.limitations, "LIMITATIONS", 1, 16),
    execution_authorized: false, allowed_effects: [],
  });
}

module.exports = { prepareReasoningHandoff, normalizeReasoningResponse };
