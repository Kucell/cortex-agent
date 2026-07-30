"use strict";

// ─── Claude Code Hook CLI (T-ACN-017-R4) ─────────────────────────────────────
//
// Bridges Claude Code hooks to the Coordination Application Service via the
// Agent Reporter. NEVER calls createEvent or service.submit directly — all
// event submission goes through the Agent Reporter for idempotency, state
// derivation, secret scanning, and receipt redaction.
//
// Architecture:
//   hook stdin → governance/schema validation (caller) → this module
//     → Agent Reporter → CoordinationApplicationService
//
// Hook mapping (P-003 §11.2, via Agent Reporter):
//   SessionStart      → validate context only (no event — launcher authoritative)
//   PostToolUse       → reporter.report("task.progress", ...)
//   TestStart         → reporter.report("task.testing", ...)
//   Notification      → reporter.report("task.input_required", ...)
//   Permission        → reporter.report("task.input_required", ...)
//   ReadyForReview    → reporter.report("task.ready_for_review", ...)
//   Stop              → never submit (nonterminal)
//   SubagentStop      → never submit (nonterminal)
//
// Zero external dependencies — Node.js built-ins only.

const {
  handleSessionStart,
  handlePostToolUse,
  handleNotification,
  handlePermission,
  handleReadyForReview,
  handleStop,
  handleSubagentStop,
  HOOK_EVENT_MAP,
  HOOK_NAMES,
} = require("./claude-hook-handlers");
const {
  redactHookPayload,
  hookPayloadHasSecrets,
  detectTestSignal,
  validateEvidenceRefs,
} = require("./claude-hook-redaction");
const { createAgentReporterFromContext } = require("../agent-reporter");

const HOOK_CLI_SCHEMA_VERSION = "1.0";

// ─── Hook notification policies ─────────────────────────────────────────────
// Per R4: coordinator notification for input/ready events; journal_only for
// liveness events (progress, testing, heartbeat).

const HOOK_NOTIFICATION_POLICY = Object.freeze({
  SessionStart: "journal_only",
  PostToolUse: "journal_only",
  TestStart: "journal_only",
  Notification: "coordinator_notify",
  Permission: "coordinator_notify",
  ReadyForReview: "coordinator_notify",
  Stop: "journal_only",
  SubagentStop: "journal_only",
});

// ─── Build redacted receipt ─────────────────────────────────────────────────
// Per P-003 §11.1 / §13.5: only ok, code, eventType, emitted, timestamp.
// NEVER prompt, session, path, command, payload, token, or credentials.

function buildErrorReceipt(ok, code, eventType) {
  const receipt = {
    ok,
    code,
    timestamp: new Date().toISOString(),
  };
  if (eventType !== undefined && eventType !== null) {
    receipt.eventType = eventType;
  }
  return receipt;
}

// ─── Execute hook via Agent Reporter ───────────────────────────────────────
//
// Per R4: ALL event submission goes through the Agent Reporter. The reporter
// handles idempotency (launchId + eventType + deliveryId dedup), state
// derivation (previousState/currentState from service), secret scanning,
// forbidden field stripping, and receipt redaction.
//
// Parameters:
//   service  — CoordinationApplicationService instance
//   hookName — one of HOOK_NAMES
//   payload  — validated stdin payload (governance fields already rejected,
//              unknown fields already rejected by schema validation)
//
// Returns { ok, code, eventType, emitted, timestamp, ... }
// NEVER returns prompt, session, path, command, payload, token, or credentials.

function executeClaudeHook(service, hookName, payload) {
  if (!hookName || typeof hookName !== "string") {
    return buildErrorReceipt(false, "ERR_HOOK_NAME_REQUIRED", null);
  }

  if (!HOOK_NAMES.includes(hookName) && hookName !== "Stop" && hookName !== "SubagentStop") {
    return buildErrorReceipt(false, "ERR_UNKNOWN_HOOK", null);
  }

  // ─── Stop / SubagentStop ────────────────────────────────────────────────
  // Nonterminal events. Never submit to the Journal. No context required.

  if (hookName === "Stop") {
    return {
      ok: true,
      code: "STOP_RECORDED",
      eventType: null,
      emitted: false,
      timestamp: new Date().toISOString(),
    };
  }

  if (hookName === "SubagentStop") {
    return {
      ok: true,
      code: "SUBAGENT_STOP_RECORDED",
      eventType: null,
      emitted: false,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── SessionStart ───────────────────────────────────────────────────────
  // Validates governed context. Does NOT submit — the launcher is
  // authoritative for task.accepted. The hook is a validation gate only.

  if (hookName === "SessionStart") {
    const handlerResult = handleSessionStart(payload);
    if (!handlerResult.ok) {
      return buildErrorReceipt(false, handlerResult.code, "task.accepted");
    }
    return {
      ok: true,
      code: "ACCEPTED",
      eventType: "task.accepted",
      emitted: false,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Hooks requiring governed context ───────────────────────────────────
  // PostToolUse, TestStart, Notification, Permission, ReadyForReview all
  // need the CORTEX_LAUNCH_CONTEXT for identity. The Agent Reporter fails
  // closed if the context is missing.

  let reporter;
  try {
    reporter = createAgentReporterFromContext(service);
  } catch (err) {
    const code = (err && err.code) || "ERR_CONTEXT_REQUIRED";
    return buildErrorReceipt(false, code, HOOK_EVENT_MAP[hookName] || null);
  }

  const notificationPolicy = HOOK_NOTIFICATION_POLICY[hookName] || "journal_only";
  const deliveryId = `${hookName}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;

  // ─── PostToolUse / TestStart ────────────────────────────────────────────
  // Redact payload, detect test signal, report task.progress or task.testing.

  if (hookName === "PostToolUse" || hookName === "TestStart") {
    const handlerResult = handlePostToolUse(payload);
    if (!handlerResult.ok) {
      return buildErrorReceipt(false, handlerResult.code, handlerResult.eventType);
    }

    const isTest = handlerResult.eventType === "task.testing";
    const eventType = isTest ? "task.testing" : "task.progress";

    const reportInput = {
      taskId: reporter.contextTaskId,
      message: handlerResult.message || "Agent progress",
      deliveryId,
      notificationPolicy,
    };

    const result = reporter.report(eventType, reportInput);
    if (!result.ok) {
      return buildErrorReceipt(false, result.code || "ERR_REPORT_FAILED", eventType);
    }

    return {
      ok: true,
      code: isTest ? "TEST_SIGNAL" : "EMITTED",
      eventType,
      emitted: result.appended,
      timestamp: result.receipt ? result.receipt.timestamp : new Date().toISOString(),
    };
  }

  // ─── Notification ───────────────────────────────────────────────────────
  // Submit task.input_required with bounded requestedAction.

  if (hookName === "Notification") {
    const handlerResult = handleNotification(payload);
    if (!handlerResult.ok) {
      return buildErrorReceipt(false, handlerResult.code, "task.input_required");
    }

    // Map handler's requestedAction to contract-allowed fields.
    // handler returns { kind, reason } but contract only allows
    // { kind, message, ref, decisionRef, waitpointRef }.
    const ra = handlerResult.requestedAction || {};
    const reportInput = {
      taskId: reporter.contextTaskId,
      message: handlerResult.message || "Agent requires input",
      requestedAction: {
        kind: ra.kind || "provide_input",
        message: (ra.reason || ra.message || "Notification received").slice(0, 200),
      },
      deliveryId,
      notificationPolicy,
    };

    const result = reporter.report("task.input_required", reportInput);
    if (!result.ok) {
      return buildErrorReceipt(false, result.code || "ERR_REPORT_FAILED", "task.input_required");
    }

    return {
      ok: true,
      code: "INPUT_REQUIRED",
      eventType: "task.input_required",
      emitted: result.appended,
      timestamp: result.receipt ? result.receipt.timestamp : new Date().toISOString(),
    };
  }

  // ─── Permission ─────────────────────────────────────────────────────────
  // Submit task.input_required with bounded requestedAction.

  if (hookName === "Permission") {
    const handlerResult = handlePermission(payload);
    if (!handlerResult.ok) {
      return buildErrorReceipt(false, handlerResult.code, "task.input_required");
    }

    // Map handler's requestedAction to contract-allowed fields.
    const ra = handlerResult.requestedAction || {};
    const reportInput = {
      taskId: reporter.contextTaskId,
      message: handlerResult.message || "Agent requires permission",
      requestedAction: {
        kind: ra.kind || "approve",
        message: (ra.reason || ra.message || "Permission requested").slice(0, 200),
      },
      deliveryId,
      notificationPolicy,
    };

    const result = reporter.report("task.input_required", reportInput);
    if (!result.ok) {
      return buildErrorReceipt(false, result.code || "ERR_REPORT_FAILED", "task.input_required");
    }

    return {
      ok: true,
      code: "PERMISSION_REQUIRED",
      eventType: "task.input_required",
      emitted: result.appended,
      timestamp: result.receipt ? result.receipt.timestamp : new Date().toISOString(),
    };
  }

  // ─── ReadyForReview ─────────────────────────────────────────────────────
  // Submit task.ready_for_review with validated evidence refs.

  if (hookName === "ReadyForReview") {
    const handlerResult = handleReadyForReview(payload);
    if (!handlerResult.ok) {
      return buildErrorReceipt(false, handlerResult.code, "task.ready_for_review");
    }

    const evidence = Array.isArray(handlerResult.evidenceRefs)
      ? handlerResult.evidenceRefs.map((ref) => ({ ref, kind: "artifact" }))
      : [];

    const reportInput = {
      taskId: reporter.contextTaskId,
      message: handlerResult.message || "Agent marked work as ready for review",
      evidence,
      deliveryId,
      notificationPolicy,
    };

    const result = reporter.report("task.ready_for_review", reportInput);
    if (!result.ok) {
      return buildErrorReceipt(false, result.code || "ERR_REPORT_FAILED", "task.ready_for_review");
    }

    return {
      ok: true,
      code: "READY_FOR_REVIEW",
      eventType: "task.ready_for_review",
      emitted: result.appended,
      timestamp: result.receipt ? result.receipt.timestamp : new Date().toISOString(),
    };
  }

  // Fallback — should not reach here since HOOK_NAMES covers all known hooks
  return buildErrorReceipt(false, "ERR_UNKNOWN_HOOK", null);
}

module.exports = {
  HOOK_CLI_SCHEMA_VERSION,
  HOOK_NOTIFICATION_POLICY,
  executeClaudeHook,
};