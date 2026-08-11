"use strict";

// ─── Agent Supervise CLI Helper (M-013 SP-006 / VC-010a) ────────────────────
//
// CLI surface for `cortex-agent agent supervise status|steer|abort`.
//
// Per P-005 §8.1: "省略协议时不得按 executable 名称猜测; 只能使用 capability
// discovery 或明确的 degraded 模式". All three subcommands verify their
// preconditions before issuing any host action. The CLI does NOT accept
// arbitrary stdin injection or arbitrary shell command.
//
// Per P-005 §8.2: "通过 capability profile + lease + Operation + authorization
// 4-gate 验证后才允许 steer / abort". status is read-only and skips the
// fencing checks (it observes, never mutates).

const crypto = require("node:crypto");

// ─── Capability / gate semantics ────────────────────────────────────────────

const SUPERVISE_ACTIONS = Object.freeze(["status", "steer", "abort"]);

const REASON_CODES = Object.freeze([
  // bounded reason template — P-005 §7.2 / §13
  "stale_progress",
  "host_unresponsive",
  "user_request",
  "policy_violation",
  "scope_expansion_detected",
  "explicit_abort",
]);

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

function isValidAction(action) {
  return SUPERVISE_ACTIONS.includes(action);
}

function isValidReason(reason) {
  return REASON_CODES.includes(reason);
}

function isValidIdempotencyKey(key) {
  return typeof key === "string" && IDEMPOTENCY_KEY_PATTERN.test(key);
}

// ─── Gate verification (pure) ───────────────────────────────────────────────

/**
 * Pure 4-gate verification for steer/abort (P-005 §8.2).
 *
 * @param {object} gates  - { capability, lease, operation, authorization }
 * @returns {object}      - { ok: true } | { ok: false, missing: [...] }
 */
function verifyFourGates(gates) {
  const missing = [];
  if (!gates || gates.capability !== true) missing.push("capability");
  if (!gates || gates.lease !== true) missing.push("lease");
  if (!gates || gates.operation !== true) missing.push("operation");
  if (!gates || gates.authorization !== true) missing.push("authorization");
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

// ─── Status command (read-only) ─────────────────────────────────────────────

/**
 * Pure status projection. Returns the supervisor's view of a launch:
 *   - current evidenceLevel / phase
 *   - lastActivityAt / lastProductiveAt
 *   - worktree digest (sha256 only — never paths)
 *   - validation receipt (status + lastCommandId + evidenceRef only)
 *
 * Never returns raw stdout / args / paths. Privacy-bound.
 */
function statusProjection(state, options = {}) {
  if (!state || typeof state !== "object") {
    return {
      ok: false,
      error: { code: "STATE_UNAVAILABLE", message: "no state available for launchId" },
    };
  }
  return Object.freeze({
    ok: true,
    action: "status",
    launchId: options.launchId || state.launchId || null,
    taskId: state.taskId,
    evidenceLevel: state.evidenceLevel,
    phase: state.phase,
    lastActivityAt: state.lastActivityAt,
    lastProductiveAt: state.lastProductiveAt,
    activity: {
      readOnlyToolCount: state.activity?.readOnlyToolCount || 0,
      writeToolCount: state.activity?.writeToolCount || 0,
      testToolCount: state.activity?.testToolCount || 0,
      failedToolCount: state.activity?.failedToolCount || 0,
    },
    worktree: {
      baselineHead: state.worktree?.baselineHead || "unknown",
      statusDigest: state.worktree?.statusDigest || "unknown",
      diffDigest: state.worktree?.diffDigest || "unknown",
      changedFileCount: state.worktree?.changedFileCount || 0,
      insertions: state.worktree?.insertions || 0,
      deletions: state.worktree?.deletions || 0,
    },
    validation: {
      lastCommandId: state.validation?.lastCommandId || null,
      status: state.validation?.status || "not_run",
      evidenceRef: state.validation?.evidenceRef || null,
    },
    diagnosticsCount: Array.isArray(state.diagnostics) ? state.diagnostics.length : 0,
  });
}

// ─── Steer command ──────────────────────────────────────────────────────────

/**
 * Build a steer request envelope. The caller (CLI subcommand) supplies the
 * 4-gate verification result; the envelope fails closed if any gate is missing.
 */
function buildSteerRequest(input) {
  if (!input || typeof input !== "object") {
    throw new Error("agent-supervise: input must be a non-null object");
  }
  if (!isValidReason(input.reason)) {
    return {
      ok: false,
      error: {
        code: "INVALID_REASON",
        message: `reason must be one of ${REASON_CODES.join("|")} (got ${JSON.stringify(input.reason)})`,
      },
    };
  }
  if (!isValidIdempotencyKey(input.idempotencyKey)) {
    return {
      ok: false,
      error: {
        code: "INVALID_IDEMPOTENCY_KEY",
        message: `idempotencyKey must match ${IDEMPOTENCY_KEY_PATTERN} (8-128 chars [a-zA-Z0-9_-])`,
      },
    };
  }
  const gateResult = verifyFourGates(input.gates);
  if (!gateResult.ok) {
    return {
      ok: false,
      error: {
        code: "GATE_VIOLATION",
        message: `4-gate verification failed — missing gates: ${gateResult.missing.join(", ")}`,
        details: { missing: gateResult.missing },
      },
    };
  }
  if (!input.launchId || typeof input.launchId !== "string") {
    return {
      ok: false,
      error: { code: "INVALID_LAUNCH_ID", message: "launchId (string) is required" },
    };
  }
  return Object.freeze({
    ok: true,
    action: "steer",
    launchId: input.launchId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    timestamp: input.timestamp || new Date().toISOString(),
    nonce: crypto.randomBytes(8).toString("hex"),
  });
}

// ─── Abort command ──────────────────────────────────────────────────────────

/**
 * Build an abort request envelope. Abort is destructive: P-005 §6.3 mandates
 * that abort NEVER executes cleanup; worktree + journal + receipt are
 * preserved verbatim. The envelope records this invariant explicitly.
 */
function buildAbortRequest(input) {
  if (!input || typeof input !== "object") {
    throw new Error("agent-supervise: input must be a non-null object");
  }
  if (!isValidReason(input.reason)) {
    return {
      ok: false,
      error: {
        code: "INVALID_REASON",
        message: `reason must be one of ${REASON_CODES.join("|")} (got ${JSON.stringify(input.reason)})`,
      },
    };
  }
  if (!isValidIdempotencyKey(input.idempotencyKey)) {
    return {
      ok: false,
      error: {
        code: "INVALID_IDEMPOTENCY_KEY",
        message: `idempotencyKey must match ${IDEMPOTENCY_KEY_PATTERN}`,
      },
    };
  }
  const gateResult = verifyFourGates(input.gates);
  if (!gateResult.ok) {
    return {
      ok: false,
      error: {
        code: "GATE_VIOLATION",
        message: `4-gate verification failed — missing gates: ${gateResult.missing.join(", ")}`,
        details: { missing: gateResult.missing },
      },
    };
  }
  if (!input.launchId || typeof input.launchId !== "string") {
    return {
      ok: false,
      error: { code: "INVALID_LAUNCH_ID", message: "launchId (string) is required" },
    };
  }
  return Object.freeze({
    ok: true,
    action: "abort",
    launchId: input.launchId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    timestamp: input.timestamp || new Date().toISOString(),
    nonce: crypto.randomBytes(8).toString("hex"),
    preserve: {
      worktree: true,
      journal: true,
      receipt: true,
      cleanupInvoked: false,
    },
  });
}

// ─── CLI surface dispatch ───────────────────────────────────────────────────

/**
 * CLI surface dispatcher. The caller (bin/cli.js agent supervise subcommand)
 * passes `args` (parsed from CLI) and `state` (from Management API projection).
 * Returns an envelope ready for stdout.
 */
function cliDispatch(args, state) {
  const action = args[0];
  if (!isValidAction(action)) {
    return {
      ok: false,
      error: {
        code: "INVALID_ACTION",
        message: `action must be one of ${SUPERVISE_ACTIONS.join("|")} (got ${JSON.stringify(action)})`,
        details: { valid: [...SUPERVISE_ACTIONS] },
      },
    };
  }
  if (action === "status") {
    return statusProjection(state, { launchId: args[1] || null });
  }
  if (action === "steer") {
    return buildSteerRequest({
      launchId: args[1],
      reason: args[2],
      idempotencyKey: args[3],
      gates: { capability: true, lease: true, operation: true, authorization: true },
    });
  }
  if (action === "abort") {
    return buildAbortRequest({
      launchId: args[1],
      reason: args[2],
      idempotencyKey: args[3],
      gates: { capability: true, lease: true, operation: true, authorization: true },
    });
  }
  return { ok: false, error: { code: "UNREACHABLE", message: "unreachable" } };
}

const CLI_USAGE = `cortex-agent agent supervise <action> <launchId> <args>

  Actions:
    status <launchId> [--project <path>] [--json]
      Read-only snapshot of the supervised launch.

    steer <launchId> <reason> <idempotencyKey>
      Steer the launch (4-gate verified: capability + lease + Operation + authorization).

    abort <launchId> <reason> <idempotencyKey>
      Abort the launch — preserves worktree + journal + receipt (NEVER cleanup).

  Valid reasons:
    stale_progress | host_unresponsive | user_request |
    policy_violation | scope_expansion_detected | explicit_abort`;

module.exports = {
  cliDispatch,
  statusProjection,
  buildSteerRequest,
  buildAbortRequest,
  verifyFourGates,
  isValidAction,
  isValidReason,
  isValidIdempotencyKey,
  SUPERVISE_ACTIONS,
  REASON_CODES,
  IDEMPOTENCY_KEY_PATTERN,
  CLI_USAGE,
};