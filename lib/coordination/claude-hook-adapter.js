"use strict";

// ─── Claude Code Hook Adapter (T-ACN-017) ────────────────────────────────────
//
// Bridges Claude Code hooks to the coordination machine. The adapter enforces
// governance: every hook payload is validated, redacted, and rate-limited before
// it reaches the Coordination Application Service.
//
// Hook mapping (P-003 §11.2):
//   SessionStart      → task.accepted    (only through real launcher)
//   PostToolUse       → task.progress    (rate-limited, merged)
//   TestStart         → task.testing     (only when signal matches)
//   Notification      → task.input_required (without raw payload)
//   Permission        → task.input_required (without raw payload)
//   ReadyForReview    → task.ready_for_review (with allowed evidence)
//   Stop              → NEVER infer completion
//   SubagentStop      → NEVER infer completion
//
// Safety contract:
//   - SessionStart validates CORTEX_LAUNCH_CONTEXT before accepting
//   - PostToolUse is rate-limited (max 1 per N ms) and merged into one update
//   - PostToolUse with "test" signal mapping maps to task.testing
//   - Notification/Permission strips raw payload, only passes requestedAction
//   - ReadyForReview only accepts evidence refs from the allowed set
//   - Stop/SubagentStop never emit task.completed or task.failed
//   - All hook payloads are scanned for credentials, paths, prompts, commands
//   - Unknown hook names are silently ignored (fail closed)
//
// Zero external dependencies — Node.js built-ins only.

const path = require("node:path");
const { scanContent } = require("../secret-scan");
const { AGENT_SCOPED_EVENT_SET } = require("../agent-reporter");

// ─── Schema version ──────────────────────────────────────────────────────────

const HOOK_ADAPTER_SCHEMA_VERSION = "1.0";

// ─── Hook-to-event mapping ───────────────────────────────────────────────────
//
// Maps Claude Code hook names to coordination machine event types.
// Hooks not in this map are silently ignored (fail closed).

const HOOK_EVENT_MAP = Object.freeze({
  SessionStart: "task.accepted",
  PostToolUse: "task.progress",
  TestStart: "task.testing",
  Notification: "task.input_required",
  Permission: "task.input_required",
  ReadyForReview: "task.ready_for_review",
  // Stop and SubagentStop are deliberately NOT mapped — they never infer
  // completion. The coordinator determines the terminal state based on
  // lease expiration, heartbeat timeout, or explicit user action.
});

const HOOK_NAMES = Object.freeze(Object.keys(HOOK_EVENT_MAP));

// ─── Rate limiting ───────────────────────────────────────────────────────────
//
// PostToolUse is rate-limited to prevent flooding the coordination machine.
// The default window is 5000ms — within that window, only the latest progress
// payload is kept (merged into a single update).

const DEFAULT_RATE_LIMIT_MS = 5000;

// ─── Sensitive field patterns ────────────────────────────────────────────────
//
// These patterns identify fields in hook payloads that MUST be redacted before
// forwarding to the coordination machine.

const SENSITIVE_FIELD_PATTERNS = [
  // Session identifiers
  { pattern: /session/i, redact: true },
  // Prompt content
  { pattern: /prompt/i, redact: true },
  // Command content
  { pattern: /^command$/i, redact: true },
  // File paths (absolute paths)
  { pattern: /^cwd$/i, redact: true },
  { pattern: /^pwd$/i, redact: true },
  // Tool payload
  { pattern: /^payload$/i, redact: true },
  { pattern: /^arguments$/i, redact: true },
  { pattern: /^input$/i, redact: true },
  { pattern: /^output$/i, redact: true },
  // Credentials
  { pattern: /token/i, redact: true },
  { pattern: /password/i, redact: true },
  { pattern: /secret/i, redact: true },
  { pattern: /credential/i, redact: true },
  { pattern: /api[_-]?key/i, redact: true },
  { pattern: /authorization/i, redact: true },
];

// ─── Evidence allowlist ──────────────────────────────────────────────────────
//
// Only evidence refs matching these patterns are allowed through ReadyForReview.
// This prevents the agent from attaching arbitrary sensitive data as evidence.

const EVIDENCE_REF_ALLOWED = [
  /^ARTIFACT-[A-Za-z0-9._-]+$/,
  /^RUN-[A-Za-z0-9._-]+$/,
  /^VC-[A-Za-z0-9._-]+$/,
  /^DEC-[A-Za-z0-9._-]+$/,
  /^\.\//,
  /^tests\//,
  /^docs\//,
  /^lib\//,
  /^src\//,
];

// ─── Test signal mapping ─────────────────────────────────────────────────────
//
// PostToolUse with a "test" or "testing" signal in the tool name or result
// is mapped to task.testing. This allows the coordination machine to track
// the testing phase.

const TEST_SIGNAL_PATTERNS = [
  /\btest/i,
  /\btesting\b/i,
  /^vitest\b/,
  /^jest\b/,
  /^mocha\b/,
  /^ava\b/,
  /^node --test\b/,
  /npx jest/,
  /npx vitest/,
  /npm test/,
  /npm run test/,
  /yarn test/,
  /pnpm test/,
];

// ─── Redaction ───────────────────────────────────────────────────────────────
//
// Redacts sensitive fields from a hook payload. Returns a new object with
// sensitive fields replaced by "[REDACTED]".

function redactHookPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(redactHookPayload);

  const redacted = {};
  for (const [key, value] of Object.entries(payload)) {
    const isSensitive = SENSITIVE_FIELD_PATTERNS.some((p) => p.pattern.test(key));
    if (isSensitive) {
      redacted[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "object" && value !== null) {
      redacted[key] = redactHookPayload(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

// ─── Secret scan on hook payload ─────────────────────────────────────────────
//
// Scans a hook payload for sensitive data patterns (credentials, paths, etc.).
// Returns true if sensitive data is found.

function hookPayloadHasSecrets(payload) {
  const serialized = JSON.stringify(payload);
  const findings = scanContent(serialized);
  return findings.length > 0;
}

// ─── Rate limiter ────────────────────────────────────────────────────────────
//
// Creates a rate limiter for PostToolUse hooks. The rate limiter tracks the
// last emission time per tool name and returns true if the hook should be
// emitted (i.e., the rate limit window has passed).

function createRateLimiter(windowMs = DEFAULT_RATE_LIMIT_MS) {
  const lastEmitted = new Map();

  function shouldEmit(toolName, now = Date.now()) {
    if (!toolName) return true;
    const last = lastEmitted.get(toolName) || 0;
    if (now - last >= windowMs) {
      lastEmitted.set(toolName, now);
      return true;
    }
    return false;
  }

  function reset(toolName) {
    if (toolName) {
      lastEmitted.delete(toolName);
    } else {
      lastEmitted.clear();
    }
  }

  return Object.freeze({
    shouldEmit,
    reset,
    windowMs,
  });
}

// ─── Progress merger ────────────────────────────────────────────────────────
//
// Merges multiple PostToolUse payloads into a single progress update.
// The merger keeps the latest message and aggregates tool counts.

function mergeProgress(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return incoming;

  return Object.freeze({
    message: incoming.message || existing.message,
    toolName: incoming.toolName || existing.toolName,
    toolCount: (existing.toolCount || 0) + (incoming.toolCount || 1),
    result: incoming.result || existing.result,
    merged: true,
    mergedAt: new Date().toISOString(),
  });
}

// ─── Detect test signal ──────────────────────────────────────────────────────
//
// Detects whether a PostToolUse payload contains a test signal.
// Returns true if the tool name or result suggests a test run.

function detectTestSignal(payload) {
  if (!payload || typeof payload !== "object") return false;

  const toolName = payload.toolName || payload.tool || "";
  const result = payload.result || "";
  const command = payload.command || "";

  const searchText = [toolName, result, command].filter(Boolean).join(" ");
  return TEST_SIGNAL_PATTERNS.some((p) => p.test(searchText));
}

// ─── Validate evidence refs ─────────────────────────────────────────────────
//
// Validates that evidence refs match the allowed patterns.
// Returns only the refs that pass validation.

function validateEvidenceRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.filter((ref) => {
    if (!ref || typeof ref !== "string") return false;
    return EVIDENCE_REF_ALLOWED.some((p) => p.test(ref));
  });
}

// ─── Hook adapter factory ────────────────────────────────────────────────────
//
// Creates a Claude Code Hook Adapter instance. The adapter is stateless except
// for the rate limiter (which maintains per-tool timing).

function createClaudeHookAdapter(options = {}) {
  const rateLimitMs = Number.isSafeInteger(options.rateLimitMs) && options.rateLimitMs > 0
    ? options.rateLimitMs
    : DEFAULT_RATE_LIMIT_MS;

  const rateLimiter = createRateLimiter(rateLimitMs);
  let pendingProgress = null;

  // ─── Hook event type lookup ──────────────────────────────────────────────

  function hookEventType(hookName) {
    return HOOK_EVENT_MAP[hookName] || null;
  }

  function isKnownHook(hookName) {
    return HOOK_NAMES.includes(hookName);
  }

  // ─── SessionStart handler ─────────────────────────────────────────────────
  //
  // SessionStart maps to task.accepted. The adapter validates that a governed
  // launch context exists (CORTEX_LAUNCH_CONTEXT). Without it, the handler
  // returns a fail-closed result — the task is NOT accepted.
  //
  // The hook payload is NOT forwarded to the coordination machine. Instead,
  // the adapter builds a structured event from the governed context.

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

    // Validate the context file exists and is accessible
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

    // Build a structured event from the governed context — no raw payload forwarded.
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

  // ─── PostToolUse handler ─────────────────────────────────────────────────
  //
  // PostToolUse maps to task.progress. The handler rate-limits emissions and
  // merges pending progress. If the tool usage is a test signal, it maps to
  // task.testing instead.
  //
  // The hook payload is redacted before forwarding:
  //   - prompt, session, path, command, tool payload, credentials are redacted
  //   - The redacted payload is scanned for remaining secrets

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

    // Redact sensitive fields
    const redacted = redactHookPayload(payload);

    // Scan for secrets in the redacted payload
    if (hookPayloadHasSecrets(redacted)) {
      return {
        ok: false,
        code: "ERR_SENSITIVE_DATA_REJECTED",
        message: "PostToolUse payload contains sensitive data after redaction.",
        eventType: "task.progress",
        emitted: false,
      };
    }

    // Detect test signal — override event type
    const isTest = detectTestSignal(payload);
    const eventType = isTest ? "task.testing" : "task.progress";

    // Rate limit: only emit if the rate limit window has passed
    const toolName = payload.toolName || payload.tool || "unknown";
    if (eventType === "task.progress" && !rateLimiter.shouldEmit(toolName)) {
      // Merge into pending progress instead of emitting
      pendingProgress = mergeProgress(pendingProgress, {
        message: redacted.message || null,
        toolName,
        toolCount: 1,
        result: redacted.result || null,
      });
      return {
        ok: true,
        code: "RATE_LIMITED",
        message: "PostToolUse rate-limited; progress merged.",
        eventType: "task.progress",
        emitted: false,
        merged: true,
      };
    }

    // Flush any pending merged progress
    const mergedMessage = pendingProgress
      ? `[Merged ${pendingProgress.toolCount || 1} tools] ${pendingProgress.message || ""}`
      : null;

    if (pendingProgress) {
      // Include the merged message in the emitted event
      pendingProgress = null;
    }

    // Build the event envelope (no raw payload forwarded)
    return {
      ok: true,
      code: isTest ? "TEST_SIGNAL" : "EMITTED",
      eventType,
      emitted: true,
      rateLimited: false,
      mergedMessage,
      toolName: redacted.toolName || redacted.tool || null,
      message: redacted.message || null,
      result: isTest ? "test" : (redacted.result || "ok"),
    };
  }

  // ─── Notification handler ────────────────────────────────────────────────
  //
  // Notification maps to task.input_required. The raw payload is NOT forwarded.
  // Only the requestedAction is extracted from the notification context.

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

    // Redact sensitive fields
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

    // Extract requestedAction from notification context — never raw payload.
    const requestedAction = {
      kind: "provide_input",
      reason: redacted.reason || redacted.message || "Notification received",
    };

    const message = typeof redacted.message === "string" && redacted.message.length > 0
      ? redacted.message
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

  // ─── Permission handler ──────────────────────────────────────────────────
  //
  // Permission maps to task.input_required. Same as Notification but with
  // permission-specific context. The raw payload is NOT forwarded.

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

    // Redact sensitive fields
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
      reason: redacted.reason || redacted.message || "Permission requested",
    };

    const message = typeof redacted.message === "string" && redacted.message.length > 0
      ? redacted.message
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

  // ─── ReadyForReview handler ──────────────────────────────────────────────
  //
  // ReadyForReview maps to task.ready_for_review. Only evidence refs from the
  // allowed set are forwarded. The hook payload is redacted.

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

    // Redact sensitive fields
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

    // Validate evidence refs — only allowed refs are forwarded
    const evidenceRefs = Array.isArray(redacted.evidenceRefs || redacted.evidence)
      ? validateEvidenceRefs(redacted.evidenceRefs || redacted.evidence)
      : [];

    const message = typeof redacted.message === "string" && redacted.message.length > 0
      ? redacted.message
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

  // ─── Stop handler ────────────────────────────────────────────────────────
  //
  // Stop NEVER infers completion. The handler records the stop event but does
  // NOT emit task.completed or task.failed. The coordinator determines the
  // terminal state.

  function handleStop(payload) {
    return {
      ok: true,
      code: "STOP_RECORDED",
      message: "Stop event recorded. Coordinator determines terminal state — never inferred.",
      eventType: null,
      emitted: false,
    };
  }

  // ─── SubagentStop handler ────────────────────────────────────────────────
  //
  // SubagentStop NEVER infers completion. Same as Stop — the coordinator
  // determines the terminal state.

  function handleSubagentStop(payload) {
    return {
      ok: true,
      code: "SUBAGENT_STOP_RECORDED",
      message: "SubagentStop event recorded. Coordinator determines terminal state — never inferred.",
      eventType: null,
      emitted: false,
    };
  }

  // ─── Dispatch hook ───────────────────────────────────────────────────────
  //
  // Dispatches a hook name and payload to the appropriate handler.
  // Unknown hook names are silently ignored (fail closed).

  function dispatch(hookName, payload) {
    if (!hookName || typeof hookName !== "string") {
      return {
        ok: false,
        code: "ERR_UNKNOWN_HOOK",
        message: "Hook name is required.",
        emitted: false,
      };
    }

    switch (hookName) {
      case "SessionStart":
        return handleSessionStart(payload);
      case "PostToolUse":
        return handlePostToolUse(payload);
      case "TestStart":
        return handlePostToolUse(payload); // TestStart maps the same as PostToolUse with test signal
      case "Notification":
        return handleNotification(payload);
      case "Permission":
        return handlePermission(payload);
      case "ReadyForReview":
        return handleReadyForReview(payload);
      case "Stop":
        return handleStop(payload);
      case "SubagentStop":
        return handleSubagentStop(payload);
      default:
        return {
          ok: false,
          code: "ERR_UNKNOWN_HOOK",
          message: `Unknown hook name: ${hookName}. Silently ignored (fail closed).`,
          emitted: false,
        };
    }
  }

  // ─── Flush pending progress ──────────────────────────────────────────────
  //
  // Flushes any pending merged progress. Returns the merged progress or null
  // if there is no pending progress.

  function flushPendingProgress() {
    if (!pendingProgress) return null;
    const result = pendingProgress;
    pendingProgress = null;
    return result;
  }

  return Object.freeze({
    schemaVersion: HOOK_ADAPTER_SCHEMA_VERSION,
    rateLimitMs,
    hookEventType,
    isKnownHook,
    handleSessionStart,
    handlePostToolUse,
    handleNotification,
    handlePermission,
    handleReadyForReview,
    handleStop,
    handleSubagentStop,
    dispatch,
    flushPendingProgress,
    redactHookPayload,
    detectTestSignal,
    validateEvidenceRefs,
    // Expose handlers for testing
    _handlers: Object.freeze({
      SessionStart: handleSessionStart,
      PostToolUse: handlePostToolUse,
      Notification: handleNotification,
      Permission: handlePermission,
      ReadyForReview: handleReadyForReview,
      Stop: handleStop,
      SubagentStop: handleSubagentStop,
    }),
  });
}

module.exports = {
  HOOK_ADAPTER_SCHEMA_VERSION,
  HOOK_EVENT_MAP,
  HOOK_NAMES,
  DEFAULT_RATE_LIMIT_MS,
  SENSITIVE_FIELD_PATTERNS,
  EVIDENCE_REF_ALLOWED,
  TEST_SIGNAL_PATTERNS,
  createClaudeHookAdapter,
  createRateLimiter,
  redactHookPayload,
  detectTestSignal,
  mergeProgress,
  validateEvidenceRefs,
};