"use strict";

const crypto = require("node:crypto");

const SHADOW_USAGE_SCHEMA_VERSION = "1.0";
const UNKNOWN = "unknown";
const TOKEN_FIELDS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
]);
const MEASUREMENT_SOURCES = Object.freeze({
  PI_JSON: "pi-json",
  CLAUDE_CODE: "claude-code",
  CODEX: "codex",
  DSH: "dsh",
});
const BLOCKED_KEYS = new Set([
  "prompt", "system_prompt", "completion", "response", "messages",
  "thinking", "transcript", "tool_args", "tool_arguments", "tool_input",
  "tool_output", "stdout", "stderr", "file_body", "file_content", "body",
  "api_key", "secret", "password", "token", "auth", "credential",
  "authorization", "path", "file_path", "absolute_path", "local_path",
  "source_path",
]);
const SENSITIVE_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[po]_[A-Za-z0-9]{20,}/,
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /(^|[^A-Za-z0-9_])(\/(?:Users|home)\/[A-Za-z0-9._-]+)/,
]);

class ShadowUsageError extends Error {
  constructor(code, fields = []) {
    super(code);
    this.name = "ShadowUsageError";
    this.code = code;
    this.fields = Object.freeze([...fields]);
  }
}

const ADAPTER_REGISTRY = new Map();

function registerAdapter(hostId, factory) {
  if (typeof hostId !== "string" || typeof factory !== "function") {
    throw new TypeError("hostId and factory are required");
  }
  ADAPTER_REGISTRY.set(hostId, factory);
}

function getAdapter(hostId, options = {}) {
  const factory = ADAPTER_REGISTRY.get(hostId);
  return factory ? factory(options) : null;
}

function listAdapters() {
  return [...ADAPTER_REGISTRY.keys()].sort();
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scanSensitive(value, path, blocked) {
  if (typeof value === "string") {
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) blocked.push(path);
    return;
  }
  if (Array.isArray(value)) {
    blocked.push(path);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (BLOCKED_KEYS.has(key.toLowerCase())) blocked.push(childPath);
    scanSensitive(child, childPath, blocked);
  }
}

function validateShadowInput(raw, allowedTopFields, allowedUsageFields) {
  if (!isPlainObject(raw)) return { valid: false, blocked: ["root"] };
  const blocked = [];
  for (const key of Object.keys(raw)) {
    if (!allowedTopFields.has(key)) blocked.push(key);
  }
  if (Object.hasOwn(raw, "usage")) {
    if (!isPlainObject(raw.usage)) {
      blocked.push("usage");
    } else {
      for (const key of Object.keys(raw.usage)) {
        if (!allowedUsageFields.has(key)) blocked.push(`usage.${key}`);
      }
    }
  }
  scanSensitive(raw, "root", blocked);
  return { valid: blocked.length === 0, blocked: [...new Set(blocked)].sort() };
}

function parseCount(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function normalizeExplicitUsage(raw, aliases = {}) {
  const source = isPlainObject(raw.usage) ? raw.usage : raw;
  const usage = { samples: 1 };
  const reported = {};
  const invalid = [];
  let reportedCount = 0;
  for (const field of TOKEN_FIELDS) {
    const candidates = [field, ...(aliases[field] || [])];
    const sourceField = candidates.find((name) => Object.hasOwn(source, name));
    if (!sourceField) {
      usage[field] = 0;
      reported[field] = UNKNOWN;
      continue;
    }
    const value = parseCount(source[sourceField]);
    if (value === null) {
      invalid.push(sourceField);
      usage[field] = 0;
      reported[field] = UNKNOWN;
      continue;
    }
    usage[field] = value;
    reported[field] = value;
    reportedCount += 1;
  }
  if (invalid.length > 0) throw new ShadowUsageError("invalid_usage_count", invalid);
  return Object.freeze({ usage: Object.freeze(usage), reported: Object.freeze(reported), reportedCount });
}

function receiptIdFor(attemptId, hostId, deliveryId = "0") {
  const digest = crypto.createHash("sha256")
    .update(`${attemptId}\0${hostId}\0${deliveryId}`)
    .digest("hex")
    .slice(0, 24);
  return `TR-${digest}`;
}

function createHostReceipt(config, options) {
  if (!options || typeof options !== "object") throw new ShadowUsageError("options_required");
  const validation = validateShadowInput(
    options.raw_usage,
    config.allowedTopFields,
    config.allowedUsageFields,
  );
  if (!validation.valid) throw new ShadowUsageError("shadow_input_rejected", validation.blocked);
  const normalized = normalizeExplicitUsage(options.raw_usage, config.aliases);
  const hostReported = normalized.reportedCount > 0;
  const attemptId = options.attempt_id;
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    throw new ShadowUsageError("attempt_id_required");
  }
  const receipt = {
    schema_version: SHADOW_USAGE_SCHEMA_VERSION,
    receipt_id: options.receipt_id || receiptIdFor(attemptId, config.hostId, options.delivery_id),
    attempt_id: attemptId,
    recorded_at: options.recorded_at || new Date().toISOString(),
    status: hostReported ? "host_reported" : "unavailable",
    host: config.hostId,
    measurement_source: config.sourceId,
    usage: {
      ...normalized.usage,
      host_reported_input_tokens: normalized.reported.input_tokens,
      host_reported_output_tokens: normalized.reported.output_tokens,
      host_reported_cache_creation_input_tokens: normalized.reported.cache_creation_input_tokens,
      host_reported_cache_read_input_tokens: normalized.reported.cache_read_input_tokens,
      host_reported_cache_tokens:
        Number.isSafeInteger(normalized.reported.cache_creation_input_tokens)
        && Number.isSafeInteger(normalized.reported.cache_read_input_tokens)
          ? normalized.usage.cache_creation_input_tokens + normalized.usage.cache_read_input_tokens
          : UNKNOWN,
    },
  };
  for (const field of ["run_id", "task_id", "session_id", "model"]) {
    if (options[field]) receipt[field] = String(options[field]);
  }
  if (!hostReported) receipt.status_reason = "usage_unavailable";
  return Object.freeze(receipt);
}

function createCapabilityResult(host, source, capability) {
  const available = capability === "available";
  return Object.freeze({
    ok: available,
    host,
    source,
    status: available ? "available" : "unavailable",
    reason: available ? null : "usage_capability_unavailable",
  });
}

module.exports = {
  SHADOW_USAGE_SCHEMA_VERSION,
  MEASUREMENT_SOURCES,
  TOKEN_FIELDS,
  UNKNOWN,
  ShadowUsageError,
  registerAdapter,
  getAdapter,
  listAdapters,
  validateShadowInput,
  normalizeExplicitUsage,
  receiptIdFor,
  createHostReceipt,
  createCapabilityResult,
};
