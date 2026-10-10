"use strict";

// v1.16 MS-001: provider-neutral advisory contracts. These structures do not
// create Tasks, invoke a Host, grant write permissions, or approve releases.
const { validateCapabilityList } = require("./capabilities");

const EVOLUTION_SCHEMA_VERSION = "1";
const EVIDENCE_KINDS = Object.freeze([
  "runtime_event", "test_result", "session_archive", "self_check", "explicit_feedback",
]);
const RISK_TIERS = Object.freeze(["low", "medium", "high", "critical"]);
const REASONING_CAPABILITIES = Object.freeze([
  "runtime.discover", "runtime.health", "runtime.run.create",
  "runtime.run.status", "runtime.run.wait", "runtime.timeline.read",
]);

class EvolutionContractError extends Error {
  constructor(code, details = {}) {
    super("[cortex-evolution:" + code + "] " + JSON.stringify(details));
    this.name = "EvolutionContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, field) {
  throw new EvolutionContractError(code, { field });
}

function object(input, fields, where) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERR_EVOLUTION_SHAPE", where);
  }
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) {
      fail("ERR_EVOLUTION_FIELD_UNKNOWN", where + "." + key);
    }
  }
  return input;
}

function text(value, where, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    fail("ERR_EVOLUTION_FIELD_INVALID", where);
  }
  return value.trim();
}

function identity(value, where) {
  const raw = text(value, where, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw) || raw.includes("..")) {
    fail("ERR_EVOLUTION_ID_INVALID", where);
  }
  return raw;
}

function projectRef(value) {
  const raw = text(value, "project_ref", 136);
  if (!/^project:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) || raw.includes("..")) {
    fail("ERR_EVOLUTION_PROJECT_REF", "project_ref");
  }
  return raw;
}

function evidenceRef(value, where) {
  const raw = text(value, where, 192);
  if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(raw)
    || raw.includes("..") || raw.includes("//") || raw.includes("://")) {
    fail("ERR_EVOLUTION_EVIDENCE_REF", where);
  }
  return raw;
}

function unique(input, where, normalize, min = 1, max = 32) {
  if (!Array.isArray(input) || input.length < min || input.length > max) {
    fail("ERR_EVOLUTION_LIST_INVALID", where);
  }
  const out = input.map((value, i) => normalize(value, where + "[" + i + "]"));
  if (new Set(out).size !== out.length) {
    fail("ERR_EVOLUTION_DUPLICATE", where);
  }
  return Object.freeze(out);
}

function isoDate(value, where) {
  const raw = text(value, where, 40);
  const ms = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(ms) || new Date(ms).toISOString() !== raw) {
    fail("ERR_EVOLUTION_TIMESTAMP", where);
  }
  return raw;
}

function normalizeEvidenceBundle(input) {
  object(input, ["schema_version", "project_ref", "source_revision", "scope", "observations", "promotion_consent"], "bundle");
  if (input.schema_version !== EVOLUTION_SCHEMA_VERSION) fail("ERR_EVOLUTION_SCHEMA_VERSION", "bundle.schema_version");
  const scope = input.scope;
  if (scope !== "project" && scope !== "framework_candidate") fail("ERR_EVOLUTION_SCOPE", "bundle.scope");
  if (scope === "framework_candidate" && input.promotion_consent == null) {
    fail("ERR_EVOLUTION_CONSENT_REQUIRED", "bundle.promotion_consent");
  }
  if (scope === "project" && input.promotion_consent != null) {
    fail("ERR_EVOLUTION_UNEXPECTED_CONSENT", "bundle.promotion_consent");
  }
  let consent = null;
  if (input.promotion_consent != null) {
    const c = object(input.promotion_consent, ["consent_ref", "purpose", "source_revision"], "promotion_consent");
    if (c.purpose !== "generic_summary") fail("ERR_EVOLUTION_CONSENT_PURPOSE", "promotion_consent.purpose");
    if (identity(c.source_revision, "promotion_consent.source_revision") !== input.source_revision) {
      fail("ERR_EVOLUTION_STALE_CONSENT", "promotion_consent.source_revision");
    }
    consent = Object.freeze({
      consent_ref: evidenceRef(c.consent_ref, "promotion_consent.consent_ref"),
      purpose: c.purpose,
      source_revision: c.source_revision,
    });
  }
  const observations = unique(input.observations, "bundle.observations", (value, where) => {
    object(value, ["kind", "evidence_ref", "observed_at", "redacted"], where);
    if (!EVIDENCE_KINDS.includes(value.kind)) fail("ERR_EVOLUTION_EVIDENCE_KIND", where + ".kind");
    if (value.redacted !== true) fail("ERR_EVOLUTION_UNREDACTED", where + ".redacted");
    return Object.freeze({
      kind: value.kind,
      evidence_ref: evidenceRef(value.evidence_ref, where + ".evidence_ref"),
      observed_at: isoDate(value.observed_at, where + ".observed_at"),
      redacted: true,
    });
  }, 1, 64);
  const refs = observations.map((o) => o.evidence_ref);
  if (new Set(refs).size !== refs.length) fail("ERR_EVOLUTION_DUPLICATE", "bundle.observations.evidence_ref");
  return Object.freeze({
    schema_version: EVOLUTION_SCHEMA_VERSION,
    project_ref: projectRef(input.project_ref),
    source_revision: identity(input.source_revision, "bundle.source_revision"),
    scope,
    observations,
    promotion_consent: consent,
  });
}

function normalizeEvolutionCandidate(input, bundleInput) {
  const bundle = normalizeEvidenceBundle(bundleInput);
  object(input, ["schema_version", "candidate_id", "project_ref", "source_revision", "scope", "hypothesis", "risk_tier", "evidence_refs"], "candidate");
  if (input.schema_version !== EVOLUTION_SCHEMA_VERSION) fail("ERR_EVOLUTION_SCHEMA_VERSION", "candidate.schema_version");
  if (projectRef(input.project_ref) !== bundle.project_ref || input.scope !== bundle.scope) {
    fail("ERR_EVOLUTION_SCOPE_MISMATCH", "candidate.project_ref/scope");
  }
  if (identity(input.source_revision, "candidate.source_revision") !== bundle.source_revision) {
    fail("ERR_EVOLUTION_STALE_REVISION", "candidate.source_revision");
  }
  const refs = unique(input.evidence_refs, "candidate.evidence_refs", evidenceRef);
  const allowedRefs = new Set(bundle.observations.map((o) => o.evidence_ref));
  if (refs.some((ref) => !allowedRefs.has(ref))) fail("ERR_EVOLUTION_EVIDENCE_OUT_OF_SCOPE", "candidate.evidence_refs");
  // Candidates are advisory. Risk defaults to Medium; downgrades need a separate governance decision.
  if (input.risk_tier != null && !["medium", "high", "critical"].includes(input.risk_tier)) {
    fail("ERR_EVOLUTION_RISK_ESCALATION_REQUIRED", "candidate.risk_tier");
  }
  return Object.freeze({
    schema_version: EVOLUTION_SCHEMA_VERSION,
    candidate_id: identity(input.candidate_id, "candidate.candidate_id"),
    project_ref: bundle.project_ref,
    source_revision: bundle.source_revision,
    scope: bundle.scope,
    hypothesis: text(input.hypothesis, "candidate.hypothesis", 512),
    risk_tier: input.risk_tier || "medium",
    evidence_refs: refs,
  });
}

function createReasoningHandoff(input, candidateInput, bundleInput) {
  const candidate = normalizeEvolutionCandidate(candidateInput, bundleInput);
  object(input, ["host_ref", "host_capabilities", "required_capabilities", "budget"], "handoff_request");
  const host = text(input.host_ref, "host_ref", 136);
  if (!/^host:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) fail("ERR_EVOLUTION_HOST_REF", "host_ref");
  const required = validateCapabilityList(input.required_capabilities);
  if (required.length < 1 || required.some((value) => !REASONING_CAPABILITIES.includes(value))) {
    fail("ERR_EVOLUTION_CAPABILITY_UNSAFE", "required_capabilities");
  }
  const available = validateCapabilityList(input.host_capabilities);
  if (required.some((value) => !available.includes(value))) {
    fail("ERR_EVOLUTION_CAPABILITY_MISSING", "host_capabilities");
  }
  const b = object(input.budget, ["max_output_tokens", "timeout_ms"], "budget");
  if (!Number.isSafeInteger(b.max_output_tokens) || b.max_output_tokens < 1 || b.max_output_tokens > 32768
    || !Number.isSafeInteger(b.timeout_ms) || b.timeout_ms < 1000 || b.timeout_ms > 600000) {
    fail("ERR_EVOLUTION_BUDGET", "budget");
  }
  return Object.freeze({
    schema_version: EVOLUTION_SCHEMA_VERSION,
    mode: "analysis_only",
    project_ref: candidate.project_ref,
    source_revision: candidate.source_revision,
    candidate_id: candidate.candidate_id,
    host_ref: host,
    required_capabilities: Object.freeze(required.slice()),
    evidence_refs: candidate.evidence_refs,
    budget: Object.freeze({ max_output_tokens: b.max_output_tokens, timeout_ms: b.timeout_ms }),
    allowed_effects: Object.freeze([]),
    stop_conditions: Object.freeze(["approval_required", "stale_revision", "scope_mismatch", "budget_exhausted"]),
  });
}

function normalizeEvolutionOutcome(input, candidateInput, bundleInput) {
  const candidate = normalizeEvolutionCandidate(candidateInput, bundleInput);
  object(input, ["schema_version", "project_ref", "candidate_id", "task_id", "run_ref", "verification_status", "verification_refs", "decision_id", "waitpoint_id"], "outcome");
  if (input.schema_version !== EVOLUTION_SCHEMA_VERSION) fail("ERR_EVOLUTION_SCHEMA_VERSION", "outcome.schema_version");
  if (projectRef(input.project_ref) !== candidate.project_ref || input.candidate_id !== candidate.candidate_id) {
    fail("ERR_EVOLUTION_SCOPE_MISMATCH", "outcome.candidate_id/project_ref");
  }
  const status = input.verification_status;
  if (!["not_run", "passed", "failed", "blocked"].includes(status)) {
    fail("ERR_EVOLUTION_VERIFICATION_STATUS", "outcome.verification_status");
  }
  const refs = unique(input.verification_refs, "outcome.verification_refs", evidenceRef, status === "not_run" ? 0 : 1);
  if (status === "not_run" && refs.length) fail("ERR_EVOLUTION_UNEXPECTED_VERIFICATION", "outcome.verification_refs");
  const runRef = text(input.run_ref, "outcome.run_ref", 136);
  if (!/^run:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runRef)) fail("ERR_EVOLUTION_RUN_REF", "outcome.run_ref");
  // These are references to existing authority, never approval claims.
  return Object.freeze({
    schema_version: EVOLUTION_SCHEMA_VERSION,
    project_ref: candidate.project_ref,
    candidate_id: candidate.candidate_id,
    task_id: identity(input.task_id, "outcome.task_id"),
    run_ref: runRef,
    verification_status: status,
    verification_refs: refs,
    decision_id: input.decision_id == null ? null : identity(input.decision_id, "outcome.decision_id"),
    waitpoint_id: input.waitpoint_id == null ? null : identity(input.waitpoint_id, "outcome.waitpoint_id"),
  });
}

module.exports = {
  EVOLUTION_SCHEMA_VERSION,
  EVIDENCE_KINDS,
  RISK_TIERS,
  REASONING_CAPABILITIES,
  EvolutionContractError,
  normalizeEvidenceBundle,
  normalizeEvolutionCandidate,
  createReasoningHandoff,
  normalizeEvolutionOutcome,
};
