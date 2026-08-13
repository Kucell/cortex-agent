"use strict";

// ─── hook — Public CLI for Claude Code hooks (T-ACN-016) ─────────────────────
//
// Originally lived in lib/commands.js (line 2298–2451). Provides
//   - normalizeClaudeNativePayload: validates the host-owned envelope
//   - hook: top-level CLI surface that calls into coordination/claude-hook-cli
//
// Safety contract:
//   - Only "claude" subcommand is supported (extensible for future hosts)
//   - Stdin or --stdin payload is validated, governance fields rejected
//   - SessionStart validates context, never submits (launcher authoritative)
//   - Stop/SubagentStop: nonterminal, never submit events
//   - Receipt: only ok/code/eventType/emitted/timestamp; never sensitive data
//
// Extracted so callers can require this surface in isolation.

const fs = require("node:fs");
const path = require("node:path");

// Claude Code sends a host-owned envelope, not the small Cortex hook payload
// used by the internal adapter.  Accepting that envelope verbatim would either
// reject every real hook invocation (its fields are snake_case) or leak the
// transcript, cwd, prompt and tool payload into coordination state.  This
// normalizer validates the event name, derives only the two bounded signals we
// need, then discards the envelope before the normal adapter validates it.
const CLAUDE_NATIVE_EVENT_NAMES = Object.freeze({
  SessionStart: "SessionStart",
  PostToolUse: "PostToolUse",
  PreToolUse: "PreToolUse",   // T-AGR-001: path authorization gate
  Notification: "Notification",
  Permission: "PermissionRequest",
  Stop: "Stop",
  SubagentStop: "SubagentStop",
});

function normalizeClaudeNativePayload(hookName, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.hook_event_name) {
    return { ok: true, payload };
  }
  if (payload.hook_event_name !== CLAUDE_NATIVE_EVENT_NAMES[hookName]) {
    return { ok: false, code: "ERR_NATIVE_HOOK_EVENT_MISMATCH" };
  }
  switch (hookName) {
    case "SessionStart":
    case "Stop":
    case "SubagentStop":
      return { ok: true, payload: {} };
    case "PostToolUse": {
      const toolName = typeof payload.tool_name === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(payload.tool_name)
        ? payload.tool_name
        : "unknown";
      // The command is used only in-memory for test-signal classification by
      // the adapter. It is redacted before persistence and never reaches a
      // receipt, event, message, or evidence record.
      const command = payload.tool_input && typeof payload.tool_input.command === "string"
        ? payload.tool_input.command.slice(0, 4096)
        : undefined;
      return { ok: true, payload: { toolName, ...(command ? { command } : {}) } };
    }
    case "PreToolUse": {
      // T-AGR-001: PreToolUse gates Write/Edit/MultiEdit/Read/Bash on .agent paths.
      // tool_name is the Claude tool name, tool_input may contain file_path.
      const toolName = typeof payload.tool_name === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(payload.tool_name)
        ? payload.tool_name
        : null;
      const filePath = payload.tool_input && typeof payload.tool_input.file_path === "string"
        ? payload.tool_input.file_path
        : (payload.tool_input && typeof payload.tool_input.path === "string"
          ? payload.tool_input.path
          : null);
      // Bash tool_input.command is forwarded so the handler can tokenize and
      // detect .agent path references (e.g. `cat /path/.agent/rules/x.md`).
      // The command is never persisted or echoed to a public event — it stays
      // in private CORTEX_LAUNCH_CONTEXT only.
      const command = toolName === "Bash" && payload.tool_input && typeof payload.tool_input.command === "string"
        ? payload.tool_input.command.slice(0, 4096)
        : null;
      return {
        ok: true,
        payload: {
          toolName,
          ...(filePath !== null ? { filePath } : {}),
          ...(command !== null ? { command } : {}),
        },
      };
    }
    case "Notification":
      return {
        ok: true,
        payload: {
          reason: typeof payload.notification_type === "string" && /^[a-z_]{1,64}$/.test(payload.notification_type)
            ? payload.notification_type
            : "notification",
        },
      };
    case "Permission":
      return { ok: true, payload: { reason: "permission_request" } };
    default:
      return { ok: false, code: "ERR_NATIVE_HOOK_UNSUPPORTED" };
  }
}

function hook(ctx, dependencies = {}) {
  const subcommand = ctx.args[1];
  if (subcommand !== "claude") {
    console.error("cortex-agent hook: unsupported hook host. Usage: cortex-agent hook claude <HookName>");
    process.exitCode = 2;
    return;
  }

  const hookName = ctx.args[2];
  if (!hookName || typeof hookName !== "string") {
    console.error("Usage: cortex-agent hook claude <HookName>");
    process.exitCode = 2;
    return;
  }

  const { executeClaudeHook } = require("../../coordination/claude-hook-cli");
  const { HOOK_ALLOWED_STDIN_FIELDS } = require("../../coordination/claude-hook-handlers");
  const GOVERNANCE_FIELDS = new Set([
    "taskId", "projectId", "actorId", "kind", "sessionId",
    "correlationId", "coordinatorId", "launchId",
    "targets", "repository", "sequence", "workflowGate",
    "notificationPolicy", "producer",
  ]);

  // Read stdin or --stdin option
  let rawPayload = {};
  const stdinOpt = ctx.options && ctx.options.stdin;
  if (stdinOpt && typeof stdinOpt === "string" && stdinOpt.length > 0) {
    try { rawPayload = JSON.parse(stdinOpt); } catch (_) { rawPayload = {}; }
  } else if (!process.stdin.isTTY && !stdinOpt) {
    // Read from piped stdin (non-TTY)
    try {
      const text = fs.readFileSync(0, "utf8").trim();
      if (text.length > 0) rawPayload = JSON.parse(text);
    } catch (_) { rawPayload = {}; }
  }

  const normalized = normalizeClaudeNativePayload(hookName, rawPayload);
  if (!normalized.ok) {
    console.error(`hook: native Claude payload rejected (${normalized.code}).`);
    process.exitCode = 1;
    return;
  }
  rawPayload = normalized.payload;

  // Reject governance fields
  if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    for (const key of Object.keys(rawPayload)) {
      if (GOVERNANCE_FIELDS.has(key)) {
        console.error("hook: stdin contains governance fields — rejected.");
        process.exitCode = 1;
        return;
      }
    }
  }

  // Validate hook-specific schema
  const allowed = HOOK_ALLOWED_STDIN_FIELDS[hookName];
  if (allowed && rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    for (const key of Object.keys(rawPayload)) {
      if (!allowed.includes(key)) {
        console.error(`hook: stdin contains unknown field "${key}" for hook ${hookName} — rejected.`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // ─── Stop / SubagentStop — no service required ──────────────────────────
  // Nonterminal events. Never submit to the Journal. Handle before service
  // opening since these may be called without a coordination context.

  if (hookName === "Stop" || hookName === "SubagentStop") {
    const result = executeClaudeHook(null, hookName, rawPayload);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  // Open service at .agent-runtime/coordination
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  let service;
  let ownedService = false;
  try {
    const { CoordinationApplicationService } = require("../../coordination/application-service");
    const { loadAuthorizationPolicy } = require("../../coordination/authorization-policy");
    const runtimeRoot = path.join(projectRoot, ".agent-runtime");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const runtimeIgnore = path.join(runtimeRoot, ".gitignore");
    if (!fs.existsSync(runtimeIgnore)) {
      fs.writeFileSync(runtimeIgnore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
    }
    service = CoordinationApplicationService.open(
      path.join(runtimeRoot, "coordination"),
      { authorization: loadAuthorizationPolicy(projectRoot) },
    );
    ownedService = true;
  } catch (_) {
    console.error("hook: unable to open coordination service.");
    process.exitCode = 3;
    return;
  }

  try {
    const result = executeClaudeHook(service, hookName, rawPayload);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error("hook: internal error —", err.message || err);
    process.exitCode = 2;
  } finally {
    if (ownedService && service && typeof service.close === "function") service.close();
  }
}

module.exports = {
  normalizeClaudeNativePayload,
  CLAUDE_NATIVE_EVENT_NAMES,
  hook,
};
