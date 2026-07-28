"use strict";

// ─── Coordination Adapter Core (legacy + v1 capability compat) ───────────────
// Two coexisting capability descriptor shapes are supported during the M-002
// compatibility window (P-001 / T-ARI-001):
//
//   1. Legacy boolean descriptor (createAdapterDescriptor)
//      { adapterId, vendor, capabilities: { foo: true|false, ... } }
//      Used by the notification-pump / samhmi-pilot flow. Stays supported for
//      one release so callers do not silently flip to unsupported behavior.
//
//   2. v1 capability descriptor (createV1CapabilityDescriptor) — delegates to
//      lib/runtime-adapters/capability-contract.validateCapabilityDescriptor.
//      Frozen vocabulary, closed-enum level/source, deep-frozen output.
//
// The mapping from legacy boolean caps to v1 capability names is frozen by
// this file. Changing it requires bumping the version column below.
//
//   CAPABILITY_MAPPING_SCHEMA = "legacy->v1/1.0"
//
// Zero external dependencies — Node.js built-ins only.

const path = require("node:path");

const runtimeCapabilityContract = require("../runtime-adapters/capability-contract");

const CAPABILITY_MAPPING_SCHEMA = "legacy->v1/1.0";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_PATTERN = /(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]/i;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'`])\/(?:Users|home|var|tmp|private|opt|etc)\//;
const WINDOWS_ABSOLUTE_PATH = /(^|[\s"'`])[A-Za-z]:[\\/]/;
const IPV4_ADDRESS = /(^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}([^0-9]|$)/;

const REPORTING_MODES = Object.freeze({
  HOOK: "hook",
  EXPLICIT_CLI: "explicit_cli",
});

const DELIVERY_RESULTS = Object.freeze({
  DELIVERED: "delivered",
  DEFERRED: "deferred",
  SKIPPED: "skipped",
});

// Capability levels / sources — re-exposed for callers that want to avoid
// reaching into lib/runtime-adapters directly.
const CAPABILITY_LEVELS = runtimeCapabilityContract.CAPABILITY_LEVELS;
const CAPABILITY_SOURCES = runtimeCapabilityContract.CAPABILITY_SOURCES;
const CAPABILITY_NAMES = runtimeCapabilityContract.CAPABILITY_NAMES;
const CAPABILITY_DESCRIPTOR_SCHEMA_VERSION =
  runtimeCapabilityContract.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION;

// ─── Capability mapping table (legacy → v1, frozen) ─────────────────────────
//
// Each legacy boolean capability is mapped to one or more v1 capability
// entries with a function that derives the precise level / source / reason
// from the legacy boolean plus an optional `host.version` / `host.detectedAt`
// hint. The result is a partial capability map that the descriptor builder
// merges across all entries exposed by the adapter.
//
// Rules:
//   - true  + adapter-side evidence  → level=adapter / source=static-analysis
//     true  + host-side evidence     → level=native  / source=runtime-trace
//   - false                          → level=unsupported / source=not-exposed
//   - not exposed (deferred/null)     → level=unobservable / source=not-exposed
//
// All mappings carry a short `reason` string so consumers can audit why a
// capability received its level.
const LEGACY_TO_V1_MAPPING = Object.freeze([
  // Codex legacy boolean caps. Ordering matters: recoveryConsumer runs
  // FIRST so it can emit a base `unobservable` / `unsupported` verdict for
  // session.boundary; later rules (threadWakeup) overwrite with a stronger
  // level when an evidence-backed capability is present. Last write wins.
  Object.freeze({
    legacy: "recoveryConsumer",
    adapterIds: ["codex"],
    capability: "session.boundary",
    derive: (enabled, host) => {
      if (!enabled) {
        return {
          level: "unsupported",
          source: "not-exposed",
          reason: "recoveryConsumer legacy boolean=false",
        };
      }
      const hasBoundarySignal =
        host.threadWakeup === true || host.structuredContext === true;
      if (hasBoundarySignal) {
        // recoveryConsumer will be overwritten by threadWakeup when it runs.
        // Emit a placeholder here only when no later rule will overwrite.
        return {
          level: "unobservable",
          source: "not-exposed",
          reason: "recoveryConsumer pending stronger signal",
        };
      }
      return {
        level: "unobservable",
        source: "not-exposed",
        reason: "recovery-only, no session boundary signal exposed",
      };
    },
  }),
  Object.freeze({
    legacy: "threadWakeup",
    adapterIds: ["codex"],
    capability: "session.boundary",
    derive: (enabled) => enabled
      ? { level: "adapter", source: "static-analysis", reason: "threadWakeup legacy boolean=true" }
      : { level: "unsupported", source: "not-exposed", reason: "threadWakeup legacy boolean=false" },
  }),
  Object.freeze({
    legacy: "structuredContext",
    adapterIds: ["codex"],
    capability: "message.boundary",
    derive: (enabled) => enabled
      ? { level: "adapter", source: "static-analysis", reason: "structuredContext legacy boolean=true" }
      : { level: "unsupported", source: "not-exposed", reason: "structuredContext legacy boolean=false" },
  }),

  // Claude legacy boolean caps
  Object.freeze({
    legacy: "hooks",
    adapterIds: ["claude-code"],
    capability: "tool.before.observe",
    derive: (enabled) => enabled
      ? { level: "native", source: "runtime-trace", reason: "Claude hooks expose native tool.before" }
      : { level: "unsupported", source: "not-exposed", reason: "Claude hooks disabled" },
  }),
  Object.freeze({
    legacy: "explicitCli",
    adapterIds: ["claude-code"],
    capability: "context.render.observe",
    derive: (enabled) => enabled
      ? { level: "explicit", source: "self-reported", reason: "explicit CLI fallback can report context render" }
      : { level: "unsupported", source: "not-exposed", reason: "explicit CLI fallback disabled" },
  }),
  Object.freeze({
    legacy: "processBoundaryEvidence",
    adapterIds: ["claude-code"],
    capability: "turn.boundary",
    derive: (enabled) => enabled
      ? { level: "adapter", source: "static-analysis", reason: "process exit code observable as turn.boundary" }
      : { level: "unobservable", source: "not-exposed", reason: "process boundary evidence unavailable" },
  }),
]);

function assertSafeId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a stable identifier`);
  }
  return value;
}

// v1 host.version is constrained by the frozen contract (non-empty, bounded,
// no slashes / backslashes / control chars) but is NOT constrained by the
// legacy SAFE_ID pattern (which forbids '/' used in semver tags and many
// real-world host versions). This helper accepts the v1 contract's relaxed
// shape so adapters can pass through their natural host version.
const HOST_VERSION_REGEX = /^[A-Za-z0-9._+\-]{1,64}$/;
function assertHostVersion(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  if (value.length > 64 || !HOST_VERSION_REGEX.test(value)) {
    throw new TypeError(`${field} must contain only safe version chars`);
  }
  return value;
}

function assertSafeText(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  if (SECRET_PATTERN.test(value) || POSIX_ABSOLUTE_PATH.test(value)
      || WINDOWS_ABSOLUTE_PATH.test(value) || IPV4_ADDRESS.test(value)) {
    throw new TypeError(`${field} contains private runtime data`);
  }
  return value;
}

function assertRepoRelative(value, field) {
  assertSafeText(value, field);
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".."
      || normalized.startsWith("../")) {
    throw new TypeError(`${field} must be repository-relative`);
  }
  return normalized;
}

function normalizeStringList(values, field, validator = assertSafeText) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${field} must be an array`);
  }
  return Object.freeze(values.map((value, index) =>
    validator(value, `${field}[${index}]`)));
}

// ─── Legacy boolean descriptor (compat window) ──────────────────────────────

function createAdapterDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("adapter descriptor must be an object");
  }
  const capabilities = {};
  for (const [name, enabled] of Object.entries(input.capabilities || {})) {
    assertSafeId(name, "capability");
    if (typeof enabled !== "boolean") {
      throw new TypeError(`capability ${name} must be boolean`);
    }
    capabilities[name] = enabled;
  }
  return Object.freeze({
    adapterId: assertSafeId(input.adapterId, "adapterId"),
    vendor: assertSafeId(input.vendor, "vendor"),
    capabilities: Object.freeze(capabilities),
    // Stable marker so legacy callers can detect the compat-window shape.
    legacy_schema: "1.0",
  });
}

// `hasCapability` accepts BOTH legacy boolean descriptors and v1 descriptors
// (which expose capability entries as { level, source, reason }). The
// semantics are intentionally aligned: a legacy `true` and a v1 entry with
// level `native|adapter|explicit|unobservable` both mean "available".
function hasCapability(descriptor, capability) {
  if (!descriptor || typeof descriptor !== "object") return false;
  const entry = descriptor.capabilities && descriptor.capabilities[capability];
  if (typeof entry === "boolean") return entry === true;
  if (entry && typeof entry === "object") {
    const level = entry.level;
    return level === "native"
      || level === "adapter"
      || level === "explicit"
      || level === "unobservable";
  }
  return false;
}

function sanitizeEvidenceRefs(evidenceRefs = []) {
  if (!Array.isArray(evidenceRefs)) {
    throw new TypeError("evidenceRefs must be an array");
  }
  return Object.freeze(evidenceRefs.map((ref, index) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new TypeError(`evidenceRefs[${index}] must be an object`);
    }
    return Object.freeze({
      kind: assertSafeId(ref.kind, `evidenceRefs[${index}].kind`),
      ref: assertSafeText(ref.ref, `evidenceRefs[${index}].ref`),
    });
  }));
}

// ─── v1 capability descriptor producer (M-002) ──────────────────────────────

// Build a v1 capability descriptor from a host descriptor (legacy shape or
// already-collected input). The output is the frozen contract object
// produced by lib/runtime-adapters/capability-contract — same shape that
// M-001 validated. Adapters that want the v1 shape call this directly and
// attach it as `descriptor.capabilityDescriptor` so legacy callers still see
// `descriptor.capabilities[foo]` booleans.
function createV1CapabilityDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("v1 capability descriptor input must be an object");
  }
  const adapterId = assertSafeId(input.adapterId, "adapterId");
  // Only default vendor when caller omits it; an explicit empty string is
  // an error so callers cannot silently lose vendor information.
  const vendor = assertSafeId(
    input.vendor === undefined || input.vendor === null ? "unknown" : input.vendor,
    "vendor",
  );
  const version = assertHostVersion(
    typeof input.version === "string" && input.version.length > 0
      ? input.version
      : "0.0.0",
    "version",
  );
  const detectedAt = normaliseDetectedAt(input.detectedAt);
  const capabilities = collectV1Capabilities(adapterId, input);
  const descriptor = runtimeCapabilityContract.validateCapabilityDescriptor({
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: adapterId, vendor, version },
    detected_at: detectedAt,
    capabilities,
  });
  return descriptor;
}

function normaliseDetectedAt(value) {
  if (typeof value === "string") {
    if (!runtimeCapabilityContract.isValidIsoTimestamp(value)) {
      throw new TypeError("detectedAt must be an ISO-8601 timestamp");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value === undefined || value === null) {
    return new Date().toISOString();
  }
  throw new TypeError("detectedAt must be ISO-8601 string or epoch ms");
}

function collectV1Capabilities(adapterId, input) {
  // Only run rules whose legacy capability key is explicitly present in
  // `input.capabilities`. The M-001 contract requires that we do NOT blur
  // "not detected" with "unsupported"; an adapter that omits a legacy
  // boolean declines to make any v1 claim about the mapped v1 capability.
  // Last write still wins within the rules that DO run, so an explicit
  // `recoveryConsumer: true` followed by `threadWakeup: true` will see
  // session.boundary upgraded to `adapter` by threadWakeup.
  const merged = {};
  const host = input.host && typeof input.host === "object" ? input.host : {};
  const legacyCaps = (input.capabilities && typeof input.capabilities === "object")
    ? input.capabilities
    : {};
  for (const rule of LEGACY_TO_V1_MAPPING) {
    if (!rule.adapterIds.includes(adapterId)) continue;
    if (!Object.prototype.hasOwnProperty.call(legacyCaps, rule.legacy)) continue;
    const legacyValue = legacyCaps[rule.legacy];
    const enabled = legacyValue === true;
    const derived = rule.derive(enabled, host);
    if (!CAPABILITY_LEVELS.includes(derived.level)) {
      throw new TypeError(
        `capability mapping rule for ${rule.legacy} emitted unknown level ${derived.level}`,
      );
    }
    if (!CAPABILITY_SOURCES.includes(derived.source)) {
      throw new TypeError(
        `capability mapping rule for ${rule.legacy} emitted unknown source ${derived.source}`,
      );
    }
    merged[rule.capability] = {
      level: derived.level,
      source: derived.source,
      reason: derived.reason,
    };
  }
  const ordered = {};
  for (const key of Object.keys(merged).sort()) {
    ordered[key] = merged[key];
  }
  return ordered;
}

// Wrap a legacy descriptor so it carries both the legacy boolean view
// (used by notification-pump / samhmi-pilot today) AND the v1 capability
// descriptor (under `capabilityDescriptor`) without altering the legacy
// shape's external contract.
function attachV1CapabilityDescriptor(legacyDescriptor, host = {}) {
  if (!legacyDescriptor || typeof legacyDescriptor !== "object") {
    throw new TypeError("legacy descriptor must be an object");
  }
  if (legacyDescriptor.capabilityDescriptor
      && typeof legacyDescriptor.capabilityDescriptor === "object") {
    // Already attached (idempotent).
    return legacyDescriptor;
  }
  const v1 = createV1CapabilityDescriptor({
    adapterId: legacyDescriptor.adapterId,
    vendor: legacyDescriptor.vendor,
    version: typeof host.version === "string" && host.version.length > 0
      ? host.version
      : (typeof legacyDescriptor.version === "string"
          ? legacyDescriptor.version
          : "0.0.0"),
    detectedAt: host.detectedAt,
    host,
    capabilities: legacyDescriptor.capabilities,
  });
  return Object.freeze(Object.assign({}, legacyDescriptor, {
    capabilityDescriptor: v1,
    capabilityMappingSchema: CAPABILITY_MAPPING_SCHEMA,
  }));
}

module.exports = {
  // Legacy exports (compat window — preserved exactly as M-001 inherited).
  DELIVERY_RESULTS,
  REPORTING_MODES,
  assertRepoRelative,
  assertSafeId,
  assertSafeText,
  createAdapterDescriptor,
  hasCapability,
  normalizeStringList,
  sanitizeEvidenceRefs,
  // M-002 additions: v1 capability descriptor surface.
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_LEVELS,
  CAPABILITY_NAMES,
  CAPABILITY_SOURCES,
  CAPABILITY_MAPPING_SCHEMA,
  LEGACY_TO_V1_MAPPING,
  attachV1CapabilityDescriptor,
  createV1CapabilityDescriptor,
};