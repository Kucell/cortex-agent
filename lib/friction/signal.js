"use strict";

// ─── Friction Signal Contract (P-003 / M-003A) ─────────────────────────────
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// Public API:
//   - FRICTION_EVENT_SCHEMA_VERSION      : "1"
//   - FRICTION_EVENT_ID_PREFIX           : "FS-"
//   - FRICTION_SIGNAL_TYPES              : frozen signal-type vocabulary
//   - FRICTION_OBSERVABILITY_LEVELS      : frozen observability enum
//   - FRICTION_REDACTION_POSTURES        : frozen redaction posture enum
//   - FRICTION_EVENT_DIR                 : canonical on-disk directory name
//   - FrictionSignalError                : structured error code carrier
//   - validateFrictionEvent(input)       : throws / returns frozen canonical event
//   - recordFrictionEvent(root, event)   : append a validated event to signals.jsonl
//   - signalFilePath(root)               : absolute path to signals.jsonl
//   - readFrictionEvents(root)           : parse JSONL, skip malformed, count them
//
// REDACTION GUARD (P-003 §6):
//   No prompt, user message, command/tool argument, tool output, credential,
//   file content, or free-form correction text may ever enter an event. This
//   is enforced by the closed schema below: the only persisted fields are
//   counts, types, timestamps, opaque evidence_refs, and stable ids. There is
//   NO generic "body" / "payload" / "details" / "context" / "message" /
//   "reason" / "args" / "output" field. Adapters MUST pre-strip free-form
//   text BEFORE handing a candidate to validateFrictionEvent.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FRICTION_EVENT_SCHEMA_VERSION = "1";
const FRICTION_EVENT_ID_PREFIX = "FS-";
const FRICTION_EVENT_DIR = ".agent/runtime-evidence/friction";
const FRICTION_SIGNAL_FILE = "signals.jsonl";

const FRICTION_SIGNAL_TYPES = Object.freeze([
  "tool_denied",
  "tool_failed",
  "tool_retried",
  "user_interrupted",
  "user_correction",
  "lifecycle_stop",
]);

const FRICTION_OBSERVABILITY_LEVELS = Object.freeze([
  "observed",
  "derived",
  "not_observed",
  "not_supported",
]);

const FRICTION_REDACTION_POSTURES = Object.freeze([
  "aggregate_only",
  "full",
]);

const FRICTION_SIGNAL_TYPE_SET = new Set(FRICTION_SIGNAL_TYPES);
const FRICTION_OBSERVABILITY_SET = new Set(FRICTION_OBSERVABILITY_LEVELS);
const FRICTION_REDACTION_SET = new Set(FRICTION_REDACTION_POSTURES);

// Practical bounds — kept small to make audit inspection trivial.
const MAX_SIGNAL_ID_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_HOST_LENGTH = 64;
const MAX_EVIDENCE_REF_LENGTH = 256;
const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// Closed-schema. Any extra top-level field is rejected (fail-loud).
const KNOWN_EVENT_TOP_KEYS = new Set([
  "schema_version",
  "signal_id",
  "session_id",
  "host",
  "type",
  "observability",
  "count",
  "occurred_at",
  "evidence_ref",
  "redaction",
]);

class FrictionSignalError extends Error {
  constructor(code, details) {
    super(`[friction-signal:${code}] ${describe(details)}`);
    this.name = "FrictionSignalError";
    this.code = code;
    this.details = details || {};
  }
}

function describe(details) {
  if (!details || typeof details !== "object") return "";
  try {
    return JSON.stringify(details);
  } catch (_) {
    return String(details);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return value;
}

function asNonEmptyString(value, where, max) {
  if (typeof value !== "string" || value.length === 0) {
    throw new FrictionSignalError("ERR_FIELD_NOT_STRING", { where });
  }
  if (value.length > max) {
    throw new FrictionSignalError("ERR_FIELD_TOO_LONG", { where, maxLength: max });
  }
  return value;
}

function rejectUnknownKeys(obj, known, where) {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new FrictionSignalError("ERR_FIELD_UNKNOWN", { where, key });
    }
  }
}

function normaliseTimestamp(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    throw new FrictionSignalError("ERR_TIMESTAMP_INVALID", {
      where,
      reason: "unsupported_type",
    });
  }
  if (!ISO_TIMESTAMP_REGEX.test(value)) {
    throw new FrictionSignalError("ERR_TIMESTAMP_INVALID", {
      where,
      reason: "non_iso_string",
    });
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new FrictionSignalError("ERR_TIMESTAMP_INVALID", {
      where,
      reason: "unparseable",
    });
  }
  return d.toISOString();
}

function generateSignalId() {
  // Prefer the standard UUID; fall back to hex for older Node builds.
  if (typeof crypto.randomUUID === "function") {
    return `${FRICTION_EVENT_ID_PREFIX}${crypto.randomUUID()}`;
  }
  const hex = crypto.randomBytes(16).toString("hex");
  return `${FRICTION_EVENT_ID_PREFIX}${hex}`;
}

// Frozen validator. Returns a normalised deep-frozen canonical event. The
// schema is closed: any extra top-level field is rejected. There is no
// generic "body" / "payload" / "context" / "details" / "message" key on
// purpose — see the REDACTION GUARD comment at the top of this file.
function validateFrictionEvent(input, { generateId = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FrictionSignalError("ERR_EVENT_NOT_OBJECT", { where: "event" });
  }
  rejectUnknownKeys(input, KNOWN_EVENT_TOP_KEYS, "event");

  const schemaVersion = asNonEmptyString(input.schema_version, "event.schema_version", 16);
  if (schemaVersion !== FRICTION_EVENT_SCHEMA_VERSION) {
    throw new FrictionSignalError("ERR_SCHEMA_VERSION_UNKNOWN", {
      where: "event.schema_version",
      value: schemaVersion,
    });
  }

  let signalId = input.signal_id;
  if (signalId === undefined || signalId === null) {
    if (!generateId) {
      throw new FrictionSignalError("ERR_FIELD_REQUIRED", {
        where: "event.signal_id",
      });
    }
    signalId = generateSignalId();
  } else {
    signalId = asNonEmptyString(signalId, "event.signal_id", MAX_SIGNAL_ID_LENGTH);
    if (!signalId.startsWith(FRICTION_EVENT_ID_PREFIX)) {
      throw new FrictionSignalError("ERR_SIGNAL_ID_PREFIX_MISSING", {
        where: "event.signal_id",
        value: signalId,
      });
    }
  }

  const sessionId = asNonEmptyString(input.session_id, "event.session_id", MAX_SESSION_ID_LENGTH);
  const host = asNonEmptyString(input.host, "event.host", MAX_HOST_LENGTH);

  const type = asNonEmptyString(input.type, "event.type", 32);
  if (!FRICTION_SIGNAL_TYPE_SET.has(type)) {
    throw new FrictionSignalError("ERR_SIGNAL_TYPE_UNKNOWN", {
      where: "event.type",
      value: type,
    });
  }

  const observability = asNonEmptyString(input.observability, "event.observability", 32);
  if (!FRICTION_OBSERVABILITY_SET.has(observability)) {
    throw new FrictionSignalError("ERR_OBSERVABILITY_UNKNOWN", {
      where: "event.observability",
      value: observability,
    });
  }

  const count = input.count;
  if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count <= 0) {
    throw new FrictionSignalError("ERR_COUNT_INVALID", {
      where: "event.count",
      value: count,
    });
  }

  const occurredAt = normaliseTimestamp(input.occurred_at, "event.occurred_at");
  const evidenceRef = asNonEmptyString(input.evidence_ref, "event.evidence_ref", MAX_EVIDENCE_REF_LENGTH);

  const redaction = asNonEmptyString(input.redaction, "event.redaction", 32);
  if (!FRICTION_REDACTION_SET.has(redaction)) {
    throw new FrictionSignalError("ERR_REDACTION_UNKNOWN", {
      where: "event.redaction",
      value: redaction,
    });
  }

  const out = {
    schema_version: FRICTION_EVENT_SCHEMA_VERSION,
    signal_id: signalId,
    session_id: sessionId,
    host,
    type,
    observability,
    count,
    occurred_at: occurredAt,
    evidence_ref: evidenceRef,
    redaction,
  };
  return deepFreeze(out);
}

function signalFilePath(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new FrictionSignalError("ERR_PROJECT_ROOT_INVALID", { where: "projectRoot" });
  }
  return path.join(projectRoot, FRICTION_EVENT_DIR, FRICTION_SIGNAL_FILE);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

// Append-only writer. Validates the event BEFORE touching the filesystem and
// never overwrites or rewrites prior lines. Atomicity is best-effort:
// fs.appendFileSync opens with O_APPEND so concurrent appenders see whole
// lines; we do NOT truncate.
function recordFrictionEvent(projectRoot, event) {
  const validated = validateFrictionEvent(event);
  const filePath = signalFilePath(projectRoot);
  ensureDir(filePath);
  const line = `${JSON.stringify(validated)}\n`;
  fs.appendFileSync(filePath, line, { encoding: "utf8" });
  return Object.freeze({ path: filePath, signal_id: validated.signal_id });
}

function readFrictionEvents(projectRoot) {
  const filePath = signalFilePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return Object.freeze({ events: [], malformed: 0, path: filePath });
  }
  const text = fs.readFileSync(filePath, { encoding: "utf8" });
  const events = [];
  let malformed = 0;
  if (text.length === 0) {
    return Object.freeze({ events, malformed, path: filePath });
  }
  const lines = text.split("\n");
  for (const raw of lines) {
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw);
      // Defensive: re-validate so corrupted-but-parseable lines never reach
      // downstream scorers. Use validate-only mode (no id generation).
      const revalidated = validateFrictionEvent(parsed, { generateId: false });
      events.push(revalidated);
    } catch (_) {
      malformed += 1;
    }
  }
  return Object.freeze({ events, malformed, path: filePath });
}

module.exports = {
  FRICTION_EVENT_SCHEMA_VERSION,
  FRICTION_EVENT_ID_PREFIX,
  FRICTION_EVENT_DIR,
  FRICTION_SIGNAL_TYPES,
  FRICTION_OBSERVABILITY_LEVELS,
  FRICTION_REDACTION_POSTURES,
  FrictionSignalError,
  validateFrictionEvent,
  recordFrictionEvent,
  signalFilePath,
  readFrictionEvents,
};
