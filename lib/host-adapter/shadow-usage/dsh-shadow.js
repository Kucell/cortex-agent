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

const HOST_ID = "dsh";
const SOURCE_ID = MEASUREMENT_SOURCES.DSH;
// DSH session.jsonl.zstd emits `assistant/chunk` envelopes whose `chunk.usage`
// carries `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`.
// We map those public provider names into the canonical MS-001 field set.
const DSH_USAGE_ALIASES = Object.freeze({
  input_tokens: Object.freeze(["inputTokens", "prompt_tokens"]),
  output_tokens: Object.freeze(["outputTokens", "completion_tokens"]),
  cache_creation_input_tokens: Object.freeze(["cacheWriteTokens", "cache_write_tokens"]),
  cache_read_input_tokens: Object.freeze(["cacheReadTokens", "cache_read_tokens"]),
});
const UNSUPPORTED_USAGE_FIELDS = Object.freeze([
  "total_tokens",
  "reasoning_output_tokens",
]);
const ALLOWED_USAGE_FIELDS = new Set([
  ...TOKEN_FIELDS,
  ...Object.values(DSH_USAGE_ALIASES).flat(),
  ...UNSUPPORTED_USAGE_FIELDS,
]);
const ALLOWED_TOP_FIELDS = new Set([
  ...TOKEN_FIELDS,
  "usage",
  "type",
  "model",
  "timestamp",
  "session_id",
  "turn",
  "step",
]);
const CONFIG = Object.freeze({
  hostId: HOST_ID,
  sourceId: SOURCE_ID,
  allowedTopFields: ALLOWED_TOP_FIELDS,
  allowedUsageFields: ALLOWED_USAGE_FIELDS,
  aliases: DSH_USAGE_ALIASES,
});

class DshShadowAdapter {
  constructor(options = {}) {
    this.hostId = HOST_ID;
    this.options = Object.freeze({
      usageCapability: options.usageCapability || "available",
    });
  }

  getHostId() { return this.hostId; }
  getSourceId() { return SOURCE_ID; }

  detectUsage() {
    return createCapabilityResult(this.hostId, SOURCE_ID, this.options.usageCapability);
  }

  normalizeUsage(raw) {
    const validation = validateShadowInput(raw, ALLOWED_TOP_FIELDS, ALLOWED_USAGE_FIELDS);
    if (!validation.valid) {
      throw new ShadowUsageError("shadow_input_rejected", validation.blocked);
    }
    const normalized = normalizeExplicitUsage(raw, DSH_USAGE_ALIASES);
    const source = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
    return Object.freeze({
      ok: true,
      host: this.hostId,
      source: SOURCE_ID,
      status: normalized.reportedCount > 0 ? "normalized" : "unavailable",
      usage: normalized.usage,
      reported: normalized.reported,
      missingFields: TOKEN_FIELDS.filter((field) => normalized.reported[field] === "unknown"),
      unsupportedFields: UNSUPPORTED_USAGE_FIELDS.filter((field) => Object.hasOwn(source, field)),
    });
  }

  createShadowReceipt(options) { return createHostReceipt(CONFIG, options); }
}

function createDshShadowAdapter(options = {}) {
  return new DshShadowAdapter(options);
}

registerAdapter(HOST_ID, createDshShadowAdapter);

module.exports = {
  HOST_ID,
  SOURCE_ID,
  ALLOWED_TOP_FIELDS,
  ALLOWED_USAGE_FIELDS,
  DSH_USAGE_ALIASES,
  UNSUPPORTED_USAGE_FIELDS,
  DshShadowAdapter,
  createDshShadowAdapter,
};