"use strict";

// ─── Runtime Adapter Capability Contract (T-ARI-001 / P-001 / M-001) ─────────
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// Public API:
//   - CAPABILITY_NAMES                       : frozen set of stable capability identifiers
//   - CAPABILITY_LEVELS                      : frozen set of supported capability levels
//   - CAPABILITY_SOURCES                     : frozen set of acceptable source labels
//   - CAPABILITY_DESCRIPTOR_SCHEMA_VERSION  : "1.0"
//   - CapabilityContractError                : structured error code carrier
//   - validateCapabilityDescriptor(input)    : throws / returns frozen normalised descriptor
//   - isKnownCapability(name)                : boolean membership check
//   - isValidIsoTimestamp(value)             : pure ISO-8601 predicate (exported for re-use)
//
// Design rules (frozen by P-001 M-001):
//   - Levels and sources are closed enums; any unknown value is rejected
//     (cannot use a single boolean to blur "not detected" and "unsupported").
//   - `host`, `detected_at`, and `capabilities` are validated; descriptor
//     top-level, host, and capability-entry unknown fields are rejected
//     (closed-schema, fail-loud rather than silently dropped).
//   - Capability entries may only carry `{level, source, reason}`.
//   - Returned descriptors and nested objects are deep-frozen.

const CAPABILITY_DESCRIPTOR_SCHEMA_VERSION = "1.0";

// ─── Practical bounds ──────────────────────────────────────────────────────
const MAX_HOST_ADAPTER_ID_LENGTH = 64;
const MAX_HOST_VENDOR_LENGTH = 64;
const MAX_HOST_VERSION_LENGTH = 64;
const MAX_CAPABILITY_REASON_LENGTH = 256;
const MAX_DETECTED_AT_LENGTH = 64;

// Capability identifiers (stable vocabulary, frozen for M-001).
const CAPABILITY_NAMES = Object.freeze([
  "session.boundary",
  "turn.boundary",
  "message.boundary",
  "tool.before.observe",
  "tool.before.block",
  "tool.update",
  "context.render.observe",
]);

// Capability levels (closed enum).
//   native       : host provides structured native event / API
//   adapter      : adapter can derive reliably with deterministic tests
//   explicit     : requires workflow / CLI to actively report
//   unobservable : can execute but cannot be confirmed by the host
//   unsupported  : explicitly not supported
const CAPABILITY_LEVELS = Object.freeze([
  "native",
  "adapter",
  "explicit",
  "unobservable",
  "unsupported",
]);

// Source labels (closed enum).
const CAPABILITY_SOURCES = Object.freeze([
  "extension-api",
  "runtime-trace",
  "static-analysis",
  "manifest-claim",
  "self-reported",
  "not-exposed",
  "not-implemented",
]);

const CAPABILITY_LEVEL_SET = new Set(CAPABILITY_LEVELS);
const CAPABILITY_SOURCE_SET = new Set(CAPABILITY_SOURCES);
const CAPABILITY_NAME_SET = new Set(CAPABILITY_NAMES);

const KNOWN_DESCRIPTOR_TOP_KEYS = new Set([
  "schema_version",
  "host",
  "detected_at",
  "capabilities",
]);
const KNOWN_HOST_KEYS = new Set(["adapter_id", "vendor", "version"]);
const KNOWN_CAPABILITY_ENTRY_KEYS = new Set(["level", "source", "reason"]);

// Permissive ISO-8601: YYYY-MM-DD with optional time, optional fractional
// seconds, optional 'Z' or numeric offset.  Reject strings with timezone
// abbreviations (e.g. "UTC") to keep the on-disk representation parseable.
const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

class CapabilityContractError extends Error {
  constructor(code, details) {
    const message = `[capability-contract:${code}] ${describe(details)}`;
    super(message);
    this.name = "CapabilityContractError";
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
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return value;
}

function asNonEmptyString(value, where, { maxLength = 4096 } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapabilityContractError("ERR_FIELD_NOT_STRING", { where });
  }
  if (value.length > maxLength) {
    throw new CapabilityContractError("ERR_FIELD_TOO_LONG", { where, maxLength });
  }
  return value;
}

// ─── Timestamp normalisation (pure) ────────────────────────────────────────
// Reject invalid / non-ISO strings rather than accepting any non-empty one.
// Accepts either a strict ISO-8601 string OR a finite number (ms epoch).
// Returns a deterministic ISO-8601 string.
function isValidIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_DETECTED_AT_LENGTH) return false;
  return ISO_TIMESTAMP_REGEX.test(value);
}

function normalizeTimestamp(value, where) {
  if (typeof value === "string") {
    if (!isValidIsoTimestamp(value)) {
      throw new CapabilityContractError("ERR_TIMESTAMP_INVALID", {
        where,
        reason: "non_iso_string",
      });
    }
    // Normalise: drop sub-millisecond fractional digits and force 'Z'.
    // The contract treats ISO-8601 as canonical, so all emitted timestamps
    // round-trip identically across producers.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new CapabilityContractError("ERR_TIMESTAMP_INVALID", {
        where,
        reason: "unparseable",
      });
    }
    return d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  throw new CapabilityContractError("ERR_TIMESTAMP_INVALID", {
    where,
    reason: "unsupported_type",
  });
}

function rejectUnknownKeys(obj, known, where) {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new CapabilityContractError("ERR_FIELD_UNKNOWN", { where, key });
    }
  }
}

function validateHost(host, where) {
  if (!host || typeof host !== "object" || Array.isArray(host)) {
    throw new CapabilityContractError("ERR_HOST_MISSING", { where });
  }
  rejectUnknownKeys(host, KNOWN_HOST_KEYS, `${where}.host`);
  const adapterId = asNonEmptyString(host.adapter_id, `${where}.host.adapter_id`, {
    maxLength: MAX_HOST_ADAPTER_ID_LENGTH,
  });
  const vendor = asNonEmptyString(host.vendor, `${where}.host.vendor`, {
    maxLength: MAX_HOST_VENDOR_LENGTH,
  });
  const version = asNonEmptyString(host.version, `${where}.host.version`, {
    maxLength: MAX_HOST_VERSION_LENGTH,
  });
  return deepFreeze({ adapter_id: adapterId, vendor, version });
}

function validateCapabilityEntry(entry, name, where) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new CapabilityContractError("ERR_CAPABILITY_NOT_OBJECT", {
      where,
      capability: name,
    });
  }
  rejectUnknownKeys(entry, KNOWN_CAPABILITY_ENTRY_KEYS, where);
  const level = asNonEmptyString(entry.level, `${where}.level`);
  if (!CAPABILITY_LEVEL_SET.has(level)) {
    throw new CapabilityContractError("ERR_CAPABILITY_LEVEL_UNKNOWN", {
      where: `${where}.level`,
      capability: name,
      value: level,
    });
  }
  const source = asNonEmptyString(entry.source, `${where}.source`);
  if (!CAPABILITY_SOURCE_SET.has(source)) {
    throw new CapabilityContractError("ERR_CAPABILITY_SOURCE_UNKNOWN", {
      where: `${where}.source`,
      capability: name,
      value: source,
    });
  }
  // `reason` is optional; if present must be a bounded non-empty string.
  let reason = null;
  if (entry.reason !== undefined && entry.reason !== null) {
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      throw new CapabilityContractError("ERR_CAPABILITY_REASON_INVALID", {
        where: `${where}.reason`,
        capability: name,
      });
    }
    if (entry.reason.length > MAX_CAPABILITY_REASON_LENGTH) {
      throw new CapabilityContractError("ERR_FIELD_TOO_LONG", {
        where: `${where}.reason`,
        maxLength: MAX_CAPABILITY_REASON_LENGTH,
      });
    }
    reason = entry.reason;
  }
  return deepFreeze({ level, source, reason });
}

// Frozen validator. Returns a normalised deep-frozen descriptor. Extra fields
// at the top level are rejected (closed-schema, fail-loud).
function validateCapabilityDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CapabilityContractError("ERR_DESCRIPTOR_NOT_OBJECT", {
      where: "descriptor",
    });
  }
  rejectUnknownKeys(input, KNOWN_DESCRIPTOR_TOP_KEYS, "descriptor");
  const schemaVersion = asNonEmptyString(input.schema_version, "descriptor.schema_version");
  if (schemaVersion !== CAPABILITY_DESCRIPTOR_SCHEMA_VERSION) {
    throw new CapabilityContractError("ERR_SCHEMA_VERSION_UNKNOWN", {
      where: "descriptor.schema_version",
      value: schemaVersion,
    });
  }
  const host = validateHost(input.host, "descriptor");
  const detectedAt = normalizeTimestamp(input.detected_at, "descriptor.detected_at");
  if (!input.capabilities || typeof input.capabilities !== "object" || Array.isArray(input.capabilities)) {
    throw new CapabilityContractError("ERR_CAPABILITIES_MISSING", {
      where: "descriptor.capabilities",
    });
  }
  const capabilities = {};
  // Sorted insert order keeps the descriptor deterministic and snapshot-safe.
  const names = Object.keys(input.capabilities).sort();
  for (const name of names) {
    if (!CAPABILITY_NAME_SET.has(name)) {
      throw new CapabilityContractError("ERR_CAPABILITY_NAME_UNKNOWN", {
        where: "descriptor.capabilities",
        value: name,
      });
    }
    capabilities[name] = validateCapabilityEntry(
      input.capabilities[name],
      name,
      `descriptor.capabilities.${name}`
    );
  }
  const out = {
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host,
    detected_at: detectedAt,
    capabilities,
  };
  return deepFreeze(out);
}

function isKnownCapability(name) {
  return typeof name === "string" && CAPABILITY_NAME_SET.has(name);
}

module.exports = {
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_NAMES,
  CAPABILITY_LEVELS,
  CAPABILITY_SOURCES,
  MAX_HOST_ADAPTER_ID_LENGTH,
  MAX_HOST_VENDOR_LENGTH,
  MAX_HOST_VERSION_LENGTH,
  MAX_CAPABILITY_REASON_LENGTH,
  CapabilityContractError,
  isValidIsoTimestamp,
  validateCapabilityDescriptor,
  isKnownCapability,
};