"use strict";

// ─── Cross-host Handoff (MS-010 / P-004) ────────────────────────────────────
//
// When a task moves from one host to another (Codex → Pi, Claude → Codex,
// etc.) the handoff package must:
//
//   * Carry enough state for the new host to resume, but never leak the
//     full prompt, tool arguments, or secrets from the source host.
//   * Carry a fencing token so the source host can recognise and reject
//     late operations it never initiated.
//   * Carry an opaque checkpoint reference so the new host can resume from
//     the agreed point.
//   * Start a new Operation attempt (never silently reuse the source
//     operation). The attempt is created through the existing dispatch
//     owner so the existing state machine remains authoritative.
//
// This module is a pure composer: it does NOT write files, acquire leases,
// or call MCP. All side effects happen via the caller-provided owner.

const crypto = require("node:crypto");

const { dispatch } = require("./capability-aware-dispatch");
const { BoundaryEventError, validateBoundaryEvent } = require("./boundary-event");

const SCHEMA_VERSION = "1.0";
const TAINT_PATTERNS = [
  { id: "pem_private_key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/ },
  { id: "github_pat", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: "openai_project_key", regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai_legacy_key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "url_userinfo", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { id: "env_body", regex: /^[A-Z_][A-Z0-9_]*=[^\s]{8,}$/m },
];

const SECRET_FIELD_NAMES = new Set([
  "password", "passwd", "secret", "token", "api_key", "apikey",
  "authorization", "auth", "cookie", "session_cookie",
  "private_key", "client_secret", "bearer",
]);

class CrossHostHandoffError extends Error {
  constructor(code, details) {
    super(`[cross-host-handoff:${code}] ${JSON.stringify(details || {})}`);
    this.name = "CrossHostHandoffError";
    this.code = code;
    this.details = details || {};
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTainted(value) {
  if (value === null || value === undefined) return false;
  if (value === "[REDACTED]") return false;
  if (typeof value === "string") {
    for (const rule of TAINT_PATTERNS) if (rule.regex.test(value)) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some(isTainted);
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
        // Field name is secret-typed; flag if the value is not already redacted.
        if (value[key] !== "[REDACTED]") return true;
        continue;
      }
      if (isTainted(value[key])) return true;
    }
  }
  return false;
}

function redactValue(value, keyHint) {
  if (value === null || value === undefined) return value;
  if (typeof keyHint === "string" && SECRET_FIELD_NAMES.has(keyHint.toLowerCase())) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    if (isTainted(value)) return "[REDACTED]";
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = redactValue(value[key], key);
    }
    return out;
  }
  return value;
}

const REDACTED_FIELDS = Object.freeze([
  "prompt", "system_prompt", "completion", "response",
  "tool_args", "tool_arguments", "tool_input", "tool_output",
  "stdout", "stderr", "transcript", "messages",
  "file_body", "file_content", "body",
]);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

function buildContextPackage(source) {
  if (!plain(source)) throw new CrossHostHandoffError("ERR_SOURCE_INVALID", {});
  if (typeof source.operation_id !== "string") {
    throw new CrossHostHandoffError("ERR_SOURCE_OPERATION_REQUIRED", {});
  }
  if (typeof source.host_profile_ref !== "string") {
    throw new CrossHostHandoffError("ERR_SOURCE_HOST_REQUIRED", {});
  }
  if (typeof source.task_id !== "string") {
    throw new CrossHostHandoffError("ERR_SOURCE_TASK_REQUIRED", {});
  }
  if (source.boundary_events !== undefined && !Array.isArray(source.boundary_events)) {
    throw new CrossHostHandoffError("ERR_SOURCE_BOUNDARY_EVENTS_INVALID", {});
  }
  if (source.context_trajectory !== undefined && !plain(source.context_trajectory)) {
    throw new CrossHostHandoffError("ERR_SOURCE_TRAJECTORY_INVALID", {});
  }

  // Validate any provided boundary events against the frozen envelope.
  const events = Array.isArray(source.boundary_events) ? source.boundary_events : [];
  const validatedEvents = [];
  for (let i = 0; i < events.length; i += 1) {
    try {
      validatedEvents.push(validateBoundaryEvent(events[i]));
    } catch (error) {
      if (error instanceof BoundaryEventError) {
        throw new CrossHostHandoffError("ERR_SOURCE_EVENT_INVALID", { index: i, code: error.code });
      }
      throw error;
    }
  }

  // Redact context
  const redactedSource = {};
  for (const key of Object.keys(source)) {
    if (REDACTED_FIELDS.includes(key)) {
      redactedSource[key] = "[REDACTED]";
    } else if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      redactedSource[key] = "[REDACTED]";
    } else {
      redactedSource[key] = redactValue(source[key]);
    }
  }

  const checkpoint = {
    schema_version: SCHEMA_VERSION,
    checkpoint_id: `CHK-${source.operation_id}-${Date.now()}`,
    taken_at: new Date().toISOString(),
    operation_id: source.operation_id,
    host_profile_ref: source.host_profile_ref,
    task_id: source.task_id,
    trajectory_digest: source.context_trajectory
      ? crypto.createHash("sha256").update(JSON.stringify(source.context_trajectory)).digest("hex")
      : null,
    boundary_event_count: validatedEvents.length,
    revision: crypto.createHash("sha256").update(JSON.stringify({
      operation_id: source.operation_id,
      host_profile_ref: source.host_profile_ref,
      task_id: source.task_id,
      events: validatedEvents.map((e) => e.event_id),
    })).digest("hex"),
  };

  const fencingToken = `FT-${crypto.randomBytes(16).toString("hex")}`;

  const contextPackage = {
    schema_version: SCHEMA_VERSION,
    package_id: `CTXP-${source.operation_id}-${Date.now()}`,
    created_at: checkpoint.taken_at,
    operation_id: source.operation_id,
    source_host_profile_ref: source.host_profile_ref,
    task_id: source.task_id,
    redacted_summary: redactedSource,
    boundary_events: validatedEvents,
    checkpoint,
    fencing_token: fencingToken,
    redaction_policy: Object.freeze({
      prompt: "stripped",
      tool_arguments: "stripped",
      secrets: "stripped",
      body_fields: REDACTED_FIELDS,
    }),
  };

  // Final guard: nothing in the package may be tainted
  if (isTainted(contextPackage.redacted_summary) || isTainted(contextPackage.boundary_events)) {
    throw new CrossHostHandoffError("ERR_REDACTION_FAILED", {});
  }

  return deepFreeze(contextPackage);
}

function handoff(source, requirement, snapshots, owner, options) {
  if (!options || typeof options !== "object") {
    throw new CrossHostHandoffError("ERR_OPTIONS_REQUIRED", {});
  }
  if (typeof options.now !== "string") {
    throw new CrossHostHandoffError("ERR_OPTIONS_NOW_REQUIRED", {});
  }
  const contextPackage = buildContextPackage(source);

  const dispatchResult = dispatch(requirement, snapshots, owner, {
    now: options.now,
    ownerName: options.ownerName || "handoff-owner",
    idempotencyState: options.idempotencyState,
  });

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    handoff_id: `HANDOFF-${contextPackage.checkpoint.checkpoint_id}`,
    context_package: contextPackage,
    dispatch: dispatchResult,
    fencing_token: contextPackage.fencing_token,
    checkpoint: contextPackage.checkpoint,
    source_operation_id: source.operation_id,
    target_host_profile_ref: dispatchResult.host_profile_ref,
    new_operation_attempt_id: dispatchResult.operation_attempt_id,
  });
}

module.exports = {
  CrossHostHandoffError,
  REDACTED_FIELDS,
  SCHEMA_VERSION,
  buildContextPackage,
  handoff,
  isTainted,
  redactValue,
};