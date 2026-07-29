"use strict";

// ─── Claude Hook Handlers (T-ACN-017) ──────────────────────────────────────
// Individual hook handlers for each Claude Code hook type. Each handler
// validates, redacts, and returns a structured result. The handlers are
// stateless (rate limiting is managed externally) and depend only on the
// redaction and scanning utilities.
//
// Zero external dependencies — Node.js built-ins only.

const path = require("node:path");
const {
  redactHookPayload,
  hookPayloadHasSecrets,
  detectTestSignal,
  validateEvidenceRefs,
} = require("./claude-hook-redaction");

// ─── Hook-to-event mapping ─────────────────────────────────────────────────

const HOOK_EVENT_MAP = Object.freeze({
  SessionStart: "task.accepted",
  PostToolUse: "task.progress",
  TestStart: "task.testing",
  Notification: "task.input_required",
  Permission: "task.input_required",
  ReadyForReview: "task.ready_for_review",
});

const HOOK_NAMES = Object.freeze(Object.keys(HOOK_EVENT_MAP));

// ─── Hook-specific stdin schemas (T-ACN-017-R2) ─────────────────────────────
// Each hook type defines the exact set of fields allowed from stdin.
// Any field not in this set is rejected as unknown. Governance fields are
// rejected separately before schema validation.

const HOOK_ALLOWED_STDIN_FIELDS = Object.freeze({
  SessionStart: Object.freeze([]),           // No stdin fields — identity from CORTEX_LAUNCH_CONTEXT
  PostToolUse: Object.freeze(["toolName", "tool", "message", "result", "command"]),
  TestStart: Object.freeze(["toolName", "tool", "message", "result", "command"]),
  Notification: Object.freeze(["message", "reason"]),
  Permission: Object.freeze(["message", "reason"]),
  ReadyForReview: Object.freeze(["message", "evidenceRefs", "evidence"]),
  Stop: Object.freeze(["reason"]),
  SubagentStop: Object.freeze(["reason"]),
});

// ─── SessionStart handler ───────────────────────────────────────────────────
//
// SessionStart maps to task.accepted. The handler validates that a governed
// launch context exists (CORTEX_LAUNCH_CONTEXT). Without it, the handler
// returns a fail-closed result.
//
// The event is NOT created independently — the adapter returns a structured
// result that the caller (the hook executable) routes through the Agent
// Reporter for idempotent submission. The launcher already handles
// task.accepted; this route is the reporter fallback where contract permits.

function handleSessionStart(payload) {
  const contextFile = process.env.CORTEX_LAUNCH_CONTEXT;
  if (!contextFile || typeof contextFile !== "string" || contextFile.length === 0) {
    return {
      ok: false,
      code: "ERR_NO_GOVERNED_CONTEXT",
      message: "SessionStart requires a governed launch context (CORTEX_LAUNCH_CONTEXT). Only accepted through real launcher.",
      eventType: "task.accepted",
      accepted: false,
    };
  }

  let context;
  try {
    const fs = require("node:fs");
    const stat = fs.statSync(contextFile);
    if (stat.mode & 0o077) {
      return {
        ok: false,
        code: "ERR_CONTEXT_FILE_PERMISSIONS",
        message: "Context file has insecure permissions.",
        eventType: "task.accepted",
        accepted: false,
      };
    }
    const content = fs.readFileSync(contextFile, "utf8");
    context = JSON.parse(content);
  } catch (_) {
    return {
      ok: false,
      code: "ERR_CONTEXT_FILE_UNREADABLE",
      message: "Context file is unreadable or invalid.",
      eventType: "task.accepted",
      accepted: false,
    };
  }

  if (!context || !context.taskId || !context.projectId || !context.coordinatorId) {
    return {
      ok: false,
      code: "ERR_CONTEXT_INCOMPLETE",
      message: "Governed context is missing required fields.",
      eventType: "task.accepted",
      accepted: false,
    };
  }

  // Build a structured event envelope — no raw payload forwarded.
  // The event is for the reporter route; the launcher already handles
  // task.accepted. This is an idempotent fallback.
  const event = {
    eventType: "task.accepted",
    taskId: context.taskId,
    projectId: context.projectId,
    correlationId: context.correlationId,
    producer: context.producer || { actorId: context.targetAgentId, kind: "agent" },
    repository: context.repository || { repositoryId: context.projectId },
    notification: { policy: context.notificationPolicy || "journal_only", dedupeKey: "task.accepted" },
    message: "Agent accepted task via SessionStart hook",
  };

  return {
    ok: true,
    code: "ACCEPTED",
    event,
    eventType: "task.accepted",
    accepted: true,
    taskId: context.taskId,
    projectId: context.projectId,
  };
}

// ─── PostToolUse handler ────────────────────────────────────────────────────
//
// PostToolUse maps to task.progress. The handler redacts the payload and
// detects test signals. Rate limiting is delegated to the caller.

function handlePostToolUse(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      code: "ERR_INVALID_PAYLOAD",
      message: "PostToolUse requires a valid payload object.",
      eventType: "task.progress",
      emitted: false,
    };
  }

  const redacted = redactHookPayload(payload);
  if (hookPayloadHasSecrets(redacted)) {
    return {
      ok: false,
      code: "ERR_SENSITIVE_DATA_REJECTED",
      message: "PostToolUse payload contains sensitive data after redaction.",
      eventType: "task.progress",
      emitted: false,
    };
  }

  const isTest = detectTestSignal(payload);
  const eventType = isTest ? "task.testing" : "task.progress";

  // Build bounded metadata: only safe fields, never raw payload.
  return {
    ok: true,
    code: isTest ? "TEST_SIGNAL" : "EMITTED",
    eventType,
    emitted: true,
    toolName: redacted.toolName || redacted.tool || null,
    message: typeof redacted.message === "string" && redacted.message.length <= 4000
      ? redacted.message
      : (typeof redacted.message === "string" ? redacted.message.slice(0, 4000) : null),
    result: isTest ? "test" : (redacted.result || "ok"),
  };
}

// ─── Notification handler ──────────────────────────────────────────────────

function handleNotification(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      code: "ERR_INVALID_PAYLOAD",
      message: "Notification requires a valid payload object.",
      eventType: "task.input_required",
      emitted: false,
    };
  }

  const redacted = redactHookPayload(payload);
  if (hookPayloadHasSecrets(redacted)) {
    return {
      ok: false,
      code: "ERR_SENSITIVE_DATA_REJECTED",
      message: "Notification payload contains sensitive data.",
      eventType: "task.input_required",
      emitted: false,
    };
  }

  // Bounded metadata: only requestedAction, never raw payload.
  const requestedAction = {
    kind: "provide_input",
    reason: typeof redacted.reason === "string" && redacted.reason.length <= 200
      ? redacted.reason
      : "Notification received",
  };

  const message = typeof redacted.message === "string" && redacted.message.length > 0
    ? (redacted.message.length <= 4000 ? redacted.message : redacted.message.slice(0, 4000))
    : "Agent requires input";

  return {
    ok: true,
    code: "INPUT_REQUIRED",
    eventType: "task.input_required",
    emitted: true,
    message,
    requestedAction,
  };
}

// ─── Permission handler ────────────────────────────────────────────────────

function handlePermission(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      code: "ERR_INVALID_PAYLOAD",
      message: "Permission requires a valid payload object.",
      eventType: "task.input_required",
      emitted: false,
    };
  }

  const redacted = redactHookPayload(payload);
  if (hookPayloadHasSecrets(redacted)) {
    return {
      ok: false,
      code: "ERR_SENSITIVE_DATA_REJECTED",
      message: "Permission payload contains sensitive data.",
      eventType: "task.input_required",
      emitted: false,
    };
  }

  const requestedAction = {
    kind: "approve",
    reason: typeof redacted.reason === "string" && redacted.reason.length <= 200
      ? redacted.reason
      : "Permission requested",
  };

  const message = typeof redacted.message === "string" && redacted.message.length > 0
    ? (redacted.message.length <= 4000 ? redacted.message : redacted.message.slice(0, 4000))
    : "Agent requires permission";

  return {
    ok: true,
    code: "PERMISSION_REQUIRED",
    eventType: "task.input_required",
    emitted: true,
    message,
    requestedAction,
  };
}

// ─── ReadyForReview handler ────────────────────────────────────────────────

function handleReadyForReview(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      code: "ERR_INVALID_PAYLOAD",
      message: "ReadyForReview requires a valid payload object.",
      eventType: "task.ready_for_review",
      emitted: false,
    };
  }

  const redacted = redactHookPayload(payload);
  if (hookPayloadHasSecrets(redacted)) {
    return {
      ok: false,
      code: "ERR_SENSITIVE_DATA_REJECTED",
      message: "ReadyForReview payload contains sensitive data.",
      eventType: "task.ready_for_review",
      emitted: false,
    };
  }

  const evidenceRefs = Array.isArray(redacted.evidenceRefs || redacted.evidence)
    ? validateEvidenceRefs(redacted.evidenceRefs || redacted.evidence)
    : [];

  const message = typeof redacted.message === "string" && redacted.message.length > 0
    ? (redacted.message.length <= 4000 ? redacted.message : redacted.message.slice(0, 4000))
    : "Agent marked work as ready for review";

  return {
    ok: true,
    code: "READY_FOR_REVIEW",
    eventType: "task.ready_for_review",
    emitted: true,
    message,
    evidenceRefs,
  };
}

// ─── Stop handler ───────────────────────────────────────────────────────────
//
// Stop NEVER infers completion. The handler records the event but does NOT
// emit task.completed or task.failed. The coordinator determines the terminal
// state via lease expiration, heartbeat timeout, or explicit user action.

function handleStop(payload) {
  return {
    ok: true,
    code: "STOP_RECORDED",
    message: "Stop event recorded. Coordinator determines terminal state — never inferred.",
    eventType: null,
    emitted: false,
  };
}

// ─── SubagentStop handler ──────────────────────────────────────────────────

function handleSubagentStop(payload) {
  return {
    ok: true,
    code: "SUBAGENT_STOP_RECORDED",
    message: "SubagentStop event recorded. Coordinator determines terminal state — never inferred.",
    eventType: null,
    emitted: false,
  };
}

module.exports = {
  HOOK_EVENT_MAP,
  HOOK_NAMES,
  HOOK_ALLOWED_STDIN_FIELDS,
  handleSessionStart,
  handlePostToolUse,
  handleNotification,
  handlePermission,
  handleReadyForReview,
  handleStop,
  handleSubagentStop,
};