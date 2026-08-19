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
// ─── Existing vendor-specific adapter core ────────────────────────────────────
// Below block is the legacy adapter-core (descriptor model, safe-id/text
// validators). It remains exported unchanged so claude-adapter, codex-adapter,
// application-service and coordination-adapters.test keep working.
//
// ─── Host Wakeup Adapter (vendor-neutral) additions ──────────────────────────
// Vendor-neutral Host Wakeup contract layered ON TOP of the legacy descriptors.
// New API: createHostAdapter, handshake, buildStructuredContext, threadWakeup,
// registerRecoveryConsumer, healthSnapshot, ackResult, deferredNoHost,
// checkDenyRules. All state machine + allowlist + deny-rule logic lives here.

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

// ─── Host Wakeup Adapter implementation ──────────────────────────────────────
// Pure logic. No fs / child_process / network. Every input that crosses the
// host <-> cortex boundary goes through checkDenyRules first.

const PHASES = Object.freeze([
  "pending",
  "deferred",
  "running",
  "ack_pending",
  "completed",
  "failed",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(["running", "deferred", "failed", "ack_pending"]),
  deferred: new Set(["pending", "failed"]),
  running: new Set(["ack_pending", "failed"]),
  ack_pending: new Set(["completed", "failed"]),
  completed: new Set(),
  failed: new Set(),
});

const REGISTERED_ADAPTER_IDS = Object.freeze([
  "codex.local",
  "codex.dev",
  "claude-code.local",
  "claude-code.dev",
  "cursor.local",
  "cursor.dev",
  "windsurf.local",
  "windsurf.dev",
  "cline.local",
  "amazon-q.local",
  // M-029 / P-006: DSH (DeepSeek Harness) first-class adapter promoted from
  // TCP shadow host (D-TCP-004). Registered here so the coordination runtime
  // accepts `dsh.local` / `dsh.dev` descriptors; capability descriptor
  // itself lives in `lib/agents/adapters/dsh.js#_buildCapabilityDescriptor`
  // and is reported through the dispatch discover() surface (M-029 MS-001,
  // commit `7d877a8`). Awaiting real DSH wakeup / hook evidence before
  // promoting to a fully wired threadWakeup + buildStructuredContext path
  // (M-018, optional). Authority: D-ARI-P006-promote-dsh-firstclass.
  "dsh.local",
  "dsh.dev",
  "generic.prod",
]);

const STRUCTURED_CONTEXT_FIELDS = Object.freeze([
  "threadId",
  "summary",
  "references",
  "constraints",
  "priority",
]);

const RESULT_STATUSES = Object.freeze(["completed", "failed"]);

// Deny rules: each entry detects a class of sensitive payload that must NEVER
// reach a host. Reason never echoes the rejected value back (side-channel safe).
const DENY_RULES = Object.freeze([
  {
    id: "token",
    description: "API / personal access / OAuth tokens",
    regex: /(?:ghp_|gho_|ghs_|ghr_|sk-ant-api|sk-proj-|sk-[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/,
  },
  {
    id: "terminal",
    description: "terminal / shell output transcript",
    regex: /(?:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]*\$|\$\s+[^\n]{1,200}\n|#\s+[A-Za-z0-9._/-]+:[0-9]+\b)/,
  },
  {
    id: "pid",
    description: "numeric PID",
    regex: /\b(?:pid|process[_-]?id)\s*[=:]\s*\d{1,7}\b/i,
  },
  {
    id: "socket",
    description: "unix socket / named pipe path",
    regex: /\.(?:sock|np)$|^\/var\/run\//,
  },
  {
    id: "executable",
    description: "executable / binary reference",
    regex: /(?:^|[\s`'"])(?:\/(?:usr|bin|sbin|opt)\/[A-Za-z0-9._-]+|\b(?:nohup|sudo)\s+[A-Za-z0-9._/-]+)/,
  },
  {
    id: "command",
    description: "shell command-like pattern",
    regex: /\b(?:rm|chmod|chown|mkfs|dd|kill(?:all)?|curl|wget)\b\s+(?:-{1,2}[A-Za-z]+\s+)*\S+/,
  },
  {
    id: "prompt",
    description: "prompt injection marker",
    regex: /\b(?:ignore (?:all )?(?:previous|prior|above) instructions|reveal (?:the )?system prompt|disregard (?:the )?(?:system|developer) (?:prompt|messages?))\b/i,
  },
  {
    id: "ip",
    description: "literal IP address (IPv4 / IPv6)",
    // IPv4: dotted quad. IPv6: at least 3 hex: groups AND either :: shorthand OR 4+ groups.
    regex: /(?:\b(?:\d{1,3}\.){3}\d{1,3}\b)|(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){3,})/,
  },
  {
    id: "absPath",
    description: "absolute filesystem path",
    regex: /(?:^|[\s"'`(])(?:\/(?:Users|home|var|tmp|private|opt|etc)\/|(?:[A-Za-z]:[\\/])|\\\\\?\\)/,
  },
]);

function createHostAdapter(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("invalid adapter descriptor: must be a non-array object");
  }
  const { adapterId, capabilities } = input;
  if (typeof adapterId !== "string" || adapterId.length === 0) {
    throw new TypeError("invalid adapter descriptor: adapterId must be a non-empty string");
  }
  if (!REGISTERED_ADAPTER_IDS.includes(adapterId)) {
    throw new Error(`adapter id not registered: ${adapterId}`);
  }
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== "string" || c.length === 0)) {
    throw new TypeError("invalid adapter descriptor: capabilities must be an array of non-empty strings");
  }
  // adapter object itself is NOT frozen — the runtime state (handshakeOk,
  // tasks, recoveryConsumers) must be writable across the handshake / wakeup /
  // ack lifecycle. Public fields are exposed read-only via Object.defineProperty.
  const adapter = {
    adapterId,
    schemaVersion: "1.0",
    capabilities: Object.freeze([...capabilities]),
    recoveryConsumers: Object.freeze([]),
    tasks: new Map(),
    handshakeOk: false,
    autoApprove: false,
    sideEffects: false,
  };
  Object.defineProperty(adapter, "adapterId", { value: adapterId, writable: false, enumerable: true });
  Object.defineProperty(adapter, "schemaVersion", { value: "1.0", writable: false, enumerable: true });
  Object.defineProperty(adapter, "capabilities", { value: adapter.capabilities, writable: false, enumerable: true });
  return adapter;
}

function handshake(adapter, { required } = {}) {
  if (!adapter || !adapter.adapterId) throw new Error("handshake requires a registered adapter");
  const requiredCaps = required || adapter.capabilities;
  const missing = requiredCaps.filter((c) => !adapter.capabilities.includes(c));
  const ok = missing.length === 0;
  if (ok) adapter.handshakeOk = true;
  return Object.freeze({
    ok,
    adapterId: adapter.adapterId,
    schemaVersion: adapter.schemaVersion,
    missingCapabilities: Object.freeze([...missing]),
  });
}

function buildStructuredContext(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("structuredContext must be a non-array object");
  }
  for (const key of Object.keys(input)) {
    if (!STRUCTURED_CONTEXT_FIELDS.includes(key)) {
      throw new Error(`structuredContext field '${key}' not in allowlist`);
    }
  }
  if (typeof input.threadId !== "string" || input.threadId.length === 0) {
    throw new TypeError("structuredContext.threadId must be a non-empty string");
  }
  if (typeof input.summary !== "string" || input.summary.length === 0) {
    throw new TypeError("structuredContext.summary must be a non-empty string");
  }
  if (input.references !== undefined && !Array.isArray(input.references)) {
    throw new TypeError("structuredContext.references must be an array when present");
  }
  if (input.constraints !== undefined && !Array.isArray(input.constraints)) {
    throw new TypeError("structuredContext.constraints must be an array when present");
  }
  const deny = checkDenyRules(input);
  if (!deny.ok) throw new Error(`structuredContext blocked by deny rule '${deny.ruleId}': ${deny.reason}`);
  return Object.freeze({
    threadId: input.threadId,
    summary: input.summary,
    references: input.references ? Object.freeze([...input.references]) : Object.freeze([]),
    constraints: input.constraints ? Object.freeze([...input.constraints]) : Object.freeze([]),
    priority: input.priority || "normal",
  });
}

function threadWakeup(adapter, payload) {
  if (!adapter || !adapter.handshakeOk) {
    throw new Error("threadWakeup requires a successful handshake");
  }
  if (!adapter.capabilities.includes("thread.wakeup")) {
    throw new Error("missing capability: thread.wakeup");
  }
  if (!payload || typeof payload !== "object") {
    throw new TypeError("wakeup payload must be an object");
  }
  if (!payload.context || typeof payload.context !== "object") {
    throw new TypeError("wakeup payload.context must be a structured context");
  }
  const deny = checkDenyRules(payload.context);
  if (!deny.ok) throw new Error(`wakeup blocked by deny rule '${deny.ruleId}'`);
  const taskId = generateHostAdapterTaskId();
  // autoApprove & side effects are fixed at false regardless of caller intent
  const wakeup = Object.freeze({
    taskId,
    threadId: payload.context.threadId,
    context: payload.context,
    state: "pending",
    autoApprove: false,
    sideEffects: false,
    deferredReason: null,
  });
  adapter.tasks.set(taskId, { state: "pending", history: [{ at: Date.now(), event: "wakeup" }] });
  return wakeup;
}

function registerRecoveryConsumer(adapter, input) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  if (!adapter.capabilities.includes("consumer.recovery")) {
    throw new Error("missing capability: consumer.recovery");
  }
  if (!input || typeof input.consumerId !== "string" || input.consumerId.length === 0) {
    throw new TypeError("recovery consumer requires a non-empty consumerId");
  }
  // idempotent: re-registering the same consumerId returns the same record
  const exists = adapter.recoveryConsumers.find((c) => c.consumerId === input.consumerId);
  if (exists) return Object.freeze({ ...exists });
  const record = Object.freeze({
    consumerId: input.consumerId,
    registeredAt: Date.now(),
  });
  // recoveryConsumers was frozen empty; we mutate the underlying array via push,
  // but we re-freeze a new array to keep immutability discipline.
  const next = [...adapter.recoveryConsumers, record];
  Object.defineProperty(adapter, "recoveryConsumers", {
    value: Object.freeze(next),
    writable: false,
    configurable: true,
    enumerable: true,
  });
  return record;
}

function healthSnapshot(adapter, input) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  if (!adapter.capabilities.includes("health.snapshot")) {
    throw new Error("missing capability: health.snapshot");
  }
  if (!input || typeof input.state !== "string") {
    throw new TypeError("healthSnapshot requires input.state");
  }
  const safe = ["ready", "busy", "degraded", "offline"];
  if (!safe.includes(input.state)) {
    throw new TypeError(`healthSnapshot.state must be one of ${safe.join(",")}`);
  }
  return Object.freeze({
    adapterId: adapter.adapterId,
    schemaVersion: adapter.schemaVersion,
    state: input.state,
    capabilities: adapter.capabilities,
    pendingTasks: Array.from(adapter.tasks.values()).filter((t) => t.state === "pending" || t.state === "deferred").length,
    note: input.note && typeof input.note === "string" ? input.note : null,
  });
}

function ackResult(adapter, input) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  if (!input || typeof input.taskId !== "string" || input.taskId.length === 0) {
    throw new TypeError("ack requires a taskId");
  }
  if (!RESULT_STATUSES.includes(input.status)) {
    throw new TypeError(`invalid status: ${input.status}`);
  }
  const task = adapter.tasks.get(input.taskId);
  if (!task) throw new Error(`unknown task: ${input.taskId}`);
  if (task.state !== "ack_pending") {
    throw new Error(`not ack-eligible: state=${task.state}`);
  }
  // transition ack_pending -> completed | failed
  transition(adapter, input.taskId, { to: input.status });
  return Object.freeze({ ok: true, taskId: input.taskId, status: input.status });
}

function deferredNoHost(adapter, taskId, { reason } = {}) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  const task = adapter.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  transition(adapter, taskId, { to: "deferred" });
  // Also record the reason on the wakeup-shaped result. Caller stores it
  // separately if they want to surface it; we never put reason in shared state.
  return Object.freeze({
    taskId,
    state: "deferred",
    reason: typeof reason === "string" ? reason : "no-host",
  });
}

function transition(adapter, taskId, { from, to }) {
  const task = adapter.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (from && task.state !== from) {
    throw new Error(`transition mismatch: expected from=${from}, actual=${task.state}`);
  }
  const allowed = ALLOWED_TRANSITIONS[task.state] || new Set();
  if (!allowed.has(to)) {
    throw new Error(`illegal transition: ${task.state} -> ${to}`);
  }
  task.state = to;
  task.history.push({ from: task.state, to, at: Date.now() });
  return { taskId, state: to };
}

function getState(adapter, taskId) {
  const t = adapter.tasks.get(taskId);
  return t ? t.state : null;
}

function hasTask(adapter, taskId) {
  return Boolean(adapter && adapter.tasks && adapter.tasks.has(taskId));
}

function recordTask(adapter, taskId, payload) {
  if (!adapter.tasks) throw new Error("adapter not initialized");
  adapter.tasks.set(taskId, { ...payload, history: [{ at: Date.now(), event: "created" }] });
  return adapter.tasks.get(taskId);
}

// Walk an arbitrary payload tree and reject if any DENY_RULE matches.
function checkDenyRules(obj) {
  const seen = new WeakSet();
  function walk(value, path) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      for (const rule of DENY_RULES) {
        if (rule.regex.test(value)) {
          return { ok: false, ruleId: rule.id, reason: `${rule.description} detected at ${path}` };
        }
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const hit = walk(value[i], `${path}[${i}]`);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value)) {
      const hit = walk(child, `${path}.${key}`);
      if (hit) return hit;
    }
    return null;
  }
  const hit = walk(obj, "$");
  if (hit) return { ok: false, ruleId: hit.ruleId, reason: hit.reason };
  return { ok: true };
}

let _hostTaskCounter = 0;
function generateHostAdapterTaskId() {
  _hostTaskCounter += 1;
  // Monotonic within process; deterministic enough for tests.
  return `HA-${process.pid || 0}-${_hostTaskCounter.toString(36)}`;
}

// Sentinel block to mark end of Host Wakeup additions

// ─── module.exports (placed at end to avoid TDZ on new consts) ────────────────
module.exports = {
  // Legacy vendor-specific exports (unchanged)
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
  // Host Wakeup Adapter (vendor-neutral) additions
  REGISTERED_ADAPTER_IDS,
  STRUCTURED_CONTEXT_FIELDS,
  RESULT_STATUSES,
  PHASES,
  ALLOWED_TRANSITIONS,
  DENY_RULES,
  createHostAdapter,
  handshake,
  buildStructuredContext,
  threadWakeup,
  registerRecoveryConsumer,
  healthSnapshot,
  ackResult,
  deferredNoHost,
  checkDenyRules,
  transition,
  getState,
  hasTask,
  recordTask,
};
