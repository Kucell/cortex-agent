"use strict";

// ─── MiniMax CLI Capability Snapshot Contract (M-011 / ARI P-005 / T-ARI-001) ──
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// ARI P-005 frozen proposal: .agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-005-minimax-cli-governed-tool-adapter-proposal.md
// Frozen SHA-256: f377943b6eb73d44308a86d965229730ba2552613ae611e3e511457c13f4587d
//
// Public API:
//   - MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION : "1.0"
//   - MINIMAX_AUTH_STATES                       : frozen ["unknown"] (only — see DEFAULTS below)
//   - MINIMAX_AUTH_STATES_FULL                  : frozen ["ready","blocked","unknown"] (full vocabulary; "ready"/"blocked" disabled for this Mission)
//   - MINIMAX_RESOURCES                         : frozen ["text","image","video","speech","music","vision","search"]
//   - MINIMAX_ASYNC_RESOURCES                   : frozen subset of MINIMAX_RESOURCES that have task get / download
//   - MINIMAX_ASYNC_JOB_STATUSES                : frozen async job status vocabulary
//   - MINIMAX_PROBE_FAMILIES                    : frozen allow-listed mmx command families (exactly 3 — see VC-011-01-04)
//   - MINIMAX_OUTPUT_REF_KINDS                  : frozen output_refs[].kind vocabulary
//   - MINIMAX_COST_STATUSES                     : frozen ["measured","estimated","unavailable"]
//   - TAINT_PATTERNS                            : shared with boundary-event
//   - CapabilitySnapshotContractError           : structured error carrier
//   - validateCapabilitySnapshot(input)         : throws or returns frozen snapshot (rejects auth_state !== "unknown")
//   - validateAsyncJobDescriptor(input)         : throws or returns frozen async job
//   - redactAuthStatus(stdout)                  : DEPRECATED for this Mission; throws if invoked. Kept for separate future authorization.
//   - classifyAuthState(stdout)                 : DEPRECATED for this Mission; throws if invoked. Kept for separate future authorization.
//   - isAuthReadinessEnabled()                  : returns false in this Mission (always false until separate authorization)
//   - stableSnapshotHash(snapshot)              : deterministic JSON canonical SHA-256 (resource_digest source)
//
// Design rules (frozen by ARI P-005 M-011):
//   - Schema is closed; unknown top-level / nested fields are rejected.
//   - Auth state is the only field that surfaces MiniMax CLI authentication posture.
//     In this Mission, the value MUST be "unknown" (auth probing is disabled). Any
//     "ready" / "blocked" value is rejected with ERR_AUTH_STATE_DISABLED until a
//     separate authorization record lifts this constraint. The `redactAuthStatus`
//     and `classifyAuthState` pure functions remain in the module for that future
//     use, but throw CapabilitySnapshotContractError("ERR_AUTH_READINESS_DISABLED")
//     if invoked today.
//   - The probe allow-list is exactly three families: "version", "help",
//     "resource_help". `mmx auth status`, `mmx config export-schema`, `mmx quota`,
//     `mmx update`, `mmx install`, `mmx <resource> chat|generate|search|...` are
//     NOT in the allow-list and any attempt to build args for them raises
//     MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED") in the probe module.
//   - Capability entries mirror capability-contract (T-ARI-001): {level, source, reason}.
//   - Output refs of async jobs MUST NOT include raw URLs, query strings, or
//     credential-bearing path segments; redacted:true is mandatory.

const MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION = "1.0";
const MINIMAX_ASYNC_JOB_SCHEMA_VERSION = "1.0";

// Full auth state vocabulary (frozen contract surface). In this Mission only
// "unknown" is accepted (see DEFAULTS / ERR_AUTH_STATE_DISABLED below).
const MINIMAX_AUTH_STATES_FULL = Object.freeze(["ready", "blocked", "unknown"]);
const MINIMAX_AUTH_STATES_FULL_SET = new Set(MINIMAX_AUTH_STATES_FULL);

// The Mission's enforced auth state vocabulary. Anything outside this set is
// rejected with ERR_AUTH_STATE_DISABLED — the snapshot is force-pinned to
// "unknown" until separate authorization lifts the constraint.
const MINIMAX_AUTH_STATES = Object.freeze(["unknown"]);
const MINIMAX_AUTH_STATE_SET = new Set(MINIMAX_AUTH_STATES);

// Disable flag: gate for any "ready"/"blocked" inference. Single source of truth.
const AUTH_READINESS_ENABLED = false;

// Reason string persisted as `auth_state_reason` for every snapshot in this Mission.
const AUTH_READINESS_DISABLED_REASON = "auth_probing_disabled";

const MINIMAX_RESOURCES = Object.freeze([
  "text",
  "image",
  "video",
  "speech",
  "music",
  "vision",
  "search",
]);
const MINIMAX_RESOURCE_SET = new Set(MINIMAX_RESOURCES);

const MINIMAX_ASYNC_RESOURCES = Object.freeze(["image", "video", "speech", "music"]);
const MINIMAX_ASYNC_RESOURCE_SET = new Set(MINIMAX_ASYNC_RESOURCES);

const MINIMAX_ASYNC_JOB_STATUSES = Object.freeze([
  "submitted",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
const MINIMAX_ASYNC_JOB_STATUS_SET = new Set(MINIMAX_ASYNC_JOB_STATUSES);

const MINIMAX_OUTPUT_REF_KINDS = Object.freeze(["url", "path"]);
const MINIMAX_OUTPUT_REF_KIND_SET = new Set(MINIMAX_OUTPUT_REF_KINDS);

const MINIMAX_COST_STATUSES = Object.freeze(["measured", "estimated", "unavailable"]);
const MINIMAX_COST_STATUS_SET = new Set(MINIMAX_COST_STATUSES);

// Allow-listed probe command families — VC-011-01-04 (ARI P-005 §7 Phase 0).
// EXACTLY three families.  Anything outside this list must fail-closed at the
// probe layer with MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED").
//   - "version"       → `mmx --version`
//   - "help"          → `mmx --help`
//   - "resource_help" → `mmx <resource> --help` (per MINIMAX_RESOURCES)
const MINIMAX_PROBE_FAMILIES = Object.freeze([
  "version",
  "help",
  "resource_help",
]);

const MINIMAX_PROBE_FAMILY_SET = new Set(MINIMAX_PROBE_FAMILIES);

// Shared with boundary-event / runtime-state — keep these in sync with
// lib/runtime-adapters/boundary-event.js so the same taint patterns are
// recognised everywhere.  MiniMax-specific additions only.
const TAINT_PATTERNS = Object.freeze([
  { id: "pem_private_key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/ },
  { id: "github_pat", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: "openai_project_key", regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai_legacy_key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "minimax_api_key", regex: /\bsk-c-[A-Za-z0-9]{10,}\b/ },
  { id: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "url_userinfo", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
]);

const SECRET_FIELDS = Object.freeze([
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "key",
  "authorization",
  "auth",
  "cookie",
  "session_cookie",
  "private_key",
  "client_secret",
  "bearer",
  "minimax_api_key",
]);

// Closed schema keys.
const KNOWN_SNAPSHOT_TOP_KEYS = new Set([
  "schema_version",
  "snapshot_id",
  "probe_at",
  "binary",
  "auth_state",
  "auth_state_reason",
  "probe_families",     // NEW (ARI P-005 §5.1): must equal the allow-list at snapshot time
  "capabilities",
  "no_credential",
  "probe_command_log",
]);
const KNOWN_BINARY_KEYS = new Set(["available", "version", "source"]);
const KNOWN_AUTH_STATE_REASON_MAX = 256;
const KNOWN_SNAPSHOT_ID_MAX = 96;
const KNOWN_PROBE_AT_MAX = 64;
const KNOWN_BINARY_VERSION_MAX = 64;
const KNOWN_BINARY_SOURCE_VALUES = Object.freeze(["probe", "manifest", "unknown"]);
const KNOWN_BINARY_SOURCE_SET = new Set(KNOWN_BINARY_SOURCE_VALUES);

// Capability contract vocabulary (frozen by T-ARI-001).
const CAPABILITY_LEVELS = Object.freeze([
  "native",
  "adapter",
  "explicit",
  "unobservable",
  "unsupported",
]);
const CAPABILITY_LEVEL_SET = new Set(CAPABILITY_LEVELS);
const CAPABILITY_SOURCES = Object.freeze([
  "extension-api",
  "runtime-trace",
  "static-analysis",
  "manifest-claim",
  "self-reported",
  "not-exposed",
  "not-implemented",
]);
const CAPABILITY_SOURCE_SET = new Set(CAPABILITY_SOURCES);
const KNOWN_CAPABILITY_ENTRY_KEYS = new Set(["level", "source", "reason"]);
const MAX_CAPABILITY_REASON_LENGTH = 256;

const KNOWN_ASYNC_JOB_TOP_KEYS = new Set([
  "schema_version",
  "job_id",
  "resource",
  "status",
  "submitted_at",
  "last_observed_at",
  "output_refs",
  "cost_status",
  "redacted",
]);

const KNOWN_OUTPUT_REF_KEYS = new Set(["kind", "ref", "redacted"]);

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SNAPSHOT_ID_REGEX = /^MCAP-[A-Za-z0-9._-]+$/;
const JOB_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const REF_STRING_MAX = 512;

class CapabilitySnapshotContractError extends Error {
  constructor(code, details) {
    super(`[minimax-cli-capability-contract:${code}] ${describe(details)}`);
    this.name = "CapabilitySnapshotContractError";
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
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asNonEmptyString(value, where, max = 4096) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapabilitySnapshotContractError("ERR_FIELD_NOT_STRING", { where });
  }
  if (value.length > max) {
    throw new CapabilitySnapshotContractError("ERR_FIELD_TOO_LONG", { where, max });
  }
  return value;
}

function asBoundedString(value, where, max) {
  if (typeof value !== "string") {
    throw new CapabilitySnapshotContractError("ERR_FIELD_NOT_STRING", { where });
  }
  if (value.length > max) {
    throw new CapabilitySnapshotContractError("ERR_FIELD_TOO_LONG", { where, max });
  }
  return value;
}

function rejectUnknownKeys(obj, known, where) {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new CapabilitySnapshotContractError("ERR_FIELD_UNKNOWN", { where, key });
    }
  }
}

function scanForTaint(value, where) {
  if (typeof value !== "string") return;
  for (const rule of TAINT_PATTERNS) {
    if (rule.regex.test(value)) {
      throw new CapabilitySnapshotContractError("ERR_SNAPSHOT_TAINTED", {
        where,
        rule: rule.id,
      });
    }
  }
}

function walkNoTaint(value, where) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    scanForTaint(value, where);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkNoTaint(value[i], `${where}[${i}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (hasSecretFieldName(key)) {
        throw new CapabilitySnapshotContractError("ERR_SNAPSHOT_TAINTED", {
          where: `${where}.${key}`,
          rule: "secret_field_name",
        });
      }
      walkNoTaint(value[key], `${where}.${key}`);
    }
  }
}

function hasSecretFieldName(key) {
  if (typeof key !== "string") return false;
  const normalised = key.toLowerCase();
  for (const name of SECRET_FIELDS) {
    if (normalised === name) return true;
    if (normalised.endsWith("_" + name) || normalised.endsWith("-" + name)) return true;
  }
  return false;
}

function isValidIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > KNOWN_PROBE_AT_MAX) return false;
  return ISO_TIMESTAMP_REGEX.test(value);
}

function normalizeTimestamp(value, where) {
  if (typeof value === "string") {
    if (!isValidIsoTimestamp(value)) {
      throw new CapabilitySnapshotContractError("ERR_TIMESTAMP_INVALID", {
        where,
        reason: "non_iso_string",
      });
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new CapabilitySnapshotContractError("ERR_TIMESTAMP_INVALID", {
        where,
        reason: "unparseable",
      });
    }
    return d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  throw new CapabilitySnapshotContractError("ERR_TIMESTAMP_INVALID", {
    where,
    reason: "unsupported_type",
  });
}

function validateBinary(binary, where) {
  if (!isPlainObject(binary)) {
    throw new CapabilitySnapshotContractError("ERR_BINARY_MISSING", { where });
  }
  rejectUnknownKeys(binary, KNOWN_BINARY_KEYS, `${where}.binary`);
  const available = binary.available;
  if (typeof available !== "boolean") {
    throw new CapabilitySnapshotContractError("ERR_FIELD_NOT_BOOLEAN", {
      where: `${where}.binary.available`,
    });
  }
  let version = null;
  if (binary.version !== undefined && binary.version !== null) {
    version = asBoundedString(binary.version, `${where}.binary.version`, KNOWN_BINARY_VERSION_MAX);
    scanForTaint(version, `${where}.binary.version`);
  }
  let source = "unknown";
  if (binary.source !== undefined && binary.source !== null) {
    source = asNonEmptyString(binary.source, `${where}.binary.source`, 32);
    if (!KNOWN_BINARY_SOURCE_SET.has(source)) {
      throw new CapabilitySnapshotContractError("ERR_BINARY_SOURCE_UNKNOWN", {
        where: `${where}.binary.source`,
        value: source,
      });
    }
  }
  return deepFreeze({ available, version, source });
}

function validateAuthState(value, where) {
  if (typeof value !== "string" || !MINIMAX_AUTH_STATES_FULL_SET.has(value)) {
    throw new CapabilitySnapshotContractError("ERR_AUTH_STATE_UNKNOWN", {
      where,
      value,
    });
  }
  if (AUTH_READINESS_ENABLED === false) {
    // Auth readiness is disabled for this Mission. Only "unknown" is accepted;
    // any "ready"/"blocked" inference is rejected until separate authorization.
    if (value !== "unknown") {
      throw new CapabilitySnapshotContractError("ERR_AUTH_STATE_DISABLED", {
        where,
        value,
        note: "auth readiness disabled for this Mission; only 'unknown' accepted until separate authorization",
      });
    }
  } else if (!MINIMAX_AUTH_STATE_SET.has(value)) {
    // Auth readiness enabled in a future Mission; fall back to the allowed set.
    throw new CapabilitySnapshotContractError("ERR_AUTH_STATE_NOT_ALLOWED", {
      where,
      value,
    });
  }
  return value;
}

function validateAuthStateReason(value, where) {
  if (value === undefined || value === null) {
    // In this Mission we recommend always emitting AUTH_READINESS_DISABLED_REASON
    // for clarity; null is allowed but discouraged.
    return null;
  }
  const reason = asBoundedString(value, where, KNOWN_AUTH_STATE_REASON_MAX);
  scanForTaint(reason, where);
  return reason;
}

function validateProbeFamilies(families, where) {
  if (!Array.isArray(families)) {
    throw new CapabilitySnapshotContractError("ERR_PROBE_FAMILIES_NOT_ARRAY", { where });
  }
  // Set-equality check (order-independent): every member of `families` must be
  // a member of the canonical allow-list, and the count must match.
  const allowed = MINIMAX_PROBE_FAMILIES;
  for (const name of families) {
    if (typeof name !== "string" || allowed.indexOf(name) < 0) {
      throw new CapabilitySnapshotContractError("ERR_PROBE_FAMILY_NOT_ALLOWED", {
        where: `${where}`,
        value: name,
        allowed: allowed.slice(),
      });
    }
  }
  if (families.length !== allowed.length) {
    throw new CapabilitySnapshotContractError("ERR_PROBE_FAMILIES_LENGTH_MISMATCH", {
      where,
      expected: allowed.length,
      actual: families.length,
    });
  }
  // Sort both sides for deterministic comparison (set equality, order-independent).
  const sortedInput = families.slice().sort();
  const sortedAllowed = allowed.slice().sort();
  for (let i = 0; i < sortedAllowed.length; i += 1) {
    if (sortedInput[i] !== sortedAllowed[i]) {
      throw new CapabilitySnapshotContractError("ERR_PROBE_FAMILIES_NOT_CANONICAL", {
        where,
        expected: sortedAllowed.slice(),
        actual: sortedInput.slice(),
      });
    }
  }
  // Return a frozen canonical-order snapshot (preserve canonical order from allow-list).
  return Object.freeze(allowed.slice());
}

function validateCapabilityEntry(entry, name, where) {
  if (!isPlainObject(entry)) {
    throw new CapabilitySnapshotContractError("ERR_CAPABILITY_NOT_OBJECT", {
      where,
      capability: name,
    });
  }
  rejectUnknownKeys(entry, KNOWN_CAPABILITY_ENTRY_KEYS, where);
  const level = asNonEmptyString(entry.level, `${where}.level`);
  if (!CAPABILITY_LEVEL_SET.has(level)) {
    throw new CapabilitySnapshotContractError("ERR_CAPABILITY_LEVEL_UNKNOWN", {
      where: `${where}.level`,
      capability: name,
      value: level,
    });
  }
  const source = asNonEmptyString(entry.source, `${where}.source`);
  if (!CAPABILITY_SOURCE_SET.has(source)) {
    throw new CapabilitySnapshotContractError("ERR_CAPABILITY_SOURCE_UNKNOWN", {
      where: `${where}.source`,
      capability: name,
      value: source,
    });
  }
  let reason = null;
  if (entry.reason !== undefined && entry.reason !== null) {
    reason = asBoundedString(entry.reason, `${where}.reason`, MAX_CAPABILITY_REASON_LENGTH);
    scanForTaint(reason, `${where}.reason`);
  }
  return deepFreeze({ level, source, reason });
}

function validateCapabilities(capabilities, where) {
  if (!isPlainObject(capabilities)) {
    throw new CapabilitySnapshotContractError("ERR_CAPABILITIES_MISSING", { where });
  }
  rejectUnknownKeys(capabilities, new Set(MINIMAX_RESOURCES), where);
  const out = {};
  for (const name of MINIMAX_RESOURCES) {
    out[name] = validateCapabilityEntry(
      capabilities[name] || { level: "unsupported", source: "not-implemented", reason: "absent_from_probe" },
      name,
      `${where}.${name}`
    );
  }
  return deepFreeze(out);
}

function validateProbeCommandLog(log, where) {
  if (!Array.isArray(log)) {
    throw new CapabilitySnapshotContractError("ERR_PROBE_LOG_NOT_ARRAY", { where });
  }
  const out = [];
  for (let i = 0; i < log.length; i += 1) {
    const entry = log[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new CapabilitySnapshotContractError("ERR_PROBE_LOG_ENTRY_INVALID", {
        where: `${where}[${i}]`,
      });
    }
    if (entry.length > 256) {
      throw new CapabilitySnapshotContractError("ERR_FIELD_TOO_LONG", {
        where: `${where}[${i}]`,
        max: 256,
      });
    }
    scanForTaint(entry, `${where}[${i}]`);
    out.push(entry);
  }
  return Object.freeze(out);
}

function validateCapabilitySnapshot(input) {
  if (!isPlainObject(input)) {
    throw new CapabilitySnapshotContractError("ERR_SNAPSHOT_NOT_OBJECT", {
      where: "snapshot",
    });
  }
  rejectUnknownKeys(input, KNOWN_SNAPSHOT_TOP_KEYS, "snapshot");
  const schemaVersion = asNonEmptyString(input.schema_version, "snapshot.schema_version");
  if (schemaVersion !== MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION) {
    throw new CapabilitySnapshotContractError("ERR_SCHEMA_VERSION_UNKNOWN", {
      where: "snapshot.schema_version",
      value: schemaVersion,
    });
  }
  const snapshotId = asNonEmptyString(input.snapshot_id, "snapshot.snapshot_id", KNOWN_SNAPSHOT_ID_MAX);
  if (!SNAPSHOT_ID_REGEX.test(snapshotId)) {
    throw new CapabilitySnapshotContractError("ERR_SNAPSHOT_ID_INVALID", {
      where: "snapshot.snapshot_id",
    });
  }
  const probeAt = normalizeTimestamp(input.probe_at, "snapshot.probe_at");
  const binary = validateBinary(input.binary, "snapshot");
  const authState = validateAuthState(input.auth_state, "snapshot.auth_state");
  const authStateReason = validateAuthStateReason(
    input.auth_state_reason,
    "snapshot.auth_state_reason"
  );
  const probeFamilies = validateProbeFamilies(input.probe_families, "snapshot.probe_families");
  const capabilities = validateCapabilities(input.capabilities, "snapshot.capabilities");
  if (typeof input.no_credential !== "boolean") {
    throw new CapabilitySnapshotContractError("ERR_NO_CREDENTIAL_NOT_BOOLEAN", {
      where: "snapshot.no_credential",
    });
  }
  if (input.no_credential !== true) {
    throw new CapabilitySnapshotContractError("ERR_NO_CREDENTIAL_FALSE", {
      where: "snapshot.no_credential",
      value: input.no_credential,
    });
  }
  const probeCommandLog = validateProbeCommandLog(input.probe_command_log, "snapshot.probe_command_log");

  // Final taint sweep across the whole snapshot.
  walkNoTaint({ auth_state_reason: authStateReason }, "snapshot");

  return deepFreeze({
    schema_version: MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    snapshot_id: snapshotId,
    probe_at: probeAt,
    binary,
    auth_state: authState,
    auth_state_reason: authStateReason,
    probe_families: probeFamilies,
    capabilities,
    no_credential: true,
    probe_command_log: probeCommandLog,
  });
}

function validateOutputRef(entry, idx, where) {
  if (!isPlainObject(entry)) {
    throw new CapabilitySnapshotContractError("ERR_OUTPUT_REF_NOT_OBJECT", {
      where: `${where}[${idx}]`,
    });
  }
  rejectUnknownKeys(entry, KNOWN_OUTPUT_REF_KEYS, `${where}[${idx}]`);
  const kind = asNonEmptyString(entry.kind, `${where}[${idx}].kind`);
  if (!MINIMAX_OUTPUT_REF_KIND_SET.has(kind)) {
    throw new CapabilitySnapshotContractError("ERR_OUTPUT_REF_KIND_UNKNOWN", {
      where: `${where}[${idx}].kind`,
      value: kind,
    });
  }
  const ref = asBoundedString(entry.ref, `${where}[${idx}].ref`, REF_STRING_MAX);
  scanForTaint(ref, `${where}[${idx}].ref`);
  if (entry.redacted !== true) {
    throw new CapabilitySnapshotContractError("ERR_OUTPUT_REF_NOT_REDACTED", {
      where: `${where}[${idx}].redacted`,
      value: entry.redacted,
    });
  }
  return deepFreeze({ kind, ref, redacted: true });
}

function validateAsyncJobDescriptor(input) {
  if (!isPlainObject(input)) {
    throw new CapabilitySnapshotContractError("ERR_ASYNC_JOB_NOT_OBJECT", { where: "async_job" });
  }
  rejectUnknownKeys(input, KNOWN_ASYNC_JOB_TOP_KEYS, "async_job");
  const schemaVersion = asNonEmptyString(input.schema_version, "async_job.schema_version");
  if (schemaVersion !== MINIMAX_ASYNC_JOB_SCHEMA_VERSION) {
    throw new CapabilitySnapshotContractError("ERR_SCHEMA_VERSION_UNKNOWN", {
      where: "async_job.schema_version",
      value: schemaVersion,
    });
  }
  const jobId = asNonEmptyString(input.job_id, "async_job.job_id");
  if (!JOB_ID_REGEX.test(jobId)) {
    throw new CapabilitySnapshotContractError("ERR_JOB_ID_INVALID", { where: "async_job.job_id" });
  }
  const resource = asNonEmptyString(input.resource, "async_job.resource");
  if (!MINIMAX_ASYNC_RESOURCE_SET.has(resource)) {
    throw new CapabilitySnapshotContractError("ERR_ASYNC_RESOURCE_UNKNOWN", {
      where: "async_job.resource",
      value: resource,
    });
  }
  const status = asNonEmptyString(input.status, "async_job.status");
  if (!MINIMAX_ASYNC_JOB_STATUS_SET.has(status)) {
    throw new CapabilitySnapshotContractError("ERR_ASYNC_STATUS_UNKNOWN", {
      where: "async_job.status",
      value: status,
    });
  }
  const submittedAt = normalizeTimestamp(input.submitted_at, "async_job.submitted_at");
  const lastObservedAt = normalizeTimestamp(input.last_observed_at, "async_job.last_observed_at");
  if (!Array.isArray(input.output_refs)) {
    throw new CapabilitySnapshotContractError("ERR_OUTPUT_REFS_NOT_ARRAY", {
      where: "async_job.output_refs",
    });
  }
  const outputRefs = Object.freeze(
    input.output_refs.map((entry, idx) => validateOutputRef(entry, idx, "async_job.output_refs"))
  );
  const costStatus = asNonEmptyString(input.cost_status, "async_job.cost_status");
  if (!MINIMAX_COST_STATUS_SET.has(costStatus)) {
    throw new CapabilitySnapshotContractError("ERR_COST_STATUS_UNKNOWN", {
      where: "async_job.cost_status",
      value: costStatus,
    });
  }
  if (input.redacted !== true) {
    throw new CapabilitySnapshotContractError("ERR_ASYNC_JOB_NOT_REDACTED", {
      where: "async_job.redacted",
      value: input.redacted,
    });
  }
  return deepFreeze({
    schema_version: MINIMAX_ASYNC_JOB_SCHEMA_VERSION,
    job_id: jobId,
    resource,
    status,
    submitted_at: submittedAt,
    last_observed_at: lastObservedAt,
    output_refs: outputRefs,
    cost_status: costStatus,
    redacted: true,
  });
}

// ─── Deprecated-for-this-Mission auth helpers (kept for future authorization) ─
// `redactAuthStatus` and `classifyAuthState` are intentionally DISABLED for this
// Mission (ARI P-005 §2). Any invocation throws ERR_AUTH_READINESS_DISABLED until
// a separate authorization record flips AUTH_READINESS_ENABLED. The pure-function
// implementations remain below as a comment for the future re-enable path.
function isAuthReadinessEnabled() {
  return AUTH_READINESS_ENABLED === true;
}

function redactAuthStatus(_stdout) {
  throw new CapabilitySnapshotContractError("ERR_AUTH_READINESS_DISABLED", {
    where: "redactAuthStatus",
    note: "auth readiness disabled for this Mission; redactAuthStatus cannot be invoked. See ARI P-005 §2.",
  });
}

function classifyAuthState(_parsed) {
  throw new CapabilitySnapshotContractError("ERR_AUTH_READINESS_DISABLED", {
    where: "classifyAuthState",
    note: "auth readiness disabled for this Mission; classifyAuthState cannot be invoked. See ARI P-005 §2.",
  });
}

// Deterministic canonical hash for snapshot — used as `resource_digest` in
// the Operation lifecycle. JSON.stringify with sorted keys.
function stableSnapshotHash(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new CapabilitySnapshotContractError("ERR_SNAPSHOT_NOT_OBJECT", { where: "stableSnapshotHash" });
  }
  return require("node:crypto")
    .createHash("sha256")
    .update(canonicalize(snapshot))
    .digest("hex");
}

function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }
  return "null";
}

module.exports = {
  MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
  MINIMAX_ASYNC_JOB_SCHEMA_VERSION,
  MINIMAX_AUTH_STATES,           // enforced vocabulary for this Mission: ["unknown"]
  MINIMAX_AUTH_STATES_FULL,      // full vocabulary for future authorization: ["ready","blocked","unknown"]
  AUTH_READINESS_ENABLED,        // false; future authorization flips this
  AUTH_READINESS_DISABLED_REASON,
  MINIMAX_RESOURCES,
  MINIMAX_ASYNC_RESOURCES,
  MINIMAX_ASYNC_JOB_STATUSES,
  MINIMAX_OUTPUT_REF_KINDS,
  MINIMAX_COST_STATUSES,
  MINIMAX_PROBE_FAMILIES,        // exactly 3 families
  CAPABILITY_LEVELS,
  CAPABILITY_SOURCES,
  TAINT_PATTERNS,
  SECRET_FIELDS,
  CapabilitySnapshotContractError,
  isAuthReadinessEnabled,        // returns false in this Mission
  classifyAuthState,             // throws ERR_AUTH_READINESS_DISABLED in this Mission
  redactAuthStatus,              // throws ERR_AUTH_READINESS_DISABLED in this Mission
  validateAsyncJobDescriptor,
  validateCapabilitySnapshot,
  validateProbeFamilies,
  stableSnapshotHash,
  canonicalize,
};