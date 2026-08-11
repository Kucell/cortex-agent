"use strict";

// ─── Watchdog State Machine (M-013 SP-005 / VC-006 / VC-006a..c) ────────────
//
// Pure deterministic watchdog state machine. Per P-005 §7.2:
//
//   observing
//     → productive evidence: continue
//     → threshold exceeded: no_progress_detected
//     → steer supported and approved: steer_once → grace
//     → recovered: continue
//     → not recovered: coordinator_notify
//     → policy explicitly permits: abort current attempt
//
// The watchdog is a *pure* function:
//
//   (currentWatchdogState, events, policy) → newWatchdogState
//
// Watchdog NEVER writes Task state directly. It emits diagnostics; the
// Application Service is the single-writer for Task transitions.

const crypto = require("node:crypto");
const { buildDiagnostic, appendDiagnostic, DIAGNOSTIC_CODES } = require("./notification.js");
const { getDefaultPolicy, validatePolicy } = require("./policy-loader.js");

const SCHEMA_VERSION = "1.0";

const STATES = Object.freeze({
  OBSERVING: "observing",
  NO_PROGRESS: "no_progress_detected",
  STEER_PENDING: "steer_pending",
  GRACE: "grace",
  NOTIFIED: "notified",
  ABORTED: "aborted",
  RECOVERED: "recovered",
});

// Terminal states — once entered, no further transitions occur.
const TERMINAL_STATES = new Set([STATES.NOTIFIED, STATES.ABORTED, STATES.RECOVERED]);

// ─── Public reducer ─────────────────────────────────────────────────────────

/**
 * Compute the next watchdog state.
 *
 * @param {object} state     - current watchdog state (or null for fresh)
 * @param {object} events    - { now, attemptState, idempotencyKey?, observedAt? }
 *                              attemptState = { taskId, attempt, evidenceLevel,
 *                                               lastActivityAt, lastProductiveAt,
 *                                               activity: {readOnlyToolCount,...} }
 * @param {object} policy    - validated policy (defaults to v1-default)
 * @returns {object} new watchdog state (frozen)
 */
function tick(state, events, policy = getDefaultPolicy()) {
  if (!events || typeof events !== "object") {
    throw new Error("watchdog: events must be a non-null object");
  }
  const safePolicy = policy ? validatePolicy(policy) : getDefaultPolicy();
  const prev = state || makeInitialState(safePolicy, events);

  const attemptState = events.attemptState || {};
  const now = events.now || new Date().toISOString();
  const taskId = attemptState.taskId || prev.taskId;
  const attempt = attemptState.attempt || prev.attempt;

  // Terminal states do not transition further.
  if (TERMINAL_STATES.has(prev.state)) {
    return Object.freeze({ ...prev });
  }

  // ─── Threshold detection ──────────────────────────────────────────────────
  const noProgress = detectNoProgress(attemptState, safePolicy, now, prev);
  const heartbeatLost = detectHeartbeatLost(attemptState, safePolicy, now);

  let nextState = prev.state;
  let diagnostics = prev.diagnostics || [];

  // ─── Recovery path: productive evidence while in GRACE → RECOVERED ───────
  if (prev.state === STATES.GRACE && hasProductiveEvidence(attemptState, prev)) {
    nextState = STATES.RECOVERED;
    const diag = buildDiagnostic({
      code: DIAGNOSTIC_CODES.NO_PROGRESS_DETECTED,
      taskId,
      attempt,
      timestamp: now,
      policy: { policyId: safePolicy.policyId },
      detail: { outcome: "recovered", graceRemainingMs: 0 },
      severity: "info",
    });
    diagnostics = appendDiagnostic(diagnostics, diag);
  }

  // ─── No-progress detection (transition OBSERVING → NO_PROGRESS) ───────────
  if (nextState === STATES.OBSERVING && noProgress) {
    nextState = STATES.NO_PROGRESS;
    const diag = buildDiagnostic({
      code: DIAGNOSTIC_CODES.NO_PROGRESS_DETECTED,
      taskId,
      attempt,
      timestamp: now,
      policy: { policyId: safePolicy.policyId },
      detail: {
        reason: noProgress.reason,
        readOnlyToolCount: attemptState.activity?.readOnlyToolCount || 0,
        msSinceProductive: noProgress.msSinceProductive,
      },
      severity: "warning",
    });
    diagnostics = appendDiagnostic(diagnostics, diag);
  }

  // ─── Heartbeat lost (independent diagnostic, does not change state) ────────
  if (heartbeatLost && nextState === STATES.OBSERVING) {
    const diag = buildDiagnostic({
      code: DIAGNOSTIC_CODES.HEARTBEAT_LOST,
      taskId,
      attempt,
      timestamp: now,
      policy: { policyId: safePolicy.policyId },
      detail: { msSinceLastActivity: heartbeatLost.msSinceLastActivity },
      severity: "warning",
    });
    diagnostics = appendDiagnostic(diagnostics, diag);
  }

  // ─── Steer attempt (NO_PROGRESS → STEER_PENDING → GRACE) ─────────────────
  let steerCount = prev.steerCount;
  let steerAttempts = prev.steerAttempts;
  let steerRejections = prev.steerRejections;
  let graceStartedAt = prev.graceStartedAt;

  // Steer attempts are processed in NO_PROGRESS, GRACE, and even after
  // NO_PROGRESS has already triggered NOTIFIED state — rejection diagnostics
  // must always fire so the caller can audit.
  if (nextState === STATES.NO_PROGRESS) {
    const steerAttempt = events.steerAttempt || null;
    if (steerAttempt) {
      const steerResult = attemptSteer(prev, steerAttempt, safePolicy, now, taskId, attempt, diagnostics);
      diagnostics = steerResult.diagnostics;
      if (steerResult.steerCount !== undefined) steerCount = steerResult.steerCount;
      if (steerResult.steerAttempts !== undefined) steerAttempts = steerResult.steerAttempts;
      if (steerResult.steerRejections !== undefined) steerRejections = steerResult.steerRejections;
      if (steerResult.graceStartedAt !== undefined) graceStartedAt = steerResult.graceStartedAt;
      nextState = steerResult.nextState;
    } else if (safePolicy.maxSteerAttempts === 0) {
      // Policy explicitly disables steer — go straight to NOTIFIED.
      nextState = STATES.NOTIFIED;
    }
  } else if (nextState === STATES.GRACE && events.steerAttempt) {
    // Re-steer attempt during GRACE — always rejected (cap or duplicate).
    const steerResult = attemptSteer(prev, events.steerAttempt, safePolicy, now, taskId, attempt, diagnostics);
    diagnostics = steerResult.diagnostics;
    if (steerResult.steerRejections !== undefined) steerRejections = steerResult.steerRejections;
  }

  // ─── Grace expiry → NOTIFIED or ABORTED ───────────────────────────────────
  if (nextState === STATES.GRACE) {
    const graceExpired = detectGraceExpired(prev, now, safePolicy);
    if (graceExpired) {
      nextState = safePolicy.onExhausted === "abort" ? STATES.ABORTED : STATES.NOTIFIED;
      const diag = buildDiagnostic({
        code: DIAGNOSTIC_CODES.GRACE_EXPIRED,
        taskId,
        attempt,
        timestamp: now,
        policy: { policyId: safePolicy.policyId },
        detail: { nextState },
        severity: "warning",
      });
      diagnostics = appendDiagnostic(diagnostics, diag);
    }
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    state: nextState,
    taskId,
    attempt,
    policyId: safePolicy.policyId,
    steerCount,
    steerAttempts,
    steerRejections,
    graceStartedAt: nextState === STATES.GRACE ? graceStartedAt || now : graceStartedAt,
    lastTickAt: now,
    diagnostics,
  });
}

/**
 * Compute a deterministic sha256 hash of the watchdog state. Stable across
 * runs (VC-006c — watchdog race conditions deterministic).
 */
function hashState(state) {
  const normalized = JSON.stringify(state, (key, value) => {
    if (key === "lastTickAt") return value; // timestamps preserved as-is
    return value;
  });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Reset the watchdog for a new attempt. Pure helper.
 */
function reset(state, events = {}, policy = getDefaultPolicy()) {
  return makeInitialState(policy, events);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeInitialState(policy, events = {}) {
  const attemptState = events.attemptState || {};
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    state: STATES.OBSERVING,
    taskId: attemptState.taskId || null,
    attempt: attemptState.attempt || 1,
    policyId: policy.policyId,
    steerCount: 0,
    steerAttempts: [],
    steerRejections: 0,
    graceStartedAt: null,
    lastTickAt: null,
    diagnostics: [],
  });
}

function detectNoProgress(attemptState, policy, now, prev) {
  // Rule 1: read-only action count exceeds threshold
  const readOnlyCount = attemptState.activity?.readOnlyToolCount || 0;
  if (readOnlyCount >= policy.maxReadOnlyActionsWithoutEvidence) {
    return {
      reason: "excessive_read_only",
      msSinceProductive: attemptState.lastProductiveAt
        ? Date.parse(now) - Date.parse(attemptState.lastProductiveAt)
        : null,
    };
  }

  // Rule 2: no productive evidence for too long
  if (!attemptState.lastProductiveAt) {
    // Never reached productive — check time since lastActivityAt
    if (attemptState.lastActivityAt) {
      const msSinceActivity = Date.parse(now) - Date.parse(attemptState.lastActivityAt);
      if (msSinceActivity >= policy.maxNoProductiveMs) {
        return { reason: "no_productive_ever", msSinceProductive: msSinceActivity };
      }
    }
    return null;
  }
  const msSinceProductive = Date.parse(now) - Date.parse(attemptState.lastProductiveAt);
  if (msSinceProductive >= policy.maxNoProductiveMs) {
    return { reason: "no_productive_timeout", msSinceProductive };
  }
  return null;
}

function detectHeartbeatLost(attemptState, policy, now) {
  if (!attemptState.lastActivityAt) return null;
  const ms = Date.parse(now) - Date.parse(attemptState.lastActivityAt);
  if (ms >= policy.maxNoHeartbeatMs) {
    return { msSinceLastActivity: ms };
  }
  return null;
}

function hasProductiveEvidence(attemptState, prev) {
  // Promote to recovered when lastProductiveAt timestamp moves forward OR
  // evidenceLevel reached productive/verified.
  const level = attemptState.evidenceLevel || "alive";
  return level === "productive" || level === "verified";
}

function detectGraceExpired(prev, now, policy) {
  if (!prev.graceStartedAt) return false;
  const ms = Date.parse(now) - Date.parse(prev.graceStartedAt);
  return ms >= policy.steerGraceMs;
}

function attemptSteer(prev, steerAttempt, policy, now, taskId, attempt, diagnostics) {
  const key = steerAttempt.idempotencyKey;
  if (!key || typeof key !== "string") {
    // Idempotency key required (P-005 §7.2 / VC-006b)
    const diag = buildDiagnostic({
      code: DIAGNOSTIC_CODES.STEER_REJECTED,
      taskId,
      attempt,
      timestamp: now,
      policy: { policyId: policy.policyId },
      detail: { reason: "missing_idempotency_key" },
      severity: "warning",
    });
    return {
      nextState: STATES.NO_PROGRESS,
      diagnostics: appendDiagnostic(diagnostics, diag),
    };
  }

  // Idempotency: same key already attempted → reject
  const existing = prev.steerAttempts.find((a) => a.idempotencyKey === key);
  if (existing) {
    const diag = buildDiagnostic({
      code: DIAGNOSTIC_CODES.STEER_IDEMPOTENCY_CONFLICT,
      taskId,
      attempt,
      timestamp: now,
      policy: { policyId: policy.policyId },
      detail: { idempotencyKey: key, firstAttemptedAt: existing.at },
      severity: "warning",
    });
    return {
      nextState: STATES.NO_PROGRESS,
      diagnostics: appendDiagnostic(diagnostics, diag),
      steerRejections: prev.steerRejections + 1,
    };
  }

  // Cap: max 1 per attempt (P-005 §7.2 bounded reason template)
  if (prev.steerCount >= policy.maxSteerAttempts) {
    const diag = buildDiagnostic({
      code: DIAGNOSTIC_CODES.STEER_REJECTED,
      taskId,
      attempt,
      timestamp: now,
      policy: { policyId: policy.policyId },
      detail: { reason: "max_steer_attempts_exceeded", count: prev.steerCount },
      severity: "warning",
    });
    return {
      nextState: STATES.NO_PROGRESS,
      diagnostics: appendDiagnostic(diagnostics, diag),
      steerRejections: prev.steerRejections + 1,
    };
  }

  // Steer accepted → enter GRACE
  const steerAttemptRecord = Object.freeze({
    idempotencyKey: key,
    at: now,
    reason: steerAttempt.reason || null,
  });
  const diag = buildDiagnostic({
    code: DIAGNOSTIC_CODES.STEER_ATTEMPTED,
    taskId,
    attempt,
    timestamp: now,
    policy: { policyId: policy.policyId },
    detail: { idempotencyKey: key, reason: steerAttempt.reason || null },
    severity: "info",
  });
  return {
    nextState: STATES.GRACE,
    diagnostics: appendDiagnostic(diagnostics, diag),
    steerCount: prev.steerCount + 1,
    steerAttempts: [...prev.steerAttempts, steerAttemptRecord],
    graceStartedAt: now,
  };
}

module.exports = {
  tick,
  hashState,
  reset,
  makeInitialState,
  STATES,
  TERMINAL_STATES,
  SCHEMA_VERSION,
};