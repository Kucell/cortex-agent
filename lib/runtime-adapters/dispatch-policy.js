"use strict";

// ─── Dispatch Policy & Controlled-automation Evaluation (MS-012 / P-004) ────
//
// This module is the auditable scoring layer that augments a dispatch plan
// with reliability / cost / latency inputs, source attribution, and
// measurement quality. It is **never** an authority to act: the policy
// evaluation returns a recommendation only. Authority remains with the
// existing owner via the dispatch module.
//
// Safety contract:
//   * Controlled automation is DISABLED by default. `options.enabled` MUST
//     be explicitly true to compute a score.
//   * Score is advisory; callers cannot use it to skip the tool gate.
//   * Unknown values stay neutral (no synthetic guessing).
//   * Inputs MUST declare `source` and `quality` so the audit log shows
//     where every number came from.

const { matchExecutionSurface, ExecutionSurfaceError } = require("./execution-surface-matcher");

const SCHEMA_VERSION = "1.0";
const ALLOWED_SOURCES = Object.freeze(["unavailable", "explicit-workflow", "host-api", "static-analysis", "self-reported", "extension-api"]);
const ALLOWED_QUALITIES = Object.freeze(["unavailable", "low", "medium", "high"]);
const ALLOWED_AUTOMATION_LEVELS = Object.freeze(["disabled", "advisory", "restricted", "full"]);

class DispatchPolicyError extends Error {
  constructor(code, details) {
    super(`[dispatch-policy:${code}] ${JSON.stringify(details || {})}`);
    this.name = "DispatchPolicyError";
    this.code = code;
    this.details = details || {};
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DispatchPolicyError("ERR_FIELD_INVALID", { where });
  }
  return value;
}

function validateMetric(input, where, { min = -Infinity, max = Infinity } = {}) {
  if (!plain(input)) throw new DispatchPolicyError("ERR_METRIC_INVALID", { where });
  if (!ALLOWED_SOURCES.includes(input.source)) {
    throw new DispatchPolicyError("ERR_METRIC_SOURCE_INVALID", { where, value: input.source });
  }
  if (!ALLOWED_QUALITIES.includes(input.quality)) {
    throw new DispatchPolicyError("ERR_METRIC_QUALITY_INVALID", { where, value: input.quality });
  }
  if (input.value !== null && input.value !== "unknown") {
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
      throw new DispatchPolicyError("ERR_METRIC_VALUE_INVALID", { where });
    }
    if (input.value < min || input.value > max) {
      throw new DispatchPolicyError("ERR_METRIC_VALUE_OUT_OF_RANGE", { where, min, max });
    }
  }
  return Object.freeze({
    value: input.value,
    source: input.source,
    quality: input.quality,
  });
}

function neutralMetric() {
  return Object.freeze({ value: null, source: "unavailable", quality: "unavailable" });
}

function evaluate(requirement, snapshots, options) {
  if (!options || typeof options !== "object") {
    throw new DispatchPolicyError("ERR_OPTIONS_REQUIRED", {});
  }
  if (typeof options.now !== "string") {
    throw new DispatchPolicyError("ERR_OPTIONS_NOW_REQUIRED", {});
  }
  const enabled = options.enabled === true; // explicit opt-in only
  const requestedLevel = options.automationLevel || "disabled";
  if (!ALLOWED_AUTOMATION_LEVELS.includes(requestedLevel)) {
    throw new DispatchPolicyError("ERR_AUTOMATION_LEVEL_UNKNOWN", { value: requestedLevel });
  }
  if (requestedLevel !== "disabled" && !enabled) {
    throw new DispatchPolicyError("ERR_AUTOMATION_REQUIRES_ENABLED", { requested: requestedLevel });
  }

  const plan = matchExecutionSurface(requirement, snapshots, { now: options.now });
  const evaluations = plan.candidates.map((candidate) => {
    const candidateMetrics = candidate.metrics || {};
    const reliability = plain(candidateMetrics.reliability) ? validateMetric(candidateMetrics.reliability, "candidate.reliability", { min: 0, max: 1 }) : neutralMetric();
    const cost = plain(candidateMetrics.cost) ? validateMetric(candidateMetrics.cost, "candidate.cost", { min: 0, max: 1_000_000 }) : neutralMetric();
    const latency = plain(candidateMetrics.latency) ? validateMetric(candidateMetrics.latency, "candidate.latency", { min: 0, max: 1_000_000 }) : neutralMetric();

    let policyScore = 0;
    let known = 0;
    if (reliability.value !== null && reliability.value !== "unknown") {
      policyScore += Number(reliability.value) * 0.5;
      known += 0.5;
    }
    if (cost.value !== null && cost.value !== "unknown") {
      policyScore += Math.max(0, 1 - (Number(cost.value) / 1.0)) * 0.3;
      known += 0.3;
    }
    if (latency.value !== null && latency.value !== "unknown") {
      policyScore += Math.max(0, 1 - (Number(latency.value) / 1000)) * 0.2;
      known += 0.2;
    }
    if (known === 0) policyScore = 0;
    else policyScore = Math.round((policyScore / known) * 1000) / 1000;

    return Object.freeze({
      host_profile_ref: candidate.host_profile_ref,
      hard_pass: candidate.hard_pass,
      policy_score: policyScore,
      recommendation: recommendationFor(candidate, policyScore, enabled),
      metrics: Object.freeze({
        reliability,
        cost,
        latency,
      }),
    });
  });

  evaluations.sort((a, b) => {
    if (a.hard_pass !== b.hard_pass) return a.hard_pass ? -1 : 1;
    if (a.policy_score !== b.policy_score) return b.policy_score - a.policy_score;
    if (a.host_profile_ref < b.host_profile_ref) return -1;
    if (a.host_profile_ref > b.host_profile_ref) return 1;
    return 0;
  });

  const recommended = evaluations.find((e) => e.hard_pass) || null;

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    evaluation_id: `EVAL-${plan.plan_id}`,
    plan_id: plan.plan_id,
    evaluated_at: plan.created_at,
    enabled,
    automation_level: requestedLevel,
    automation_effective: enabled && requestedLevel !== "disabled" ? requestedLevel : "disabled",
    candidates: Object.freeze(evaluations),
    recommended: recommended ? Object.freeze({
      host_profile_ref: recommended.host_profile_ref,
      policy_score: recommended.policy_score,
      advisory_only: true,
    }) : null,
    authorization_decision: Object.freeze({
      authorized: false,
      reason: "policy score is advisory only; the existing tool gate and Decision/Waitpoint chain remain the authorization surface",
    }),
  });
}

function recommendationFor(candidate, score, enabled) {
  if (!candidate.hard_pass) return "rejected_by_hard_filter";
  if (!enabled) return "advisory_only_automation_disabled";
  if (score >= 0.7) return "policy_preferred";
  if (score >= 0.4) return "policy_acceptable";
  return "policy_discouraged";
}

function isRecommendation(policy) {
  if (!policy || typeof policy !== "object") return false;
  return policy.authorization_decision && policy.authorization_decision.authorized === false;
}

module.exports = {
  ALLOWED_AUTOMATION_LEVELS,
  ALLOWED_QUALITIES,
  ALLOWED_SOURCES,
  DispatchPolicyError,
  SCHEMA_VERSION,
  evaluate,
  isRecommendation,
  validateMetric,
};