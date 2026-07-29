"use strict";

// ─── Claude Code Hook Adapter (T-ACN-017) ────────────────────────────────────
//
// Bridges Claude Code hooks to the coordination machine. The adapter enforces
// governance: every hook payload is validated, redacted, and rate-limited before
// it reaches the Coordination Application Service.
//
// Architecture:
//   claude-hook-adapter.js      — factory, dispatch, entry point (this file)
//   claude-hook-handlers.js     — individual hook handler functions
//   claude-hook-redaction.js    — redaction, secret scan, evidence validation
//   claude-hook-rate-limiter.js — rate limiting, progress merging
//
// Hook mapping (P-003 §11.2):
//   SessionStart      → task.accepted    (reporter route, idempotent)
//   PostToolUse       → task.progress    (rate-limited, merged)
//   TestStart         → task.testing     (only when signal matches)
//   Notification      → task.input_required (bounded metadata only)
//   Permission        → task.input_required (bounded metadata only)
//   ReadyForReview    → task.ready_for_review (allowed evidence only)
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
  DEFAULT_RATE_LIMIT_MS,
  createRateLimiter,
  mergeProgress,
} = require("./claude-hook-rate-limiter");
const {
  redactHookPayload,
  detectTestSignal,
  validateEvidenceRefs,
} = require("./claude-hook-redaction");

const HOOK_ADAPTER_SCHEMA_VERSION = "1.0";

// ─── Hook adapter factory ────────────────────────────────────────────────────

function createClaudeHookAdapter(options = {}) {
  const rateLimitMs = Number.isSafeInteger(options.rateLimitMs) && options.rateLimitMs > 0
    ? options.rateLimitMs
    : DEFAULT_RATE_LIMIT_MS;

  const rateLimiter = createRateLimiter(rateLimitMs);
  let pendingProgress = null;

  function hookEventType(hookName) {
    return HOOK_EVENT_MAP[hookName] || null;
  }

  function isKnownHook(hookName) {
    return HOOK_NAMES.includes(hookName);
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
        return handlePostToolUseWithRateLimit(payload);
      case "TestStart":
        return handlePostToolUseWithRateLimit(payload);
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

  // ─── PostToolUse with rate limiting ──────────────────────────────────────
  //
  // Wraps handlePostToolUse with rate limiting and progress merging.

  function handlePostToolUseWithRateLimit(payload) {
    const result = handlePostToolUse(payload);
    if (!result.ok) return result;

    const isTest = result.eventType === "task.testing";
    const toolName = result.toolName || "unknown";

    // Rate limit: only emit if within the rate limit window
    if (!isTest && !rateLimiter.shouldEmit(toolName)) {
      pendingProgress = mergeProgress(pendingProgress, {
        message: result.message || null,
        toolName,
        toolCount: 1,
        result: result.result || null,
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
    if (pendingProgress) {
      pendingProgress = null;
    }

    return result;
  }

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
    handlePostToolUse: handlePostToolUseWithRateLimit,
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
  createClaudeHookAdapter,
  createRateLimiter,
  redactHookPayload,
  detectTestSignal,
  mergeProgress,
  validateEvidenceRefs,
};