"use strict";

// ─── Runtime Adapter Capability Contract (T-ARI-001 / P-001 / M-001) ─────────
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// Public API:
//   - CAPABILITY_NAMES                       : frozen set of stable capability identifiers
//   - CAPABILITY_LEVELS                      : frozen set of supported capability levels
//   - CAPABILITY_SOURCES                     : frozen set of acceptable source labels
//   - FRICTION_SIGNAL_NAMES                  : frozen P-003 friction signal vocabulary
//   - FRICTION_OBSERVABILITY                 : frozen observability levels for friction signals
//   - FRICTION_REDACTION_LEVELS              : frozen redaction posture enum
//   - FRICTION_SIGNAL_NAMES_MAX              : closed-set cardinality bound (6)
//   - FRICTION_LIFECYCLE_EVENTS_MAX          : max lifecycle event names a host may declare
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

// Capability identifiers (stable vocabulary; M-001 base + P-007 TKR extension
// authorized by D-P007-TKR-CAP-EXT for M-032 VC-005).
const CAPABILITY_NAMES = Object.freeze([
  "session.boundary",
  "turn.boundary",
  "message.boundary",
  "tool.before.observe",
  "tool.before.block",
  "tool.update",
  "context.render.observe",
  "subagent",
  "prompt_guidance",
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
  // P-003 friction signal extension (M-003A). Optional keys; the existing
  // 4-key frozen schema stays the canonical set and any unknown descriptor
  // key continues to be rejected (fail-loud, closed-schema).
  "friction_signals",
  "friction_lifecycle_events",
  "redaction_level",
]);
const KNOWN_HOST_KEYS = new Set(["adapter_id", "vendor", "version"]);
const KNOWN_CAPABILITY_ENTRY_KEYS = new Set(["level", "source", "reason"]);

// ─── P-003 friction signal vocabulary (M-003A) ─────────────────────────────
// Closed sets; every adapter must declare observability for every signal it
// claims coverage for. Missing signals are silently absent (the host simply
// never emits them); missing observability is rejected as unknown.
const FRICTION_SIGNAL_NAMES = Object.freeze([
  "tool_denied",
  "tool_failed",
  "tool_retried",
  "user_interrupted",
  "user_correction",
  "lifecycle_stop",
]);
const FRICTION_SIGNAL_NAMES_MAX = FRICTION_SIGNAL_NAMES.length;

// Observability levels for a declared signal.
//   observed     : host emits a structured native event for this signal
//   derived      : host provides primitives; adapter derives with deterministic tests
//   not_observed : not currently claimable; declared to keep the matrix honest
//   not_supported: host/runtime explicitly does not support it
const FRICTION_OBSERVABILITY = Object.freeze([
  "observed",
  "derived",
  "not_observed",
  "not_supported",
]);

// Redaction posture for events emitted under this descriptor.
//   aggregate_only : only counts / evidence refs / lifecycle names — no free-form
//   full           : host claims full-fidelity event payload is safe to record
const FRICTION_REDACTION_LEVELS = Object.freeze([
  "aggregate_only",
  "full",
]);

const FRICTION_LIFECYCLE_EVENTS_MAX = 32;

const FRICTION_SIGNAL_NAME_SET = new Set(FRICTION_SIGNAL_NAMES);
const FRICTION_OBSERVABILITY_SET = new Set(FRICTION_OBSERVABILITY);
const FRICTION_REDACTION_LEVEL_SET = new Set(FRICTION_REDACTION_LEVELS);

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
  // P-003 friction signal extension (M-003A). All three keys are optional;
  // when present they must follow the closed vocabulary exactly.
  if (input.friction_signals !== undefined) {
    out.friction_signals = validateFrictionSignals(input.friction_signals, "descriptor.friction_signals");
  }
  if (input.friction_lifecycle_events !== undefined) {
    out.friction_lifecycle_events = validateFrictionLifecycleEvents(
      input.friction_lifecycle_events,
      "descriptor.friction_lifecycle_events"
    );
  }
  if (input.redaction_level !== undefined) {
    out.redaction_level = validateRedactionLevel(input.redaction_level, "descriptor.redaction_level");
  }
  return deepFreeze(out);
}

function validateFrictionSignals(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityContractError("ERR_FRICTION_SIGNALS_NOT_OBJECT", { where });
  }
  // Closed key vocabulary — any unknown friction signal name is rejected.
  rejectUnknownKeys(value, FRICTION_SIGNAL_NAME_SET, where);
  const out = {};
  const names = Object.keys(value).sort();
  for (const name of names) {
    if (value[name] === null || value[name] === undefined) {
      throw new CapabilityContractError("ERR_FIELD_NOT_STRING", {
        where: `${where}.${name}`,
      });
    }
    if (typeof value[name] !== "string" || value[name].length === 0) {
      throw new CapabilityContractError("ERR_FIELD_NOT_STRING", {
        where: `${where}.${name}`,
      });
    }
    if (!FRICTION_OBSERVABILITY_SET.has(value[name])) {
      throw new CapabilityContractError("ERR_FRICTION_OBSERVABILITY_UNKNOWN", {
        where: `${where}.${name}`,
        value: value[name],
      });
    }
    out[name] = value[name];
  }
  return deepFreeze(out);
}

function validateFrictionLifecycleEvents(value, where) {
  if (!Array.isArray(value)) {
    throw new CapabilityContractError("ERR_FRICTION_LIFECYCLE_NOT_ARRAY", { where });
  }
  if (value.length > FRICTION_LIFECYCLE_EVENTS_MAX) {
    throw new CapabilityContractError("ERR_FIELD_TOO_LONG", {
      where,
      maxLength: FRICTION_LIFECYCLE_EVENTS_MAX,
    });
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "string" || item.length === 0) {
      throw new CapabilityContractError("ERR_FIELD_NOT_STRING", {
        where: `${where}[${i}]`,
      });
    }
    if (seen.has(item)) {
      throw new CapabilityContractError("ERR_FRICTION_LIFECYCLE_DUPLICATE", {
        where: `${where}[${i}]`,
        value: item,
      });
    }
    seen.add(item);
    out.push(item);
  }
  return deepFreeze(out);
}

function validateRedactionLevel(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapabilityContractError("ERR_FIELD_NOT_STRING", { where });
  }
  if (!FRICTION_REDACTION_LEVEL_SET.has(value)) {
    throw new CapabilityContractError("ERR_REDACTION_LEVEL_UNKNOWN", {
      where,
      value,
    });
  }
  return value;
}

function isKnownCapability(name) {
  return typeof name === "string" && CAPABILITY_NAME_SET.has(name);
}

module.exports = {
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_NAMES,
  CAPABILITY_LEVELS,
  CAPABILITY_SOURCES,
  FRICTION_SIGNAL_NAMES,
  FRICTION_SIGNAL_NAMES_MAX,
  FRICTION_OBSERVABILITY,
  FRICTION_REDACTION_LEVELS,
  FRICTION_LIFECYCLE_EVENTS_MAX,
  MAX_HOST_ADAPTER_ID_LENGTH,
  MAX_HOST_VENDOR_LENGTH,
  MAX_HOST_VERSION_LENGTH,
  MAX_CAPABILITY_REASON_LENGTH,
  CapabilityContractError,
  isValidIsoTimestamp,
  validateCapabilityDescriptor,
  isKnownCapability,
};