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

const HOST_ID = "pi-json";
const SOURCE_ID = MEASUREMENT_SOURCES.PI_JSON;
const PI_USAGE_ALIASES = Object.freeze({
  input_tokens: Object.freeze(["input"]),
  output_tokens: Object.freeze(["output"]),
  cache_creation_input_tokens: Object.freeze(["cacheWrite"]),
  cache_read_input_tokens: Object.freeze(["cacheRead"]),
});
const UNSUPPORTED_USAGE_FIELDS = Object.freeze(["totalTokens"]);
const ALLOWED_USAGE_FIELDS = new Set([
  ...TOKEN_FIELDS,
  ...Object.values(PI_USAGE_ALIASES).flat(),
  ...UNSUPPORTED_USAGE_FIELDS,
]);
const ALLOWED_TOP_FIELDS = new Set([
  ...TOKEN_FIELDS,
  "usage",
  "type",
  "model",
  "timestamp",
]);
const CONFIG = Object.freeze({
  hostId: HOST_ID,
  sourceId: SOURCE_ID,
  allowedTopFields: ALLOWED_TOP_FIELDS,
  allowedUsageFields: ALLOWED_USAGE_FIELDS,
  aliases: PI_USAGE_ALIASES,
});

class PiJsonShadowAdapter {
  constructor(options = {}) {
    this.options = Object.freeze({ usageCapability: options.usageCapability || "unavailable" });
  }

  getHostId() { return HOST_ID; }
  getSourceId() { return SOURCE_ID; }
  detectUsage() { return createCapabilityResult(HOST_ID, SOURCE_ID, this.options.usageCapability); }

  normalizeUsage(raw) {
    const validation = validateShadowInput(raw, ALLOWED_TOP_FIELDS, ALLOWED_USAGE_FIELDS);
    if (!validation.valid) throw new ShadowUsageError("shadow_input_rejected", validation.blocked);
    const normalized = normalizeExplicitUsage(raw, PI_USAGE_ALIASES);
    const source = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
    return Object.freeze({
      ok: true,
      host: HOST_ID,
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

function createPiJsonShadowAdapter(options) {
  return new PiJsonShadowAdapter(options);
}

registerAdapter(HOST_ID, createPiJsonShadowAdapter);

module.exports = {
  HOST_ID,
  SOURCE_ID,
  ALLOWED_TOP_FIELDS,
  ALLOWED_USAGE_FIELDS,
  PI_USAGE_ALIASES,
  UNSUPPORTED_USAGE_FIELDS,
  PiJsonShadowAdapter,
  createPiJsonShadowAdapter,
};
