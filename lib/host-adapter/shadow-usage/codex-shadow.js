"use strict";

const {
  MEASUREMENT_SOURCES,
  TOKEN_FIELDS,
  createCapabilityResult,
  createHostReceipt,
  normalizeExplicitUsage,
  registerAdapter,
  validateShadowInput,
  ShadowUsageError,
} = require("./index.js");

const HOST_ID_CODEX = "codex";
const HOST_ID_CLAUDE_CODE = "claude-code";
const ALLOWED_USAGE_FIELDS = new Set([
  ...TOKEN_FIELDS,
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "reasoning_output_tokens",
]);
const ALLOWED_TOP_FIELDS = new Set([
  ...ALLOWED_USAGE_FIELDS,
  "usage",
  "model",
  "status",
  "timestamp",
]);
const ALIASES = Object.freeze({
  input_tokens: Object.freeze(["prompt_tokens"]),
  output_tokens: Object.freeze(["completion_tokens"]),
  cache_creation_input_tokens: Object.freeze(["cache_write_input_tokens"]),
  cache_read_input_tokens: Object.freeze(["cached_input_tokens"]),
});
const UNSUPPORTED_USAGE_FIELDS = Object.freeze(["total_tokens", "reasoning_output_tokens"]);

function configFor(hostId) {
  return Object.freeze({
    hostId,
    sourceId: hostId,
    allowedTopFields: ALLOWED_TOP_FIELDS,
    allowedUsageFields: ALLOWED_USAGE_FIELDS,
    aliases: ALIASES,
  });
}

class CodexShadowAdapter {
  constructor(options = {}) {
    this.hostId = options.hostId || HOST_ID_CODEX;
    this.options = Object.freeze({ usageCapability: options.usageCapability || "unavailable" });
  }

  getHostId() { return this.hostId; }
  getSourceId() { return this.hostId; }
  detectUsage() { return createCapabilityResult(this.hostId, this.hostId, this.options.usageCapability); }

  normalizeUsage(raw) {
    const validation = validateShadowInput(raw, ALLOWED_TOP_FIELDS, ALLOWED_USAGE_FIELDS);
    if (!validation.valid) throw new ShadowUsageError("shadow_input_rejected", validation.blocked);
    const normalized = normalizeExplicitUsage(raw, ALIASES);
    const source = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
    return Object.freeze({
      ok: true,
      host: this.hostId,
      source: this.hostId,
      status: normalized.reportedCount > 0 ? "normalized" : "unavailable",
      usage: normalized.usage,
      reported: normalized.reported,
      missingFields: TOKEN_FIELDS.filter((field) => normalized.reported[field] === "unknown"),
      unsupportedFields: UNSUPPORTED_USAGE_FIELDS.filter((field) => Object.hasOwn(source, field)),
    });
  }

  createShadowReceipt(options) { return createHostReceipt(configFor(this.hostId), options); }
}

function createCodexShadowAdapter(options = {}) {
  return new CodexShadowAdapter({ ...options, hostId: HOST_ID_CODEX });
}

function createClaudeCodeShadowAdapter(options = {}) {
  return new CodexShadowAdapter({ ...options, hostId: HOST_ID_CLAUDE_CODE });
}

registerAdapter(HOST_ID_CODEX, createCodexShadowAdapter);
registerAdapter(HOST_ID_CLAUDE_CODE, createClaudeCodeShadowAdapter);

module.exports = {
  HOST_ID_CODEX,
  HOST_ID_CLAUDE_CODE,
  ALLOWED_TOP_FIELDS,
  ALLOWED_USAGE_FIELDS,
  ALIASES,
  UNSUPPORTED_USAGE_FIELDS,
  CodexShadowAdapter,
  createCodexShadowAdapter,
  createClaudeCodeShadowAdapter,
};
