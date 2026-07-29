"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scanContent } = require("../secret-scan");

const OPERATION_STATUS = Object.freeze([
  "planned", "inspected", "awaiting_authorization", "authorized", "executing",
  "succeeded", "failed", "denied", "canceled", "timed_out", "blocked",
]);
const TERMINAL = new Set(["succeeded", "failed", "denied", "canceled", "timed_out"]);
const LEGAL = Object.freeze({
  planned: ["inspected", "canceled"],
  inspected: ["awaiting_authorization", "authorized", "blocked", "canceled"],
  awaiting_authorization: ["authorized", "denied", "blocked", "canceled", "timed_out"],
  authorized: ["executing", "blocked", "canceled", "timed_out"],
  executing: ["succeeded", "failed", "canceled", "timed_out", "blocked"],
  blocked: [], succeeded: [], failed: [], denied: [], canceled: [], timed_out: [],
});
const EVENT_TYPES = Object.freeze({
  inspected: "operation.inspected",
  awaiting_authorization: "operation.authorization_requested",
  authorized: "operation.authorized",
  executing: "operation.started",
  succeeded: "operation.completed",
  failed: "operation.failed",
  denied: "operation.denied",
  canceled: "operation.canceled",
  timed_out: "operation.timed_out",
  blocked: "operation.blocked",
});

class OperationLifecycleError extends Error {
  constructor(code, details) {
    super(`[operation-lifecycle:${code}] ${JSON.stringify(details || {})}`);
    this.name = "OperationLifecycleError";
    this.code = code;
    this.details = details || {};
  }
}

// Canonical JSON: deterministic key ordering so equal logical values hash
// identically regardless of how callers constructed them. Required so that
// Operation IDs, readiness IDs, and authorization revisions are stable
// across processes and template locales.
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const entries = [];
  for (const key of keys) {
    if (value[key] === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${canonicalize(value[key])}`);
  }
  return `{${entries.join(",")}}`;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

// Forbidden field set: anything that smells like a private body must never
// reach a projection or durable resource. Used by readProjection and the
// rejectTainted helper to fail-closed if a writer slips sensitive content.
const FORBIDDEN_FIELDS = Object.freeze([
  "prompt", "system_prompt", "completion", "response",
  "tool_args", "tool_arguments", "tool_input", "tool_output",
  "stdout", "stderr", "transcript", "messages",
  "file_body", "file_content", "body",
  "exact_tokens", "exact_usage", "private_transcript",
]);

function rejectTainted(value, where) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const findings = scanContent(value);
    if (findings.length > 0) {
      throw new OperationLifecycleError("ERR_SENSITIVE_VALUE", {
        where,
        rule_id: findings[0].rule_id,
      });
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) rejectTainted(value[i], `${where}[${i}]`);
    return value;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_FIELDS.includes(key.toLowerCase())) {
        throw new OperationLifecycleError("ERR_FORBIDDEN_FIELD", { where: `${where}.${key}` });
      }
      rejectTainted(value[key], `${where}.${key}`);
    }
  }
  return value;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write: temp file in the same directory → renameSync. fsync on the
  // temp file reduces the chance of a zero-length file surviving a crash.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeSync(handle, payload);
    try { fs.fsyncSync(handle); } catch (_) { /* fsync unavailable on this FS */ }
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(value)}\n`);
    try { fs.fsyncSync(handle); } catch (_) { /* fsync unavailable on this FS */ }
  } finally {
    fs.closeSync(handle);
  }
}

function cleanRefs(values) {
  return Array.from(new Set(Array.isArray(values) ? values.filter((value) => typeof value === "string") : []));
}

function requireText(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new OperationLifecycleError("ERR_REQUIRED_FIELD", { field });
  return value;
}

function createReadiness(input) {
  const operation = input.operation || {};
  const revision = requireText(input.revision, "revision");
  const verdict = requireText(input.verdict, "verdict");
  if (!new Set(["ready", "warning", "blocked"]).has(verdict)) throw new OperationLifecycleError("ERR_READINESS_VERDICT", { verdict });
  const basis = { revision, verdict, operation, resolved: input.resolved || {}, decisions_required: input.decisions_required || [], warnings: input.warnings || [], blocked_by: input.blocked_by || [], next_actions: input.next_actions || [] };
  const readiness = { schema_version: "1.0", readiness_id: input.readiness_id || `RD-${stableHash(basis).slice(0, 16)}`, ...basis, inspected_at: requireText(input.inspected_at, "inspected_at") };
  rejectTainted(readiness, "readiness");
  return Object.freeze(readiness);
}

function createAuthorization(input) {
  const scope = input.scope || {};
  const authorization = {
    schema_version: "1.0",
    authorization_id: requireText(input.authorization_id, "authorization_id"),
    decision_id: requireText(input.decision_id, "decision_id"),
    decision_source: requireText(input.decision_source, "decision_source"),
    policy: requireText(input.policy, "policy"),
    reason: requireText(input.reason, "reason"),
    scope,
    validity: input.validity || { mode: "single" },
    child_inheritance: input.child_inheritance === true,
    consumed_operation_ids: cleanRefs(input.consumed_operation_ids),
    revoked_at: input.revoked_at || null,
    expires_at: input.expires_at || null,
    created_at: requireText(input.created_at, "created_at"),
  };
  authorization.revision = input.revision || stableHash({ decision_id: authorization.decision_id, scope, validity: authorization.validity });
  rejectTainted(authorization, "authorization");
  return Object.freeze(authorization);
}

function authorizeForOperation(authorization, operation, at) {
  if (authorization.revoked_at) throw new OperationLifecycleError("ERR_AUTHORIZATION_REVOKED", {});
  if (authorization.expires_at && Date.parse(at) >= Date.parse(authorization.expires_at)) throw new OperationLifecycleError("ERR_AUTHORIZATION_EXPIRED", {});
  if (authorization.validity.mode === "single" && authorization.consumed_operation_ids.length > 0 && !authorization.consumed_operation_ids.includes(operation.operation_id)) {
    throw new OperationLifecycleError("ERR_AUTHORIZATION_CONSUMED", {});
  }
  if (authorization.scope.revision && authorization.scope.revision !== operation.target_revision) throw new OperationLifecycleError("ERR_AUTHORIZATION_SCOPE", { field: "revision" });
  if (authorization.scope.repository && authorization.scope.repository !== operation.target.repository) throw new OperationLifecycleError("ERR_AUTHORIZATION_SCOPE", { field: "repository" });
  return Object.freeze({ ...authorization, consumed_operation_ids: cleanRefs([...authorization.consumed_operation_ids, operation.operation_id]) });
}

function consumeAuthorization(root, authorization, operation, at) {
  const directory = path.join(root, ".agent", "authorizations");
  fs.mkdirSync(directory, { recursive: true });
  const resource = path.join(directory, `${authorization.authorization_id}.json`);
  const lock = `${resource}.lock`;
  const lockOwner = acquireAuthorizationLock(lock, authorization.authorization_id);
  try {
    const current = fs.existsSync(resource)
      ? JSON.parse(fs.readFileSync(resource, "utf8"))
      : authorization;
    if (current.revision !== authorization.revision) {
      throw new OperationLifecycleError("ERR_AUTHORIZATION_REVISION", {
        authorization_id: authorization.authorization_id,
      });
    }
    rejectTainted(current, "authorization");
    const consumed = authorizeForOperation(current, operation, at);
    atomicJson(resource, consumed);
    return consumed;
  } finally {
    releaseAuthorizationLock(lock, lockOwner);
  }
}

function acquireAuthorizationLock(lock, authorizationId) {
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeSync(handle, `${JSON.stringify(owner)}\n`);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      return owner;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let observed;
      try {
        observed = JSON.parse(fs.readFileSync(lock, "utf8"));
      } catch {
        throw new OperationLifecycleError("ERR_AUTHORIZATION_LOCK_INVALID", {
          authorization_id: authorizationId,
        });
      }
      if (!Number.isInteger(observed.pid) || typeof observed.nonce !== "string"
        || isProcessAlive(observed.pid)) {
        throw new OperationLifecycleError("ERR_AUTHORIZATION_CONFLICT", {
          authorization_id: authorizationId,
        });
      }
      const stale = `${lock}.stale.${owner.nonce}`;
      try {
        fs.renameSync(lock, stale);
      } catch {
        continue;
      }
      const moved = JSON.parse(fs.readFileSync(stale, "utf8"));
      if (moved.pid !== observed.pid || moved.nonce !== observed.nonce) {
        if (!fs.existsSync(lock)) fs.renameSync(stale, lock);
        throw new OperationLifecycleError("ERR_AUTHORIZATION_CONFLICT", {
          authorization_id: authorizationId,
        });
      }
      fs.unlinkSync(stale);
    }
  }
  throw new OperationLifecycleError("ERR_AUTHORIZATION_CONFLICT", {
    authorization_id: authorizationId,
  });
}

function releaseAuthorizationLock(lock, owner) {
  if (!fs.existsSync(lock)) return;
  let current;
  try {
    current = JSON.parse(fs.readFileSync(lock, "utf8"));
  } catch {
    return;
  }
  if (current.pid === owner.pid && current.nonce === owner.nonce) fs.unlinkSync(lock);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function createOperation(input) {
  const relations = input.relations || {};
  const operationId = requireText(input.operation_id, "operation_id");
  const attempt = Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new OperationLifecycleError("ERR_ATTEMPT", { attempt });
  const operation = {
    schema_version: "1.0",
    operation_id: operationId,
    attempt,
    kind: requireText(input.kind, "kind"),
    status: "planned",
    relations: {
      task_id: requireText(relations.task_id, "relations.task_id"),
      run_id: requireText(relations.run_id, "relations.run_id"),
      session_id: requireText(relations.session_id, "relations.session_id"),
      workspace_id: requireText(relations.workspace_id, "relations.workspace_id"),
      parent_operation_id: relations.parent_operation_id || null,
      retry_of_operation_id: relations.retry_of_operation_id || null,
      compensation_for_operation_id: relations.compensation_for_operation_id || null,
    },
    actor: input.actor || {}, owner: requireText(input.owner, "owner"), workflow: requireText(input.workflow, "workflow"),
    action: input.action || {}, input_summary: input.input_summary || {}, target: input.target || {}, target_revision: requireText(input.target_revision, "target_revision"),
    authorization_ref: null, readiness_ref: null, usage: { quality: "unavailable" }, evidence_refs: [], log_cursor_refs: [], latest_event_id: null,
    created_at: requireText(input.created_at, "created_at"), updated_at: requireText(input.created_at, "created_at"),
  };
  return Object.freeze(operation);
}

function transition(operation, to, context) {
  if (!OPERATION_STATUS.includes(to)) throw new OperationLifecycleError("ERR_UNKNOWN_STATUS", { to });
  if (TERMINAL.has(operation.status) || !LEGAL[operation.status].includes(to)) throw new OperationLifecycleError("ERR_ILLEGAL_TRANSITION", { from: operation.status, to });
  if (to === "inspected" && !context.readiness) throw new OperationLifecycleError("ERR_READINESS_REQUIRED", {});
  if (to === "authorized" && !context.authorization) throw new OperationLifecycleError("ERR_AUTHORIZATION_REQUIRED", {});
  const at = requireText(context.at, "at");
  const eventId = context.event_id || `E-${operation.operation_id}-${operation.attempt}-${stableHash([operation.status, to, at]).slice(0, 12)}`;
  const event = Object.freeze({
    event_id: eventId,
    resource_type: "operation",
    resource_id: operation.operation_id,
    type: EVENT_TYPES[to],
    at,
    actor: context.actor || operation.actor,
    transition: { from: operation.status, to },
    message: context.message || null,
    evidence_refs: cleanRefs(context.evidence_refs),
    log_cursor_refs: cleanRefs(context.log_cursor_refs),
    readiness_ref: context.readiness ? context.readiness.readiness_id : null,
    authorization_ref: context.authorization ? context.authorization.authorization_id : null,
    previous_event_id: operation.latest_event_id,
  });
  const next = Object.freeze({ ...operation, status: to, readiness_ref: context.readiness ? context.readiness.readiness_id : operation.readiness_ref, authorization_ref: context.authorization ? context.authorization.authorization_id : operation.authorization_ref, evidence_refs: cleanRefs([...operation.evidence_refs, ...event.evidence_refs]), log_cursor_refs: cleanRefs([...operation.log_cursor_refs, ...event.log_cursor_refs]), latest_event_id: eventId, updated_at: at });
  return { operation: next, event };
}

function paths(root, operationId) {
  const base = path.join(root, ".agent", "operations");
  return {
    resource: path.join(base, `${operationId}.json`),
    events: path.join(base, "events.jsonl"),
    readiness: path.join(root, ".agent", "readiness"),
    authorizations: path.join(root, ".agent", "authorizations"),
    checkpoints: path.join(root, ".agent", "checkpoints"),
  };
}

function writeAttempt(root, operation) {
  // Reject any forbidden content up front: a planned operation must never
  // carry a private body, prompt, or tool payload, even before any
  // transition. The frozen resource is what readers and projectors see.
  rejectTainted(operation, "operation");
  const resource = paths(root, operation.operation_id).resource;
  const created = createJsonExclusive(resource, operation);
  if (!created) {
    const existing = JSON.parse(fs.readFileSync(resource, "utf8"));
    if (canonicalize(operationIdentity(existing))
      !== canonicalize(operationIdentity(operation))) {
      throw new OperationLifecycleError("ERR_OPERATION_CONFLICT", {
        operation_id: operation.operation_id,
      });
    }
    return Object.freeze(existing);
  }
  return operation;
}

function createJsonExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.unlinkSync(temporary);
  }
}

function operationIdentity(operation) {
  return {
    operation_id: operation.operation_id,
    attempt: operation.attempt,
    kind: operation.kind,
    relations: operation.relations,
    actor: operation.actor,
    owner: operation.owner,
    workflow: operation.workflow,
    action: operation.action,
    input_summary: operation.input_summary,
    target: operation.target,
    target_revision: operation.target_revision,
  };
}

function writeTransition(root, operation, to, context) {
  const recovered = recoverOperation(root, operation.operation_id);
  const current = recovered ? recovered.resource : operation;
  if (current.status !== operation.status
    || current.latest_event_id !== operation.latest_event_id) {
    throw new OperationLifecycleError("ERR_OPERATION_REVISION", {
      operation_id: operation.operation_id,
      expected_status: operation.status,
      actual_status: current.status,
    });
  }
  const result = transition(operation, to, context);
  rejectTainted(result.operation, "operation");
  rejectTainted(result.event, "event");
  if (context.readiness) rejectTainted(context.readiness, "readiness");
  if (context.authorization) rejectTainted(context.authorization, "authorization");
  if (context.readiness) atomicJson(path.join(paths(root, operation.operation_id).readiness, `${context.readiness.readiness_id}.json`), context.readiness);
  if (context.authorization) atomicJson(path.join(paths(root, operation.operation_id).authorizations, `${context.authorization.authorization_id}.json`), context.authorization);
  // The journal is authoritative. Persist referenced projections first, then
  // append the event, and update the derived resource last. A crash after the
  // append is repaired by replay; a resource is never used to invent history.
  const events = readOperationEvents(paths(root, operation.operation_id).events, operation.operation_id);
  if (!events.some((event) => event.event_id === result.event.event_id)) {
    appendJsonl(paths(root, operation.operation_id).events, result.event);
  }
  atomicJson(paths(root, operation.operation_id).resource, result.operation);
  return result;
}

// writeCheckpoint: persistent recovery reference for handoff, context
// compaction, and Agent replacement. Always redaction-safe (forbidden
// fields raise). The checkpoint_id is derived from operation_id + a caller-
// supplied scope, never from prompt/file bodies.
function writeCheckpoint(root, checkpoint) {
  if (!plain(checkpoint)) throw new OperationLifecycleError("ERR_CHECKPOINT_INVALID", {});
  requireText(checkpoint.checkpoint_id, "checkpoint_id");
  requireText(checkpoint.operation_id, "operation_id");
  requireText(checkpoint.task_id, "task_id");
  rejectTainted(checkpoint, "checkpoint");
  atomicJson(path.join(paths(root, checkpoint.operation_id).checkpoints, `${checkpoint.checkpoint_id}.json`), checkpoint);
  return checkpoint;
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOperationEvents(file, operationId) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.resource_id === operationId);
}

// The append-only journal is authoritative; the resource is a projection.
// Recovery only replays recorded events and never synthesizes missing facts.
function recoverOperation(root, operationId) {
  const p = paths(root, operationId);
  if (!fs.existsSync(p.resource)) return null;
  const resource = JSON.parse(fs.readFileSync(p.resource, "utf8"));
  const events = readOperationEvents(p.events, operationId);
  if (events.length === 0) {
    if (resource.latest_event_id) {
      throw new OperationLifecycleError("ERR_RECOVERY_JOURNAL_MISSING", {
        operation_id: operationId,
        latest_event_id: resource.latest_event_id,
      });
    }
    return Object.freeze({ recovered: false, resource });
  }
  const projected = replay(resource, events);
  const recovered = projected.latest_event_id !== resource.latest_event_id
    || projected.status !== resource.status;
  if (recovered) atomicJson(p.resource, projected);
  return Object.freeze({ recovered, resource: projected });
}

function replay(operation, events) {
  let current = { ...operation, status: "planned", latest_event_id: null, readiness_ref: null, authorization_ref: null, evidence_refs: [], log_cursor_refs: [] };
  const seen = new Set();
  for (const event of events) {
    if (!event || event.resource_type !== "operation"
      || event.resource_id !== operation.operation_id
      || typeof event.event_id !== "string"
      || seen.has(event.event_id)
      || event.previous_event_id !== current.latest_event_id
      || !event.transition
      || event.transition.from !== current.status) {
      throw new OperationLifecycleError("ERR_REPLAY_CHAIN", {
        event_id: event && event.event_id,
      });
    }
    if (!LEGAL[current.status].includes(event.transition.to)) throw new OperationLifecycleError("ERR_REPLAY_TRANSITION", { event_id: event.event_id });
    if (event.type !== EVENT_TYPES[event.transition.to]) {
      throw new OperationLifecycleError("ERR_REPLAY_EVENT_TYPE", {
        event_id: event.event_id,
        type: event.type,
      });
    }
    rejectTainted(event, "event");
    seen.add(event.event_id);
    current = {
      ...current,
      status: event.transition.to,
      latest_event_id: event.event_id,
      updated_at: event.at,
      readiness_ref: event.readiness_ref || current.readiness_ref,
      authorization_ref: event.authorization_ref || current.authorization_ref,
      evidence_refs: cleanRefs([...current.evidence_refs, ...event.evidence_refs]),
      log_cursor_refs: cleanRefs([...current.log_cursor_refs, ...event.log_cursor_refs]),
    };
  }
  return Object.freeze(current);
}

function readProjection(root, query, filter) {
  const directories = { operations: ".agent/operations", readiness: ".agent/readiness", authorizations: ".agent/authorizations", checkpoints: ".agent/checkpoints" };
  if (!directories[query]) throw new OperationLifecycleError("ERR_QUERY", { query });
  const directory = path.join(root, directories[query]);
  const resources = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => {
        const value = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        // Redaction guard: a projection must never leak a forbidden field.
        // Forbidden fields are stripped, not raised, so legacy resources
        // written before this rule still project cleanly. The resource on
        // disk is left untouched; the projection is sanitized.
        return sanitizeForProjection(value);
      })
    : [];
  const selected = filter ? resources.filter(filter) : resources;
  return Object.freeze({ ok: true, query, generated_at: new Date().toISOString(), resources: selected, summary: { total: selected.length } });
}

function sanitizeForProjection(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeForProjection(entry));
  if (typeof value === "string") {
    return scanContent(value).length > 0 ? "[REDACTED]" : value;
  }
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELDS.includes(key.toLowerCase())) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitizeForProjection(value[key]);
    }
  }
  return out;
}

module.exports = {
  OPERATION_STATUS,
  TERMINAL,
  LEGAL,
  EVENT_TYPES,
  FORBIDDEN_FIELDS,
  OperationLifecycleError,
  createReadiness,
  createAuthorization,
  authorizeForOperation,
  consumeAuthorization,
  createOperation,
  transition,
  writeAttempt,
  writeTransition,
  writeCheckpoint,
  recoverOperation,
  replay,
  readProjection,
  canonicalize,
  stableHash,
  rejectTainted,
  sanitizeForProjection,
};
