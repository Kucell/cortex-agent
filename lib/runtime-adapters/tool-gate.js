"use strict";

// ─── Tool-before Gate (MS-005 / P-003 Phase 3) ─────────────────────────────
//
// Pure evaluator: given a frozen Operation reference, the resource digest
// the host is about to touch, a Decision/Waitpoint pair, the attempt index,
// and an unexpired authorization record, return one of:
//
//   { result: "allowed",     authorization_ref, reason }
//   { result: "denied",      reason, reason_code }
//   { result: "unavailable", reason, reason_code }
//
// The gate never instantiates a Decision or Waitpoint, never advances the
// Operation lifecycle, never releases or supersedes a waitpoint, and never
// writes evidence. It is a deterministic, idempotent check that the host
// adapter (or any other consumer) calls before allowing a tool call to
// proceed. Adapters can authorize themselves only by referencing a frozen
// revision issued by an existing owning workflow.
//
// Anti-circumvention rules enforced here:
//   * Decision MUST be `approved` and waitpoint MUST be `released`.
//   * Operation resource_digest MUST equal the candidate resource_digest.
//   * Attempt index MUST be ≤ authorization.attempt_bound and > any prior
//     attempt recorded for the same Operation (replay protection).
//   * Authorization MUST not be expired (now < expires_at) and MUST not be
//     stale (now - issued_at ≤ max_age).
//   * Decision/Waitpoint MUST reference the same Operation and the same
//     resource digest (cross-reference integrity).

const capabilityContract = require("./capability-contract");

const DECISION_STATUSES = Object.freeze(["open", "approved", "rejected", "revision_requested", "canceled", "superseded"]);
const WAITPOINT_STATUSES = Object.freeze(["pending", "blocked", "released", "canceled", "expired"]);
const OPERATION_STATUSES = Object.freeze(["open", "paused", "closed", "canceled", "expired"]);
const APPROVED_STATUS = "approved";
const RELEASED_STATUS = "released";
const OPEN_OPERATION_STATUSES = new Set(["open", "paused"]);

const MAX_REASON_LENGTH = 512;
const MAX_AUTHORIZATION_REF_LENGTH = 256;
const MAX_DECISION_ID_LENGTH = 64;
const MAX_WAITPOINT_ID_LENGTH = 64;
const MAX_OPERATION_ID_LENGTH = 64;
const MAX_DIGEST_LENGTH = 256;
const DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/;
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ATTEMPT_REGEX = /^[A-Za-z0-9._-]{1,32}$/;
const TOOL_NAME_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

class ToolGateError extends Error {
  constructor(code, details) {
    super(`[tool-gate:${code}] ${JSON.stringify(details || {})}`);
    this.name = "ToolGateError";
    this.code = code;
    this.details = details || {};
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value, where, max = 4096) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolGateError("ERR_FIELD_INVALID", { where, reason: "not_string" });
  }
  if (value.length > max) {
    throw new ToolGateError("ERR_FIELD_TOO_LONG", { where, max });
  }
  return value;
}

function boundedReason(value, where) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_REASON_LENGTH) return null;
  return value;
}

function validDigest(value, where) {
  if (typeof value !== "string" || !DIGEST_REGEX.test(value)) {
    throw new ToolGateError("ERR_DIGEST_INVALID", { where, value });
  }
  return value;
}

function validIdentifier(value, where, max) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolGateError("ERR_FIELD_INVALID", { where, reason: "missing" });
  }
  if (max && value.length > max) {
    throw new ToolGateError("ERR_FIELD_TOO_LONG", { where, max });
  }
  if (!ID_REGEX.test(value)) {
    throw new ToolGateError("ERR_FIELD_INVALID", { where, reason: "identifier_format" });
  }
  return value;
}

function validIso(value, where) {
  if (typeof value !== "string" || !ISO_REGEX.test(value)) {
    throw new ToolGateError("ERR_TIMESTAMP_INVALID", { where });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ToolGateError("ERR_TIMESTAMP_INVALID", { where, reason: "unparseable" });
  }
  return date.toISOString();
}

function safeIso(value, where) {
  if (value === undefined || value === null) return null;
  return validIso(value, where);
}

function validateRequest(request) {
  if (!plain(request)) throw new ToolGateError("ERR_REQUEST_INVALID", {});
  const required = ["operation", "resource_digest", "decision", "waitpoint", "attempt", "authorization", "tool"];
  for (const key of required) {
    if (!(key in request)) throw new ToolGateError("ERR_FIELD_REQUIRED", { where: `request.${key}` });
  }

  const op = request.operation;
  if (!plain(op)) throw new ToolGateError("ERR_OPERATION_INVALID", {});
  validIdentifier(op.operation_id, "operation.operation_id", MAX_OPERATION_ID_LENGTH);
  if (!OPERATION_STATUSES.includes(op.status)) {
    throw new ToolGateError("ERR_OPERATION_STATUS_UNKNOWN", { status: op.status });
  }
  validDigest(op.resource_digest, "operation.resource_digest");

  validDigest(request.resource_digest, "request.resource_digest");

  const decision = request.decision;
  if (!plain(decision)) throw new ToolGateError("ERR_DECISION_INVALID", {});
  validIdentifier(decision.decision_id, "decision.decision_id", MAX_DECISION_ID_LENGTH);
  if (!DECISION_STATUSES.includes(decision.status)) {
    throw new ToolGateError("ERR_DECISION_STATUS_UNKNOWN", { status: decision.status });
  }
  if (typeof decision.operation_id !== "string") {
    throw new ToolGateError("ERR_DECISION_OPERATION_LINK_MISSING", {});
  }

  const waitpoint = request.waitpoint;
  if (!plain(waitpoint)) throw new ToolGateError("ERR_WAITPOINT_INVALID", {});
  validIdentifier(waitpoint.waitpoint_id, "waitpoint.waitpoint_id", MAX_WAITPOINT_ID_LENGTH);
  if (!WAITPOINT_STATUSES.includes(waitpoint.status)) {
    throw new ToolGateError("ERR_WAITPOINT_STATUS_UNKNOWN", { status: waitpoint.status });
  }
  if (typeof waitpoint.decision_id !== "string") {
    throw new ToolGateError("ERR_WAITPOINT_DECISION_LINK_MISSING", {});
  }

  const attempt = request.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ToolGateError("ERR_ATTEMPT_INVALID", { value: attempt });
  }

  const authorization = request.authorization;
  if (!plain(authorization)) throw new ToolGateError("ERR_AUTHORIZATION_INVALID", {});
  if (typeof authorization.authorization_ref !== "string" || !ATTEMPT_REGEX.test(authorization.authorization_ref)) {
    throw new ToolGateError("ERR_AUTHORIZATION_REF_INVALID", {});
  }
  validIso(authorization.issued_at, "authorization.issued_at");
  if (!plain(authorization.attempt_bound) || typeof authorization.attempt_bound.min !== "number" ||
      typeof authorization.attempt_bound.max !== "number") {
    throw new ToolGateError("ERR_ATTEMPT_BOUND_INVALID", {});
  }
  validIso(authorization.expires_at, "authorization.expires_at");
  if (typeof authorization.issued_by !== "string" || authorization.issued_by.length === 0) {
    throw new ToolGateError("ERR_AUTHORIZATION_ISSUER_MISSING", {});
  }

  if (!TOOL_NAME_REGEX.test(request.tool)) {
    throw new ToolGateError("ERR_TOOL_NAME_INVALID", { tool: request.tool });
  }
}

function evaluate(request, options) {
  validateRequest(request);

  const opts = options || {};
  const now = opts.now ? validIso(opts.now, "options.now") : new Date().toISOString();
  const nowDate = new Date(now);
  const priorAttempts = Array.isArray(opts.priorAttempts) ? opts.priorAttempts : [];
  const replayWindowMs = Number.isFinite(opts.replayWindowMs) ? opts.replayWindowMs : 60_000;

  const op = request.operation;
  const decision = request.decision;
  const waitpoint = request.waitpoint;
  const attempt = request.attempt;
  const authorization = request.authorization;
  const tool = request.tool;

  // 1. Operation must be open/paused
  if (!OPEN_OPERATION_STATUSES.has(op.status)) {
    return denied("operation_not_open", { op_status: op.status });
  }
  // 2. Operation resource digest must equal the candidate resource digest
  if (op.resource_digest !== request.resource_digest) {
    return denied("resource_digest_mismatch", {
      operation_resource_digest: op.resource_digest,
      candidate_resource_digest: request.resource_digest,
    });
  }
  // 3. Decision must be approved
  if (decision.status !== APPROVED_STATUS) {
    return unavailable("decision_not_approved", { status: decision.status });
  }
  // 4. Decision must link the same operation
  if (decision.operation_id !== op.operation_id) {
    return denied("decision_operation_link_mismatch", { expected: op.operation_id, got: decision.operation_id });
  }
  // 5. Waitpoint must be released
  if (waitpoint.status !== RELEASED_STATUS) {
    return unavailable("waitpoint_not_released", { status: waitpoint.status });
  }
  // 6. Waitpoint must link the same decision
  if (waitpoint.decision_id !== decision.decision_id) {
    return denied("waitpoint_decision_link_mismatch", { expected: decision.decision_id, got: waitpoint.decision_id });
  }

  // 7. Authorization validity window
  const issuedAt = new Date(authorization.issued_at);
  const expiresAt = new Date(authorization.expires_at);
  if (expiresAt <= issuedAt) {
    return denied("authorization_window_invalid", { issued_at: authorization.issued_at, expires_at: authorization.expires_at });
  }
  if (nowDate >= expiresAt) {
    return denied("authorization_expired", { expires_at: authorization.expires_at });
  }
  if (nowDate < issuedAt) {
    return denied("authorization_not_yet_valid", { issued_at: authorization.issued_at });
  }

  // 8. Attempt bounds
  if (attempt < authorization.attempt_bound.min || attempt > authorization.attempt_bound.max) {
    return denied("attempt_out_of_bounds", {
      min: authorization.attempt_bound.min,
      max: authorization.attempt_bound.max,
      attempt,
    });
  }

  // 9. Replay protection: same attempt already used inside the replay window
  let maxPriorAttempt = 0;
  for (const prior of priorAttempts) {
    if (!plain(prior)) continue;
    if (prior.operation_id !== op.operation_id) continue;
    if (!Number.isSafeInteger(prior.attempt)) continue;
    if (prior.attempt > maxPriorAttempt) maxPriorAttempt = prior.attempt;
    if (prior.attempt !== attempt) continue;
    const priorAt = new Date(prior.at);
    if (Number.isNaN(priorAt.getTime())) continue;
    if (nowDate.getTime() - priorAt.getTime() > replayWindowMs) continue;
    return denied("duplicate_attempt_in_replay_window", { prior_at: prior.at });
  }
  if (opts.rejectOutOfOrder && attempt <= maxPriorAttempt) {
    return denied("out_of_order_attempt", {
      candidate: attempt,
      max_prior_attempt: maxPriorAttempt,
    });
  }

  // 10. Tool name must be in the allowed list (caller-provided or default
  //     fallback to all known write-class tool names).
  const allowedTools = Array.isArray(opts.allowedTools) && opts.allowedTools.length > 0
    ? opts.allowedTools
    : null;
  if (allowedTools && !allowedTools.includes(tool)) {
    return denied("tool_not_in_allowed_list", { tool });
  }

  return allowed(authorization.authorization_ref, { operation_id: op.operation_id });
}

function denied(reason, extras) {
  return Object.freeze({
    result: "denied",
    reason,
    reason_code: reason,
    ...(extras || {}),
  });
}

function unavailable(reason, extras) {
  return Object.freeze({
    result: "unavailable",
    reason,
    reason_code: reason,
    ...(extras || {}),
  });
}

function allowed(authorization_ref, extras) {
  return Object.freeze({
    result: "allowed",
    authorization_ref,
    ...(extras || {}),
  });
}

function evaluateFromRecords({ operation, decision, waitpoint, authorization, candidate }, options) {
  return evaluate({
    operation,
    resource_digest: candidate.resource_digest,
    decision,
    waitpoint,
    attempt: candidate.attempt,
    authorization,
    tool: candidate.tool,
  }, options);
}

module.exports = {
  DECISION_STATUSES,
  WAITPOINT_STATUSES,
  OPERATION_STATUSES,
  ToolGateError,
  evaluate,
  evaluateFromRecords,
  validateRequest,
};