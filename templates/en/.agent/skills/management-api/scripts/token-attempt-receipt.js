"use strict";

const crypto = require("crypto");

// ─── token-attempt-receipt (L1 management-api — versioned receipt + strict normalizer)
// ─────────────────────────────────────────────────────────────────────────────────
// Single-purpose pure function that:
//   1. Defines a versioned token-attempt receipt schema.
//   2. Coerces agent-host-reported token usage into canonical numeric shape.
//   3. Distinguishes estimated, rendered, and host-reported usage states.
//   4. Preserves unknown/unavailable without inference.
//
// Design rules (per M-025/MS-001):
//   - estimated vs render vs host-reported states are explicit; never inferred.
//   - unknown/unavailable stays unknown/unavailable.
//   - No `||` fallbacks that collapse legitimate zero.
//   - No NaN/Infinity propagation.
//   - No private payload persistence (prompt, response, source body, credentials).

// ─── Schema version ────────────────────────────────────────────────────────────
const SCHEMA_VERSION = "1.0";

// ─── Known usage status values ────────────────────────────────────────────────
const USAGE_STATUS = Object.freeze({
  ESTIMATED: "estimated",
  RENDERED: "rendered",
  HOST_REPORTED: "host_reported",
  UNKNOWN: "unknown",
  UNAVAILABLE: "unavailable",
});

// ─── Security allowlist: only these fields may appear in a receipt ─────────────
const ALLOWED_RECEIPT_FIELDS = Object.freeze(new Set([
  "schema_version",
  "receipt_id",
  "attempt_id",
  "run_id",
  "task_id",
  "session_id",
  "host",
  "model",
  "status",
  "usage",
  "status_reason",
  "recorded_at",
  "measurement_source",
]));

// ─── Security blocklist: fields that must NEVER appear in a receipt ───────────
const BLOCKED_RECEIPT_FIELDS = Object.freeze(new Set([
  // Private content
  "prompt", "system_prompt", "completion", "response", "messages",
  "tool_args", "tool_arguments", "tool_input", "tool_output",
  "stdout", "stderr", "transcript", "file_body", "file_content", "body",
  "exact_tokens", "exact_usage", "private_transcript",
  // Credentials
  "api_key", "secret", "password", "token", "auth", "credential",
  "bearer", "authorization",
  // Private paths
  "path", "file_path", "absolute_path", "local_path", "source_path",
]));

// ─── Security patterns for credential detection ────────────────────────────────
const CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /(api[_-]?key|secret[_-]?key|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  /(^|[^A-Za-z0-9_])(\/(?:Users|home)\/[A-Za-z0-9._-]+)/,
]);

// ─── Token usage field names ──────────────────────────────────────────────────
const TOKEN_KEYS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
]);
const ALLOWED_USAGE_FIELDS = Object.freeze(new Set([
  ...TOKEN_KEYS,
  "samples",
  "host_reported_input_tokens",
  "host_reported_output_tokens",
  "host_reported_cache_creation_input_tokens",
  "host_reported_cache_read_input_tokens",
  "host_reported_cache_tokens",
]));
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const REASON_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// ─── Utility: check if value is a finite number ───────────────────────────────
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// ─── Utility: parse thousand-separated numeric string ─────────────────────────
function parseNumericString(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const thousandsPattern = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
  if (thousandsPattern.test(trimmed)) {
    const num = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(num) ? num : null;
  }
  // Reject anything else containing a comma
  if (trimmed.includes(",")) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

// ─── Utility: coerce single value to non-negative integer ────────────────────
function coerceToNonNegativeInt(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (isFiniteNumber(value)) {
    return value < 0 ? 0 : Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = parseNumericString(value);
    if (parsed === null) return 0;
    return parsed < 0 ? 0 : Math.trunc(parsed);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const coerced = coerceToNonNegativeInt(item);
      if (coerced !== 0) return coerced;
    }
    return 0;
  }
  if (typeof value === "object") {
    for (const key of TOKEN_KEYS) {
      if (key in value) {
        const coerced = coerceToNonNegativeInt(value[key]);
        if (coerced !== 0) return coerced;
      }
    }
    for (const child of Object.values(value)) {
      const coerced = coerceToNonNegativeInt(child);
      if (coerced !== 0) return coerced;
    }
    return 0;
  }
  return 0;
}

// ─── Public API: normalize token usage to canonical shape ────────────────────
// Returns integers >= 0 for every field. Missing fields → 0.
function normalizeTokenUsage(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const result = { samples: 1 };
  for (const key of TOKEN_KEYS) {
    result[key] = coerceToNonNegativeInt(source[key]);
  }
  return result;
}

// ─── Public API: create a versioned token-attempt receipt ─────────────────────
//
// Options:
//   - attempt_id: required, unique attempt identifier
//   - receipt_id: required, unique receipt identifier (for idempotency)
//   - run_id: run identifier
//   - task_id: task identifier
//   - session_id: session identifier
//   - host: source host name (e.g., "claude-code", "cursor")
//   - model: model identifier
//   - status: usage status (estimated | rendered | host_reported | unknown | unavailable)
//   - raw_usage: raw usage object from host
//   - status_reason: human-readable reason for status
//   - recorded_at: ISO timestamp (defaults to now)
//
// Security guarantees:
//   - Only allowlisted fields are persisted.
//   - Blocked fields are stripped.
//   - Credential patterns are redacted.
//   - Private absolute paths are stripped.
function createTokenAttemptReceipt(options) {
  const {
    attempt_id,
    receipt_id,
    run_id = null,
    task_id = null,
    session_id = null,
    host = "unknown",
    model = null,
    status = USAGE_STATUS.UNKNOWN,
    raw_usage = null,
    status_reason = null,
    recorded_at = new Date().toISOString(),
  } = options;

  // Validate required fields
  if (!attempt_id || typeof attempt_id !== "string") {
    throw new Error("attempt_id is required and must be a string");
  }
  if (!receipt_id || typeof receipt_id !== "string") {
    throw new Error("receipt_id is required and must be a string");
  }

  // Validate status
  const validStatuses = Object.values(USAGE_STATUS);
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(", ")}`);
  }

  // Normalize usage while preserving whether the Host actually supplied each
  // field. Canonical zeros remain useful for aggregation, but Host-reported
  // mirrors stay `unknown` when a field was absent.
  const rawUsageObject = raw_usage && typeof raw_usage === "object" && !Array.isArray(raw_usage)
    ? raw_usage
    : {};
  const normalizedUsage = normalizeTokenUsage(rawUsageObject);
  const hostReported = status === USAGE_STATUS.HOST_REPORTED;
  const reported = (field) => hostReported && Object.prototype.hasOwnProperty.call(rawUsageObject, field)
    ? normalizedUsage[field]
    : USAGE_STATUS.UNKNOWN;

  // Build receipt with only allowed fields
  const receipt = {
    schema_version: SCHEMA_VERSION,
    receipt_id: String(receipt_id),
    attempt_id: String(attempt_id),
    recorded_at: recorded_at,
    status,
  };

  // Add optional fields only if truthy
  if (run_id) receipt.run_id = String(run_id);
  if (task_id) receipt.task_id = String(task_id);
  if (session_id) receipt.session_id = String(session_id);
  if (host) receipt.host = String(host);
  if (model) receipt.model = String(model);
  if (status_reason) receipt.status_reason = String(status_reason);

  // Add usage with explicit measurement_source
  receipt.measurement_source = host;
  receipt.usage = {
    input_tokens: normalizedUsage.input_tokens,
    output_tokens: normalizedUsage.output_tokens,
    cache_creation_input_tokens: normalizedUsage.cache_creation_input_tokens,
    cache_read_input_tokens: normalizedUsage.cache_read_input_tokens,
    samples: normalizedUsage.samples,
    // Explicit source tracking
    host_reported_input_tokens: reported("input_tokens"),
    host_reported_output_tokens: reported("output_tokens"),
    host_reported_cache_creation_input_tokens: reported("cache_creation_input_tokens"),
    host_reported_cache_read_input_tokens: reported("cache_read_input_tokens"),
    host_reported_cache_tokens: hostReported
      && Object.prototype.hasOwnProperty.call(rawUsageObject, "cache_creation_input_tokens")
      && Object.prototype.hasOwnProperty.call(rawUsageObject, "cache_read_input_tokens")
      ? normalizedUsage.cache_creation_input_tokens + normalizedUsage.cache_read_input_tokens
      : USAGE_STATUS.UNKNOWN,
  };

  return receipt;
}

// ─── Public API: validate a receipt against security rules ────────────────────
// Returns { valid: true } or { valid: false, reason: string }
function validateReceiptSecurity(receipt) {
  if (!receipt || typeof receipt !== "object") {
    return { valid: false, reason: "Receipt must be an object" };
  }

  // Fail closed on schema drift; silently dropping an unexpected field can
  // hide a producer bug or a private payload leak.
  for (const key of Object.keys(receipt)) {
    if (BLOCKED_RECEIPT_FIELDS.has(key.toLowerCase())) {
      return { valid: false, reason: `Blocked field detected: ${key}` };
    }
    if (!ALLOWED_RECEIPT_FIELDS.has(key)) {
      return { valid: false, reason: `Unknown field detected: ${key}` };
    }
  }
  if (receipt.usage && (typeof receipt.usage !== "object" || Array.isArray(receipt.usage))) {
    return { valid: false, reason: "usage must be an object" };
  }
  for (const key of Object.keys(receipt.usage || {})) {
    if (!ALLOWED_USAGE_FIELDS.has(key)) {
      return { valid: false, reason: `Unknown usage field detected: ${key}` };
    }
  }

  // Check for credential patterns in string values
  function containsCredential(value) {
    if (typeof value === "string") {
      return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
    }
    if (Array.isArray(value)) {
      return value.some(containsCredential);
    }
    if (typeof value === "object" && value !== null) {
      return Object.values(value).some(containsCredential);
    }
    return false;
  }

  if (containsCredential(receipt)) {
    return { valid: false, reason: "Credential pattern detected in receipt" };
  }

  // Check for private absolute paths
  const privatePathPattern = /(^|\/)(Users|home)\/[A-Za-z0-9._-]+\//;
  for (const value of Object.values(receipt)) {
    if (typeof value === "string" && privatePathPattern.test(value)) {
      return { valid: false, reason: "Private absolute path detected in receipt" };
    }
  }

  return { valid: true };
}

function validateReceiptContract(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, reason: "Receipt must be an object" };
  }
  if (receipt.schema_version !== SCHEMA_VERSION) {
    return { valid: false, reason: `schema_version must equal ${SCHEMA_VERSION}` };
  }
  for (const field of ["receipt_id", "attempt_id"]) {
    if (typeof receipt[field] !== "string" || !IDENTIFIER_PATTERN.test(receipt[field])) {
      return { valid: false, reason: `${field} must be a bounded identifier` };
    }
  }
  for (const field of ["run_id", "task_id", "session_id", "host", "model", "measurement_source"]) {
    if (receipt[field] !== undefined && receipt[field] !== null
      && (typeof receipt[field] !== "string" || !IDENTIFIER_PATTERN.test(receipt[field]))) {
      return { valid: false, reason: `${field} must be a bounded identifier` };
    }
  }
  if (!Object.values(USAGE_STATUS).includes(receipt.status)) {
    return { valid: false, reason: "status is invalid" };
  }
  if (typeof receipt.recorded_at !== "string"
    || Number.isNaN(new Date(receipt.recorded_at).getTime())) {
    return { valid: false, reason: "recorded_at must be a valid timestamp" };
  }
  if (receipt.status_reason !== undefined && receipt.status_reason !== null
    && (typeof receipt.status_reason !== "string" || !REASON_CODE_PATTERN.test(receipt.status_reason))) {
    return { valid: false, reason: "status_reason must be a short reason code" };
  }
  if (!receipt.usage || typeof receipt.usage !== "object" || Array.isArray(receipt.usage)) {
    return { valid: false, reason: "usage must be an object" };
  }
  for (const field of [
    "input_tokens", "output_tokens", "cache_creation_input_tokens",
    "cache_read_input_tokens", "samples",
  ]) {
    const value = receipt.usage[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      return { valid: false, reason: `usage.${field} must be a non-negative safe integer` };
    }
  }
  for (const field of [
    "host_reported_input_tokens", "host_reported_output_tokens",
    "host_reported_cache_creation_input_tokens", "host_reported_cache_read_input_tokens",
    "host_reported_cache_tokens",
  ]) {
    const value = receipt.usage[field];
    if (value !== USAGE_STATUS.UNKNOWN && (!Number.isSafeInteger(value) || value < 0)) {
      return { valid: false, reason: `usage.${field} must be unknown or a non-negative safe integer` };
    }
  }
  const reportedFields = [
    "host_reported_input_tokens", "host_reported_output_tokens",
    "host_reported_cache_creation_input_tokens", "host_reported_cache_read_input_tokens",
    "host_reported_cache_tokens",
  ];
  if (receipt.status !== USAGE_STATUS.HOST_REPORTED
    && reportedFields.some((field) => receipt.usage[field] !== USAGE_STATUS.UNKNOWN)) {
    return { valid: false, reason: "non-host-reported status cannot carry host-reported usage" };
  }
  if (receipt.status === USAGE_STATUS.HOST_REPORTED) {
    const mirrors = [
      ["input_tokens", "host_reported_input_tokens"],
      ["output_tokens", "host_reported_output_tokens"],
      ["cache_creation_input_tokens", "host_reported_cache_creation_input_tokens"],
      ["cache_read_input_tokens", "host_reported_cache_read_input_tokens"],
    ];
    for (const [genericField, reportedField] of mirrors) {
      const genericValue = receipt.usage[genericField];
      const reportedValue = receipt.usage[reportedField];
      if ((reportedValue === USAGE_STATUS.UNKNOWN && genericValue !== 0)
        || (Number.isSafeInteger(reportedValue) && reportedValue !== genericValue)) {
        return { valid: false, reason: `usage.${reportedField} must mirror usage.${genericField}` };
      }
    }
    const cachePartsKnown = Number.isSafeInteger(receipt.usage.host_reported_cache_creation_input_tokens)
      && Number.isSafeInteger(receipt.usage.host_reported_cache_read_input_tokens);
    const expectedCacheTotal = receipt.usage.cache_creation_input_tokens + receipt.usage.cache_read_input_tokens;
    if ((cachePartsKnown && receipt.usage.host_reported_cache_tokens !== expectedCacheTotal)
      || (!cachePartsKnown && receipt.usage.host_reported_cache_tokens !== USAGE_STATUS.UNKNOWN)) {
      return { valid: false, reason: "usage.host_reported_cache_tokens is inconsistent with cache fields" };
    }
  }
  return { valid: true };
}

// ─── Public API: validate receipt size ─────────────────────────────────────────
// Returns { valid: true } or { valid: false, reason: string }
function validateReceiptSize(receipt, maxBytes = 65536) {
  if (!receipt || typeof receipt !== "object") {
    return { valid: false, reason: "Receipt must be an object" };
  }

  const size = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  if (size > maxBytes) {
    return { valid: false, reason: `Receipt size ${size} exceeds maximum ${maxBytes} bytes` };
  }

  return { valid: true };
}

// ─── Public API: strip unknown fields from raw host payload ─────────────────
// Only allows known fields; unknown fields are stripped.
function sanitizeHostPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const allowed = new Set([
    ...ALLOWED_RECEIPT_FIELDS,
    ...TOKEN_KEYS,
    "samples", "cost_usd", "status_reason",
  ]);

  const sanitized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.has(key)) {
      // Recursively sanitize nested objects
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const nested = sanitizeHostPayload(value);
        if (Object.keys(nested).length > 0) {
          sanitized[key] = nested;
        }
      } else {
        sanitized[key] = value;
      }
    }
    // Blocked fields are silently dropped
  }

  return sanitized;
}

// ─── Public API: detect out-of-order receipts ─────────────────────────────────
// Returns true if newReceipt should be considered out-of-order relative to ledger
function isOutOfOrderReceipt(newReceipt, ledgerEntries) {
  if (!newReceipt || !newReceipt.recorded_at) return false;

  const newTime = new Date(newReceipt.recorded_at).getTime();
  if (Number.isNaN(newTime)) return false;

  for (const entry of ledgerEntries) {
    const prior = entry.receipt || entry;
    if (!prior.recorded_at) continue;
    const entryTime = new Date(prior.recorded_at).getTime();
    if (Number.isNaN(entryTime)) continue;

    // If there's a newer entry with same attempt_id, this is out-of-order
    if (prior.attempt_id === newReceipt.attempt_id && entryTime > newTime) {
      return true;
    }
  }

  return false;
}

// ─── Public API: generate idempotent receipt ID ───────────────────────────────
function generateReceiptId(attempt_id, source, sequence = 0) {
  const digest = crypto.createHash("sha256")
    .update(`${attempt_id}\0${source}\0${sequence}`)
    .digest("hex")
    .slice(0, 24);
  return `TR-${digest}`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  SCHEMA_VERSION,
  USAGE_STATUS,
  ALLOWED_RECEIPT_FIELDS,
  BLOCKED_RECEIPT_FIELDS,
  TOKEN_KEYS,
  normalizeTokenUsage,
  coerceToNonNegativeInt,
  parseNumericString,
  createTokenAttemptReceipt,
  validateReceiptSecurity,
  validateReceiptContract,
  validateReceiptSize,
  sanitizeHostPayload,
  isOutOfOrderReceipt,
  generateReceiptId,
};
