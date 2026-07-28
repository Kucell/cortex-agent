"use strict";

// ─── Runtime Boundary Event Contract (T-ARI-001 / P-001 / M-001) ───────────
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// Public API:
//   - RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION : "1.0"
//   - RUNTIME_BOUNDARY_EVENT_TYPES          : frozen event-type vocabulary
//   - RUNTIME_BOUNDARY_EVENT_DECISIONS      : frozen decision.result vocabulary
//   - BoundaryEventError                    : structured error
//   - validateBoundaryEvent(input)          : throws or returns frozen event
//
// Redaction philosophy (P-001 / M-001 §2.2 + §5):
//   - Default payload MUST NOT carry prompt text, full tool arguments, or
//     secrets. The contract defines BOUNDED SAFE FIELDS; callers must strip
//     anything else BEFORE handing the candidate to the validator.
//   - Free-form strings (evidence excerpts, error messages) are scanned for
//     secret-like patterns and rejected fail-closed.
//   - Closed-schema validation: host, decision, and the envelope itself
//     reject unknown fields. Vendor specifics belong inside
//     lib/runtime-adapters/* adapter code, not in the envelope.
//
// Idempotency (P-001 §5):
//   - event_id is the deduplication key. Must use the RBE- prefix and a
//     bounded safe identifier format. The validator freezes the envelope so
//     downstream writers can hash by JSON.stringify.

const RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION = "1.0";
const RUNTIME_BOUNDARY_EVENT_ID_PREFIX = "RBE-";

// Closed enum: every host Profile MUST declare its coverage subset of these.
const RUNTIME_BOUNDARY_EVENT_TYPES = Object.freeze([
  // session lifecycle
  "session.start",
  "session.end",
  // turn lifecycle
  "turn.start",
  "turn.end",
  // message lifecycle
  "message.start",
  "message.update",
  "message.end",
  // tool lifecycle
  "tool.before",
  "tool.update",
  "tool.after",
  // context pipeline
  "context.discovered",
  "context.selected",
  "context.rendered",
  "context.measured",
]);

const RUNTIME_BOUNDARY_EVENT_TYPE_SET = new Set(RUNTIME_BOUNDARY_EVENT_TYPES);

const RUNTIME_BOUNDARY_EVENT_DECISIONS = Object.freeze([
  "allowed",
  "denied",
  "blocked",
  "unavailable",
]);

const RUNTIME_BOUNDARY_EVENT_DECISION_SET = new Set(RUNTIME_BOUNDARY_EVENT_DECISIONS);

const RESOURCE_KINDS = Object.freeze(["tool", "message", "context", "session", "turn"]);

// ─── Bounds ────────────────────────────────────────────────────────────────
const MAX_EVENT_ID_LENGTH = 128;
const MIN_EVENT_ID_BODY_LENGTH = 1; // after the RBE- prefix
const EVENT_ID_BODY_REGEX = /^[A-Za-z0-9._\-]+$/;
const MAX_REASON_LENGTH = 512;
const MAX_DIGEST_LENGTH = 256;
const MAX_EVIDENCE_REFS = 16;
const MAX_EVIDENCE_REF_LENGTH = 256;
const MAX_CORRELATION_ID_LENGTH = 64;
const MAX_AT_LENGTH = 64;
const MAX_HOST_ADAPTER_ID_LENGTH = 64;
const MAX_HOST_SESSION_REF_LENGTH = 128;
const MAX_HOST_VERSION_LENGTH = 64;
const MAX_DECISION_AUTHORIZATION_REF_LENGTH = 256;
const CORRELATION_FIELDS = Object.freeze([
  "task_id",
  "run_id",
  "session_id",
  "operation_id",
  "trace_id",
]);
const CORRELATION_FIELD_SET = new Set(CORRELATION_FIELDS);

// Strict ISO-8601 — same predicate as capability-contract so producers and
// adapters agree on what's canonical.
const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const SECRET_FIELDS = Object.freeze([
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "auth",
  "cookie",
  "session_cookie",
  "private_key",
  "client_secret",
  "bearer",
]);

const TAINT_PATTERNS = Object.freeze([
  { id: "pem_private_key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/ },
  { id: "github_pat", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: "openai_project_key", regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai_legacy_key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "url_userinfo", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { id: "env_body", regex: /^[A-Z_][A-Z0-9_]*=[^\s]{8,}$/m },
]);

const KNOWN_EVENT_TOP_KEYS = new Set([
  "schema_version",
  "event_id",
  "type",
  "at",
  "host",
  "correlation",
  "resource",
  "capability",
  "decision",
  "evidence_refs",
]);
const KNOWN_HOST_KEYS = new Set(["adapter_id", "session_ref"]);
const KNOWN_DECISION_KEYS = new Set(["result", "authorization_ref", "reason"]);
const KNOWN_RESOURCE_KEYS = new Set(["kind", "name", "target_digest"]);

class BoundaryEventError extends Error {
  constructor(code, details) {
    const detailStr = describe(details);
    super(`[boundary-event:${code}] ${detailStr}`);
    this.name = "BoundaryEventError";
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

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asNonEmptyString(value, where, { maxLength = 4096 } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new BoundaryEventError("ERR_FIELD_NOT_STRING", { where });
  }
  if (value.length > maxLength) {
    throw new BoundaryEventError("ERR_FIELD_TOO_LONG", { where, maxLength });
  }
  return value;
}

function asOptionalString(value, where, { maxLength = 4096 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new BoundaryEventError("ERR_FIELD_NOT_STRING", { where });
  }
  if (value.length > maxLength) {
    throw new BoundaryEventError("ERR_FIELD_TOO_LONG", { where, maxLength });
  }
  return value;
}

// Deterministic ISO-8601 normaliser; rejects non-ISO strings rather than
// accepting any non-empty string.
function isValidIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_AT_LENGTH) return false;
  return ISO_TIMESTAMP_REGEX.test(value);
}

function normalizeTimestamp(value, where) {
  if (typeof value === "string") {
    if (!isValidIsoTimestamp(value)) {
      throw new BoundaryEventError("ERR_TIMESTAMP_INVALID", {
        where,
        reason: "non_iso_string",
      });
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new BoundaryEventError("ERR_TIMESTAMP_INVALID", {
        where,
        reason: "unparseable",
      });
    }
    return d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  throw new BoundaryEventError("ERR_TIMESTAMP_INVALID", {
    where,
    reason: "unsupported_type",
  });
}

function scanForTaint(value, where) {
  if (typeof value !== "string") return;
  for (const rule of TAINT_PATTERNS) {
    if (rule.regex.test(value)) {
      throw new BoundaryEventError("ERR_EVENT_TAINTED", {
        where,
        rule: rule.id,
      });
    }
  }
}

function hasSecretFieldName(key) {
  if (typeof key !== "string") return false;
  const normalised = key.toLowerCase();
  for (const name of SECRET_FIELDS) {
    if (normalised === name) return true;
    if (normalised.endsWith("_" + name) || normalised.endsWith("-" + name)) return true;
    if (normalised.includes(name) && (normalised.includes("password") || normalised.includes("secret"))) {
      return true;
    }
  }
  return false;
}

function walkNoTaint(value, where) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    scanForTaint(value, where);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkNoTaint(value[i], `${where}[${i}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (hasSecretFieldName(key)) {
        throw new BoundaryEventError("ERR_EVENT_TAINTED", {
          where: `${where}.${key}`,
          rule: "secret_field_name",
        });
      }
      walkNoTaint(value[key], `${where}.${key}`);
    }
  }
}

function rejectUnknownKeys(obj, known, where) {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new BoundaryEventError("ERR_FIELD_UNKNOWN", { where, key });
    }
  }
}

function validateHost(value, where) {
  if (!isPlainObject(value)) {
    throw new BoundaryEventError("ERR_HOST_MISSING", { where });
  }
  rejectUnknownKeys(value, KNOWN_HOST_KEYS, `${where}.host`);
  const adapterId = asNonEmptyString(value.adapter_id, `${where}.host.adapter_id`, {
    maxLength: MAX_HOST_ADAPTER_ID_LENGTH,
  });
  const sessionRef = asOptionalString(value.session_ref, `${where}.host.session_ref`, {
    maxLength: MAX_HOST_SESSION_REF_LENGTH,
  });
  return deepFreeze({ adapter_id: adapterId, session_ref: sessionRef });
}

function validateCorrelation(value, where) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new BoundaryEventError("ERR_CORRELATION_NOT_OBJECT", { where });
  }
  rejectUnknownKeys(value, CORRELATION_FIELD_SET, `${where}.correlation`);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = asNonEmptyString(value[key], `${where}.correlation.${key}`, {
      maxLength: MAX_CORRELATION_ID_LENGTH,
    });
  }
  return deepFreeze(out);
}

function validateResource(value, where) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new BoundaryEventError("ERR_RESOURCE_NOT_OBJECT", { where });
  }
  rejectUnknownKeys(value, KNOWN_RESOURCE_KEYS, `${where}.resource`);
  const kind = asNonEmptyString(value.kind, `${where}.resource.kind`);
  if (!RESOURCE_KINDS.includes(kind)) {
    throw new BoundaryEventError("ERR_RESOURCE_KIND_UNKNOWN", {
      where: `${where}.resource.kind`,
      value: kind,
    });
  }
  const out = { kind };
  if (value.name !== undefined && value.name !== null) {
    out.name = asNonEmptyString(value.name, `${where}.resource.name`);
  }
  if (value.target_digest !== undefined && value.target_digest !== null) {
    out.target_digest = asNonEmptyString(value.target_digest, `${where}.resource.target_digest`, {
      maxLength: MAX_DIGEST_LENGTH,
    });
  }
  return deepFreeze(out);
}

function validateDecision(value, where) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw new BoundaryEventError("ERR_DECISION_NOT_OBJECT", { where });
  }
  rejectUnknownKeys(value, KNOWN_DECISION_KEYS, `${where}.decision`);
  const result = asNonEmptyString(value.result, `${where}.decision.result`);
  if (!RUNTIME_BOUNDARY_EVENT_DECISION_SET.has(result)) {
    throw new BoundaryEventError("ERR_DECISION_RESULT_UNKNOWN", {
      where: `${where}.decision.result`,
      value: result,
    });
  }
  const out = { result };
  if (value.authorization_ref !== undefined && value.authorization_ref !== null) {
    out.authorization_ref = asNonEmptyString(
      value.authorization_ref,
      `${where}.decision.authorization_ref`,
      { maxLength: MAX_DECISION_AUTHORIZATION_REF_LENGTH }
    );
  }
  if (value.reason !== undefined && value.reason !== null) {
    out.reason = asNonEmptyString(value.reason, `${where}.decision.reason`, {
      maxLength: MAX_REASON_LENGTH,
    });
    scanForTaint(out.reason, `${where}.decision.reason`);
  }
  return deepFreeze(out);
}

function validateEvidenceRefs(value, where) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BoundaryEventError("ERR_EVIDENCE_REFS_NOT_ARRAY", { where });
  }
  if (value.length > MAX_EVIDENCE_REFS) {
    throw new BoundaryEventError("ERR_EVIDENCE_REFS_TOO_MANY", {
      where,
      maxLength: MAX_EVIDENCE_REFS,
    });
  }
  return deepFreeze(
    value.map((entry, idx) => {
      const ref = asNonEmptyString(entry, `${where}.evidence_refs[${idx}]`, {
        maxLength: MAX_EVIDENCE_REF_LENGTH,
      });
      scanForTaint(ref, `${where}.evidence_refs[${idx}]`);
      return ref;
    })
  );
}

// event_id format: "RBE-" + safe identifier body
//   body chars: ASCII letters, digits, '.', '_', '-'
//   body length: 1 .. (MAX_EVENT_ID_LENGTH - prefix length)
function validateEventId(value) {
  const id = asNonEmptyString(value, "event.event_id", { maxLength: MAX_EVENT_ID_LENGTH });
  if (!id.startsWith(RUNTIME_BOUNDARY_EVENT_ID_PREFIX)) {
    throw new BoundaryEventError("ERR_EVENT_ID_PREFIX_MISSING", {
      where: "event.event_id",
      prefix: RUNTIME_BOUNDARY_EVENT_ID_PREFIX,
    });
  }
  const body = id.slice(RUNTIME_BOUNDARY_EVENT_ID_PREFIX.length);
  if (body.length < MIN_EVENT_ID_BODY_LENGTH) {
    throw new BoundaryEventError("ERR_EVENT_ID_BODY_EMPTY", {
      where: "event.event_id",
    });
  }
  if (!EVENT_ID_BODY_REGEX.test(body)) {
    throw new BoundaryEventError("ERR_EVENT_ID_BODY_INVALID", {
      where: "event.event_id",
    });
  }
  return id;
}

function validateCapability(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new BoundaryEventError("ERR_FIELD_NOT_STRING", { where });
  }
  // Cross-validate against the capability vocabulary. Import lazily to avoid
  // circular module loads (capability-contract does not import boundary-event).
  const capMod = require("./capability-contract");
  if (!capMod.isKnownCapability(value)) {
    throw new BoundaryEventError("ERR_CAPABILITY_NAME_UNKNOWN", {
      where,
      value,
    });
  }
  // Guard against taint even though capability names are constrained.
  scanForTaint(value, where);
  return value;
}

function validateBoundaryEvent(input) {
  if (!isPlainObject(input)) {
    throw new BoundaryEventError("ERR_EVENT_NOT_OBJECT", { where: "event" });
  }
  rejectUnknownKeys(input, KNOWN_EVENT_TOP_KEYS, "event");
  const schemaVersion = asNonEmptyString(input.schema_version, "event.schema_version");
  if (schemaVersion !== RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION) {
    throw new BoundaryEventError("ERR_SCHEMA_VERSION_UNKNOWN", {
      where: "event.schema_version",
      value: schemaVersion,
    });
  }

  const eventId = validateEventId(input.event_id);
  const type = asNonEmptyString(input.type, "event.type");
  if (!RUNTIME_BOUNDARY_EVENT_TYPE_SET.has(type)) {
    throw new BoundaryEventError("ERR_EVENT_TYPE_UNKNOWN", {
      where: "event.type",
      value: type,
    });
  }

  const at = normalizeTimestamp(input.at, "event.at");
  const host = validateHost(input.host, "event");
  const correlation = validateCorrelation(input.correlation, "event");
  const resource = validateResource(input.resource, "event");
  const capability = validateCapability(input.capability, "event.capability");
  const decision = validateDecision(input.decision, "event");
  const evidenceRefs = validateEvidenceRefs(input.evidence_refs, "event");

  // Tool events SHOULD carry resource+capability+decision; keep it strict so we
  // never accept a tool.* event that hides outcome.
  if (type === "tool.before" || type === "tool.after" || type === "tool.update") {
    if (!resource || !capability || !decision) {
      throw new BoundaryEventError("ERR_TOOL_EVENT_INCOMPLETE", {
        where: "event",
        type,
        has_resource: Boolean(resource),
        has_capability: Boolean(capability),
        has_decision: Boolean(decision),
      });
    }
  }

  // Walk every retained free-form string and ensure no taint slipped in.
  walkNoTaint(correlation, "event.correlation");
  if (resource) walkNoTaint(resource, "event.resource");
  if (decision) walkNoTaint(decision, "event.decision");

  return deepFreeze({
    schema_version: RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
    event_id: eventId,
    type,
    at,
    host,
    correlation,
    resource,
    capability,
    decision,
    evidence_refs: evidenceRefs,
  });
}

module.exports = {
  RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
  RUNTIME_BOUNDARY_EVENT_ID_PREFIX,
  RUNTIME_BOUNDARY_EVENT_TYPES,
  RUNTIME_BOUNDARY_EVENT_DECISIONS,
  MAX_EVENT_ID_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_EVIDENCE_REF_LENGTH,
  MAX_REASON_LENGTH,
  MAX_DIGEST_LENGTH,
  MAX_CORRELATION_ID_LENGTH,
  MAX_HOST_ADAPTER_ID_LENGTH,
  MAX_HOST_SESSION_REF_LENGTH,
  MAX_DECISION_AUTHORIZATION_REF_LENGTH,
  BoundaryEventError,
  isValidIsoTimestamp,
  validateBoundaryEvent,
};