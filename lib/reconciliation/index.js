"use strict";

const DISPOSITIONS = Object.freeze([
  "READY",
  "BLOCKED",
  "RECONCILIATION_REQUIRED",
  "DEGRADED",
]);

const OBSERVATION_STATUSES = Object.freeze([
  "observed",
  "unavailable",
  "unknown",
]);

const PRECEDENCE = Object.freeze({
  READY: 0,
  DEGRADED: 1,
  RECONCILIATION_REQUIRED: 2,
  BLOCKED: 3,
});

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function reconciliationError(code, details = {}) {
  const error = new Error("[reconciliation:" + code + "] " + JSON.stringify(details));
  error.code = code;
  error.details = details;
  return error;
}

function requiredString(value, where) {
  if (typeof value !== "string" || !value.trim()) {
    throw reconciliationError("ERR_RECONCILIATION_FIELD_INVALID", { where });
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeObservation(input) {
  if (!plain(input)) throw reconciliationError("ERR_RECONCILIATION_OBSERVATION_INVALID");
  const status = requiredString(input.status, "observation.status");
  if (!OBSERVATION_STATUSES.includes(status)) {
    throw reconciliationError("ERR_RECONCILIATION_OBSERVATION_STATUS", { status });
  }
  return Object.freeze({
    id: requiredString(input.id, "observation.id"),
    source: requiredString(input.source, "observation.source"),
    status,
    required: input.required === true,
    observed_at: optionalString(input.observed_at),
    value: input.value === undefined ? null : input.value,
    reason: optionalString(input.reason),
  });
}

function driftItem(input) {
  return Object.freeze({
    id: requiredString(input.id, "drift.id"),
    source: requiredString(input.source, "drift.source"),
    field: requiredString(input.field, "drift.field"),
    expected: input.expected === undefined ? null : input.expected,
    actual: input.actual === undefined ? null : input.actual,
    severity: input.severity || "blocking",
    remediation: optionalString(input.remediation),
  });
}

function gateItem(input) {
  return Object.freeze({
    id: requiredString(input.id, "gate.id"),
    type: requiredString(input.type, "gate.type"),
    status: requiredString(input.status, "gate.status"),
    resource_ref: optionalString(input.resource_ref),
    reason: optionalString(input.reason),
  });
}

function compareRevision(drift, id, source, field, expected, actual, remediation) {
  if (expected == null || actual == null) return;
  if (String(expected) === String(actual)) return;
  drift.push(driftItem({
    id,
    source,
    field,
    expected,
    actual,
    severity: "blocking",
    remediation,
  }));
}

function evaluateObservation(observation, warnings, gates) {
  if (observation.status === "observed") return;
  if (observation.required) {
    gates.push(gateItem({
      id: "observation:" + observation.id,
      type: "observation",
      status: "blocked",
      reason: observation.reason || ("required observation " + observation.status),
    }));
    return;
  }
  warnings.push(Object.freeze({
    id: "observation:" + observation.id,
    source: observation.source,
    severity: "degraded",
    reason: observation.reason || ("optional observation " + observation.status),
  }));
}

function evaluateChecks(checkObservation, gates) {
  if (!checkObservation || checkObservation.status !== "observed") return;
  const checks = Array.isArray(checkObservation.value) ? checkObservation.value : [];
  for (const check of checks) {
    if (!plain(check)) continue;
    const conclusion = optionalString(check.conclusion);
    const status = optionalString(check.status);
    if (conclusion && ["failure", "cancelled", "timed_out", "action_required"].includes(conclusion)) {
      gates.push(gateItem({
        id: "check:" + (check.id || check.name || "unknown"),
        type: "check",
        status: "blocked",
        resource_ref: optionalString(check.url),
        reason: "check conclusion: " + conclusion,
      }));
    } else if (status && ["failure", "failed"].includes(status)) {
      gates.push(gateItem({
        id: "check:" + (check.id || check.name || "unknown"),
        type: "check",
        status: "blocked",
        resource_ref: optionalString(check.url),
        reason: "check status: " + status,
      }));
    }
  }
}

function normalizeGovernanceGates(input = {}) {
  const gates = [];
  for (const decision of Array.isArray(input.decisions) ? input.decisions : []) {
    if (!decision || decision.status === "approved" || decision.status === "resolved") continue;
    gates.push(gateItem({
      id: "decision:" + (decision.decision_id || decision.id || "unknown"),
      type: "decision",
      status: "blocked",
      resource_ref: optionalString(decision.gate && decision.gate.resource_ref),
      reason: "decision not approved",
    }));
  }
  for (const waitpoint of Array.isArray(input.waitpoints) ? input.waitpoints : []) {
    if (!waitpoint || waitpoint.status === "released" || waitpoint.status === "closed") continue;
    gates.push(gateItem({
      id: "waitpoint:" + (waitpoint.waitpoint_id || waitpoint.id || "unknown"),
      type: "waitpoint",
      status: "blocked",
      reason: "waitpoint active",
    }));
  }
  for (const lock of Array.isArray(input.locks) ? input.locks : []) {
    if (!lock || lock.expired === true || lock.released === true) continue;
    if (input.actor_id && lock.held_by === input.actor_id) continue;
    gates.push(gateItem({
      id: "lock:" + (lock.scope || lock.lock_id || "unknown"),
      type: "lock",
      status: "blocked",
      resource_ref: optionalString(lock.scope),
      reason: "lock held by another actor",
    }));
  }
  return gates;
}

function determineDisposition({ drift, gates, warnings }) {
  if (gates.length > 0) return "BLOCKED";
  if (drift.length > 0) return "RECONCILIATION_REQUIRED";
  if (warnings.length > 0) return "DEGRADED";
  return "READY";
}

function reconcile(input) {
  if (!plain(input)) throw reconciliationError("ERR_RECONCILIATION_INPUT_INVALID");

  const observations = (Array.isArray(input.observations) ? input.observations : []).map(normalizeObservation);
  const warnings = [];
  const drift = [];
  const gates = normalizeGovernanceGates(input.governance || {});

  for (const observation of observations) {
    evaluateObservation(observation, warnings, gates);
  }

  const governanceSnapshot = input.governance_snapshot || {};
  if (governanceSnapshot.expected_revision != null && governanceSnapshot.actual_revision != null) {
    compareRevision(
      drift,
      "governance:revision",
      "governance",
      "revision",
      governanceSnapshot.expected_revision,
      governanceSnapshot.actual_revision,
      "reload governance snapshot before resuming",
    );
  }

  const workspace = input.workspace || {};
  const product = input.product || {};
  compareRevision(
    drift,
    "workspace:head",
    "workspace",
    "head_revision",
    workspace.head_revision,
    product.head_revision,
    "reconcile workspace expectation with observed product revision",
  );

  const changeRequest = input.change_request || {};
  compareRevision(
    drift,
    "change-request:revision",
    "change-request",
    "revision",
    workspace.head_revision,
    changeRequest.revision,
    "refresh or reconcile change request head revision",
  );

  const checkObservation = observations.find((item) => item.id === "checks");
  evaluateChecks(checkObservation, gates);

  const disposition = determineDisposition({ drift, gates, warnings });

  return Object.freeze({
    disposition,
    drift: Object.freeze(drift),
    gates: Object.freeze(gates),
    warnings: Object.freeze(warnings),
    observations: Object.freeze(observations),
    summary: Object.freeze({
      drift: drift.length,
      gates: gates.length,
      warnings: warnings.length,
      observations: observations.length,
    }),
  });
}

function canResume(result) {
  if (!result || !DISPOSITIONS.includes(result.disposition)) {
    throw reconciliationError("ERR_RECONCILIATION_RESULT_INVALID");
  }
  return result.disposition === "READY" || result.disposition === "DEGRADED";
}

module.exports = {
  DISPOSITIONS,
  OBSERVATION_STATUSES,
  PRECEDENCE,
  reconcile,
  canResume,
  normalizeObservation,
  driftItem,
  gateItem,
  determineDisposition,
};
