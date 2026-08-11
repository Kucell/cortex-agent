"use strict";

// ─── Watchdog Notification (M-013 SP-005 / VC-006) ───────────────────────────
//
// Emits versioned watchdog diagnostics. Pure functions — callers feed
// reducer state + policy + observed event, this module produces the
// diagnostic record. No I/O; the caller is responsible for routing to
// Management API projection.
//
// Per P-005 §7.2 / §13: notifications carry only bounded metadata, never
// raw body / args / paths. The diagnostic schema is pinned to v1.

const SCHEMA_VERSION = "1.0";
const MAX_NOTIFICATIONS = 50; // bounded FIFO

const DIAGNOSTIC_CODES = Object.freeze({
  NO_PROGRESS_DETECTED: "no_progress_detected",
  STEER_ATTEMPTED: "steer_attempted",
  STEER_REJECTED: "steer_rejected",
  GRACE_EXPIRED: "grace_expired",
  COORDINATOR_NOTIFIED: "coordinator_notified",
  HEARTBEAT_LOST: "heartbeat_lost",
  STEER_IDEMPOTENCY_CONFLICT: "steer_idempotency_conflict",
});

const SEVERITIES = Object.freeze(["info", "warning", "error"]);

/**
 * Build a versioned diagnostic record.
 *
 * @param {object} input  - { code, taskId, attempt, attemptId, policy, detail }
 * @returns {object} frozen diagnostic record
 */
function buildDiagnostic(input) {
  if (!input || typeof input !== "object") {
    throw new Error("notification: input must be a non-null object");
  }
  if (!Object.values(DIAGNOSTIC_CODES).includes(input.code)) {
    throw new Error(
      `notification: code must be one of ${Object.values(DIAGNOSTIC_CODES).join("|")} (got ${JSON.stringify(input.code)})`
    );
  }
  if (!input.taskId || typeof input.taskId !== "string") {
    throw new Error("notification: taskId (string) is required");
  }
  if (typeof input.attempt !== "number" || input.attempt < 1) {
    throw new Error("notification: attempt must be a positive integer");
  }
  const severity = input.severity || defaultSeverityFor(input.code);
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`notification: severity must be one of ${SEVERITIES.join("|")}`);
  }

  const detail = input.detail && typeof input.detail === "object" ? input.detail : {};

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    timestamp: input.timestamp || new Date().toISOString(),
    code: input.code,
    severity,
    taskId: input.taskId,
    attempt: input.attempt,
    attemptId: input.attemptId || null,
    policy: input.policy || null,
    detail: Object.freeze({ ...detail }),
  });
}

/**
 * Append a diagnostic to an existing bounded list (FIFO eviction).
 *
 * @param {array} list    - existing diagnostics list (mutated)
 * @param {object} diag   - diagnostic from buildDiagnostic
 * @returns {array} new list reference (callers should not depend on identity)
 */
function appendDiagnostic(list, diag) {
  const base = Array.isArray(list) ? list : [];
  const merged = [...base, diag];
  if (merged.length <= MAX_NOTIFICATIONS) return merged;
  return merged.slice(-MAX_NOTIFICATIONS);
}

/**
 * Build a coordinator notification payload from a diagnostic. The payload
 * is the versioned envelope that flows through Management API projection.
 * Per P-005 §7.2: notify is the DEFAULT; this is a no-side-effect helper.
 */
function buildCoordinatorNotification(diag) {
  if (!diag || typeof diag !== "object") {
    throw new Error("notification: diagnostic must be a non-null object");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    timestamp: diag.timestamp,
    kind: "watchdog",
    code: diag.code,
    severity: diag.severity,
    taskId: diag.taskId,
    attempt: diag.attempt,
    attemptId: diag.attemptId,
    policyId: diag.policy?.policyId || null,
  });
}

function defaultSeverityFor(code) {
  switch (code) {
    case DIAGNOSTIC_CODES.NO_PROGRESS_DETECTED:
    case DIAGNOSTIC_CODES.HEARTBEAT_LOST:
    case DIAGNOSTIC_CODES.GRACE_EXPIRED:
      return "warning";
    case DIAGNOSTIC_CODES.STEER_REJECTED:
    case DIAGNOSTIC_CODES.STEER_IDEMPOTENCY_CONFLICT:
      return "warning";
    case DIAGNOSTIC_CODES.COORDINATOR_NOTIFIED:
      return "info";
    case DIAGNOSTIC_CODES.STEER_ATTEMPTED:
      return "info";
    default:
      return "info";
  }
}

module.exports = {
  buildDiagnostic,
  appendDiagnostic,
  buildCoordinatorNotification,
  DIAGNOSTIC_CODES,
  SEVERITIES,
  MAX_NOTIFICATIONS,
  SCHEMA_VERSION,
};