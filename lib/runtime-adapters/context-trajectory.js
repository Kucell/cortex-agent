"use strict";

// Observable context evidence is a projection over existing selector/runtime facts.
// It never owns task, Run, Session, or Operation lifecycle state.

const crypto = require("node:crypto");

const CONTEXT_TRAJECTORY_SCHEMA_VERSION = "2.0";
const CONTEXT_STAGE_TYPES = Object.freeze([
  "discovered",
  "selected",
  "rendered",
  "confirmed-consumed",
]);
const CONTEXT_STAGE_STATUSES = Object.freeze(["confirmed", "planned", "unavailable"]);
const CONTEXT_STAGE_SOURCES = Object.freeze([
  "context-index",
  "selector",
  "host-api",
  "adapter",
  "explicit-workflow",
  "not-exposed",
]);
const MAX_ITEMS = 256;
const MAX_REASON_CODES = 16;
const SAFE_URI = /^cortex:\/\/(?:references|rules|workflows|skills|resources)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

class ContextTrajectoryError extends Error {
  constructor(code, details) {
    super(`[context-trajectory:${code}] ${JSON.stringify(details || {})}`);
    this.name = "ContextTrajectoryError";
    this.code = code;
    this.details = details || {};
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ContextTrajectoryError("ERR_FIELD_UNKNOWN", { where, key });
  }
}

function identifier(value, where, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new ContextTrajectoryError("ERR_FIELD_REQUIRED", { where });
    return null;
  }
  if (typeof value !== "string" || !ID.test(value)) {
    throw new ContextTrajectoryError("ERR_IDENTIFIER_INVALID", { where });
  }
  return value;
}

function safeDigest(value, where, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new ContextTrajectoryError("ERR_FIELD_REQUIRED", { where });
    return null;
  }
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new ContextTrajectoryError("ERR_DIGEST_INVALID", { where });
  }
  return value;
}

function validateItem(value, where) {
  if (!plain(value)) throw new ContextTrajectoryError("ERR_ITEM_INVALID", { where });
  rejectKeys(value, new Set(["uri", "revision", "digest", "tier", "reason_codes", "estimated_tokens"]), where);
  if (typeof value.uri !== "string" || !SAFE_URI.test(value.uri)) {
    throw new ContextTrajectoryError("ERR_URI_NOT_ALLOWED", { where: `${where}.uri` });
  }
  const out = { uri: value.uri };
  const revision = safeDigest(value.revision, `${where}.revision`);
  const digest = safeDigest(value.digest, `${where}.digest`);
  if (revision) out.revision = revision;
  if (digest) out.digest = digest;
  if (value.tier !== undefined) {
    if (!["L0", "L1", "L2"].includes(value.tier)) throw new ContextTrajectoryError("ERR_TIER_INVALID", { where });
    out.tier = value.tier;
  }
  if (value.reason_codes !== undefined) {
    if (!Array.isArray(value.reason_codes) || value.reason_codes.length > MAX_REASON_CODES ||
        value.reason_codes.some((code) => typeof code !== "string" || !/^[a-z0-9._-]{1,64}$/.test(code))) {
      throw new ContextTrajectoryError("ERR_REASON_CODES_INVALID", { where });
    }
    out.reason_codes = [...value.reason_codes];
  }
  if (value.estimated_tokens !== undefined) {
    if (!Number.isSafeInteger(value.estimated_tokens) || value.estimated_tokens < 0) {
      throw new ContextTrajectoryError("ERR_TOKEN_ESTIMATE_INVALID", { where });
    }
    out.estimated_tokens = value.estimated_tokens;
  }
  return out;
}

function validateStage(value, index) {
  const where = `stages[${index}]`;
  if (!plain(value)) throw new ContextTrajectoryError("ERR_STAGE_INVALID", { where });
  rejectKeys(value, new Set(["type", "status", "source", "revision", "digest", "items", "observed_at"]), where);
  if (!CONTEXT_STAGE_TYPES.includes(value.type)) throw new ContextTrajectoryError("ERR_STAGE_TYPE_UNKNOWN", { where });
  if (!CONTEXT_STAGE_STATUSES.includes(value.status)) throw new ContextTrajectoryError("ERR_STAGE_STATUS_UNKNOWN", { where });
  if (!CONTEXT_STAGE_SOURCES.includes(value.source)) throw new ContextTrajectoryError("ERR_STAGE_SOURCE_UNKNOWN", { where });
  if (value.type === "confirmed-consumed" && value.status === "confirmed" &&
      !["host-api", "explicit-workflow"].includes(value.source)) {
    throw new ContextTrajectoryError("ERR_CONSUMPTION_NOT_CONFIRMED", { where });
  }
  if (value.type === "rendered" && value.status === "confirmed" &&
      !["host-api", "adapter", "explicit-workflow"].includes(value.source)) {
    throw new ContextTrajectoryError("ERR_RENDER_NOT_CONFIRMED", { where });
  }
  const items = value.items === undefined ? [] : value.items;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new ContextTrajectoryError("ERR_ITEMS_INVALID", { where });
  const out = { type: value.type, status: value.status, source: value.source, items: items.map(validateItem) };
  const revision = safeDigest(value.revision, `${where}.revision`);
  const digest = safeDigest(value.digest, `${where}.digest`);
  if (revision) out.revision = revision;
  if (digest) out.digest = digest;
  if (value.observed_at !== undefined) {
    const date = new Date(value.observed_at);
    if (typeof value.observed_at !== "string" || Number.isNaN(date.getTime())) throw new ContextTrajectoryError("ERR_TIMESTAMP_INVALID", { where });
    out.observed_at = date.toISOString();
  }
  return out;
}

function validateUsage(value) {
  if (value === undefined) return {
    estimated_selected_tokens: "unknown",
    host_reported_input_tokens: "unknown",
    host_reported_cache_tokens: "unknown",
    measurement_source: "unavailable",
  };
  if (!plain(value)) throw new ContextTrajectoryError("ERR_USAGE_INVALID", {});
  rejectKeys(value, new Set(["estimated_selected_tokens", "host_reported_input_tokens", "host_reported_cache_tokens", "measurement_source"]), "usage");
  const out = {};
  for (const key of ["estimated_selected_tokens", "host_reported_input_tokens", "host_reported_cache_tokens"]) {
    const item = value[key] === undefined ? "unknown" : value[key];
    if (item !== "unknown" && (!Number.isSafeInteger(item) || item < 0)) throw new ContextTrajectoryError("ERR_USAGE_INVALID", { key });
    out[key] = item;
  }
  out.measurement_source = value.measurement_source || "unavailable";
  if (!["unavailable", "host-api", "explicit-workflow"].includes(out.measurement_source)) throw new ContextTrajectoryError("ERR_USAGE_SOURCE_INVALID", {});
  if (out.measurement_source === "unavailable" && (out.host_reported_input_tokens !== "unknown" || out.host_reported_cache_tokens !== "unknown")) {
    throw new ContextTrajectoryError("ERR_HOST_USAGE_UNSUPPORTED", {});
  }
  return out;
}

function validateContextTrajectory(input) {
  if (!plain(input)) throw new ContextTrajectoryError("ERR_TRAJECTORY_INVALID", {});
  rejectKeys(input, new Set(["schema_version", "trajectory_id", "task_id", "run_id", "session_id", "operation_id", "host_profile_ref", "created_at", "stages", "usage", "outcome_refs"]), "trajectory");
  if (input.schema_version !== CONTEXT_TRAJECTORY_SCHEMA_VERSION) throw new ContextTrajectoryError("ERR_SCHEMA_VERSION_UNKNOWN", {});
  if (!Array.isArray(input.stages)) throw new ContextTrajectoryError("ERR_STAGES_REQUIRED", {});
  const stages = input.stages.map(validateStage);
  const seen = new Set(stages.map((stage) => stage.type));
  for (const type of CONTEXT_STAGE_TYPES) if (!seen.has(type)) throw new ContextTrajectoryError("ERR_STAGE_MISSING", { type });
  const created = new Date(input.created_at);
  if (typeof input.created_at !== "string" || Number.isNaN(created.getTime())) throw new ContextTrajectoryError("ERR_TIMESTAMP_INVALID", { where: "created_at" });
  const outcomeRefs = input.outcome_refs === undefined ? [] : input.outcome_refs;
  if (!Array.isArray(outcomeRefs) || outcomeRefs.length > 32) throw new ContextTrajectoryError("ERR_OUTCOME_REFS_INVALID", {});
  const out = {
    schema_version: CONTEXT_TRAJECTORY_SCHEMA_VERSION,
    trajectory_id: identifier(input.trajectory_id, "trajectory_id", true),
    task_id: identifier(input.task_id, "task_id", true),
    created_at: created.toISOString(),
    stages,
    usage: validateUsage(input.usage),
    outcome_refs: outcomeRefs.map((ref, i) => identifier(ref, `outcome_refs[${i}]`, true)),
  };
  for (const key of ["run_id", "session_id", "operation_id", "host_profile_ref"]) {
    const value = identifier(input[key], key);
    if (value) out[key] = value;
  }
  return Object.freeze(out);
}

function digestMetadata(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

module.exports = {
  CONTEXT_STAGE_SOURCES,
  CONTEXT_STAGE_STATUSES,
  CONTEXT_STAGE_TYPES,
  CONTEXT_TRAJECTORY_SCHEMA_VERSION,
  ContextTrajectoryError,
  digestMetadata,
  validateContextTrajectory,
};
