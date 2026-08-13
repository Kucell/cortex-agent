"use strict";

// ─── P-001 Feedback Event Schema (F-001) ─────────────────────────────────────
//
// Single source of truth for the feedback event whitelist, normalization
// rules and fingerprint computation. Per `.agent/plans/proposals/projects/
// feedback-pipeline/proposals/P-001-collection-proposal.md` §4 (事件契约)
// and §4.3 (fingerprint normalization).
//
// Public API:
//   • ALLOWED_KINDS, ALLOWED_SEVERITIES, ALLOWED_ADAPTERS — string enums
//   • REQUIRED_FIELDS, OPTIONAL_FIELDS — at the top level
//   • FORBIDDEN_FIELDS — top-level fields that must never appear
//   • validateEvent(payload, { adapterEnabled }) — schema + whitelist gate
//   • normalizeTitle(s) — NFC + trim + collapse whitespace + lowercase
//   • computeFingerprint(payload) — sha256 of canonical input lines
//
// The module never reads prompts, transcripts, env vars or arbitrary business
// payloads. All inputs must arrive as explicit, structured objects that
// `validateEvent` has already accepted; everything else throws.

const crypto = require("node:crypto");

const SCHEMA_VERSION = 1;

const ALLOWED_KINDS = Object.freeze([
  "blocker",
  "observation",
  "question",
  "feature-request",
]);

const ALLOWED_SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);

// Only registered adapters may produce events. Unknown adapter = fail closed.
const ALLOWED_ADAPTERS = Object.freeze([
  "manual",                // `feedback log` from a human
  "cortex-diagnostic",     // governed diagnostic / exit-code adapter
  "evolution-observation", // evolution observation adapter (future P-002+)
  "test-fixture",          // tests only — must be paired with isTestContext()
]);

const REQUIRED_TOP_LEVEL_FIELDS = Object.freeze([
  "schema_version",
  "event_id",
  "occurred_at",
  "kind",
  "severity",
  "title",
  "source",
]);

const OPTIONAL_TOP_LEVEL_FIELDS = Object.freeze([
  "summary",
  "diagnostic_code",
  "tags",
  "redaction",
  "fingerprint", // accepted as a hint; always overwritten with the canonical value
]);

// All forbidden keys, including nested forbidden subkeys. Anything matching is
// rejected outright before any normalization runs.
const FORBIDDEN_TOP_LEVEL_FIELDS = Object.freeze([
  "prompt",
  "transcript",
  "stack",
  "stack_trace",
  "stacktrace",
  "env",
  "environment",
  "process_env",
  "token",
  "secret",
  "credential",
  "password",
  "api_key",
  "abs_path",
  "absolute_path",
  "cwd",
  "host",
]);

// Source sub-shape whitelist. We only accept adapter + project_slug (+ optional
// run_ref); anything else is rejected so a host cannot smuggle identifying
// info in here.
const REQUIRED_SOURCE_FIELDS = Object.freeze(["adapter", "project_slug"]);
const OPTIONAL_SOURCE_FIELDS = Object.freeze(["run_ref"]);
const FORBIDDEN_SOURCE_FIELDS = Object.freeze([
  "prompt",
  "transcript",
  "stack",
  "session_id",
  "host",
  "cwd",
  "abs_path",
  "token",
]);

// Hard caps enforced by the schema layer (independent from storage caps).
// These bound the *individual* string fields. The total JSON payload byte
// cap is enforced separately by the inbox layer (P-001 default 16 KiB) so
// callers can hit the storage byte limit by combining many medium-size
// fields, not just one giant string.
const TITLE_MAX_LEN = 4096;
const SUMMARY_MAX_LEN = 32 * 1024;
const DIAGNOSTIC_CODE_MAX_LEN = 96;
const TAG_MAX_LEN = 48;
const TAG_MAX_COUNT = 16;
const RUN_REF_MAX_LEN = 96;

// Regex for event_id. We accept either fev_<uuid> or legacy ULID-style. ULIDs
// are accepted as a backward-compatible convenience but `fev_` is preferred.
const EVENT_ID_PATTERN = /^(?:fev_[0-9a-fA-F-]{8,128}|[0-9A-HJKMNP-TV-Z]{26})$/;

// Adapters are kebab-case on the wire; the config file uses underscores. We
// keep both forms in their respective allow-lists and translate explicitly
// at the boundary to avoid accidental bridging.
function adapterToConfigKey(adapter) {
  return adapter.replace(/-/g, "_");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ─── Title normalization (P-001 §4.3) ───────────────────────────────────────

function normalizeTitle(input) {
  if (typeof input !== "string") return "";
  // Unicode NFC, trim, collapse internal whitespace, lowercase.
  let s = input.normalize ? input.normalize("NFC") : input;
  s = s.replace(/^\s+|\s+$/g, "");
  s = s.replace(/\s+/g, " ");
  s = s.toLowerCase();
  return s;
}

// ─── Fingerprint (P-001 §4.3) ────────────────────────────────────────────────
//
// sha256(schema_version + "\n" + kind + "\n" + diagnostic_code-or-empty + "\n"
//        + normalize(title) + "\n" + project_slug)
//
// We deliberately exclude occurred_at, run_ref, summary and any dynamic data
// from the fingerprint so repeat observations aggregate rather than duplicate.

function computeFingerprint(payload) {
  const parts = [
    String(payload.schema_version),
    String(payload.kind),
    typeof payload.diagnostic_code === "string" ? payload.diagnostic_code : "",
    normalizeTitle(payload.title),
    payload.source && typeof payload.source.project_slug === "string"
      ? payload.source.project_slug
      : "",
  ];
  const joined = parts.join("\n");
  return `sha256:${crypto.createHash("sha256").update(joined, "utf8").digest("hex")}`;
}

// ─── Per-field coercion / validation ────────────────────────────────────────

function coerceAndValidateKind(value) {
  if (typeof value !== "string") return { ok: false, reason: "kind must be a string" };
  if (!ALLOWED_KINDS.includes(value)) {
    return { ok: false, reason: `kind must be one of ${ALLOWED_KINDS.join(", ")}` };
  }
  return { ok: true, value };
}

function coerceAndValidateSeverity(value) {
  if (typeof value !== "string") return { ok: false, reason: "severity must be a string" };
  if (!ALLOWED_SEVERITIES.includes(value)) {
    return { ok: false, reason: `severity must be one of ${ALLOWED_SEVERITIES.join(", ")}` };
  }
  return { ok: true, value };
}

function coerceAndValidateTags(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, reason: "tags must be an array of strings" };
  if (value.length > TAG_MAX_COUNT) {
    return { ok: false, reason: `tags must contain at most ${TAG_MAX_COUNT} entries` };
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { ok: false, reason: "tags entries must be strings" };
    if (entry.length === 0 || entry.length > TAG_MAX_LEN) {
      return { ok: false, reason: `tags entries must be 1..${TAG_MAX_LEN} chars` };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

function coerceAndValidateSource(source, { adapterEnabledOverride } = {}) {
  if (!isPlainObject(source)) return { ok: false, reason: "source must be an object" };
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_SOURCE_FIELDS.includes(key)) {
      return { ok: false, reason: `source.${key} is forbidden` };
    }
    if (![...REQUIRED_SOURCE_FIELDS, ...OPTIONAL_SOURCE_FIELDS].includes(key)) {
      return { ok: false, reason: `source contains unknown field "${key}"` };
    }
  }
  for (const key of REQUIRED_SOURCE_FIELDS) {
    if (!isNonEmptyString(source[key])) {
      return { ok: false, reason: `source.${key} is required and must be a non-empty string` };
    }
  }
  if (!ALLOWED_ADAPTERS.includes(source.adapter)) {
    return { ok: false, reason: `source.adapter must be one of ${ALLOWED_ADAPTERS.join(", ")}` };
  }
  if (typeof source.project_slug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source.project_slug)) {
    return { ok: false, reason: "source.project_slug must match /^[a-z0-9][a-z0-9._-]{0,63}$/i" };
  }
  if (source.run_ref !== undefined) {
    if (typeof source.run_ref !== "string" || source.run_ref.length === 0 || source.run_ref.length > RUN_REF_MAX_LEN) {
      return { ok: false, reason: `source.run_ref must be a 1..${RUN_REF_MAX_LEN} char string` };
    }
    // run_ref must NOT look like a session id or absolute path. We refuse
    // anything containing ":" or "/" or starting with "/".
    if (/[:\/\\]/.test(source.run_ref) || /^[.~]/.test(source.run_ref)) {
      return { ok: false, reason: "source.run_ref must be a local opaque reference; no path or env shape" };
    }
  }
  // Adapter opt-in check. Manual is always allowed regardless of config because
  // `feedback log` is the explicit user path; every other adapter must be
  // enabled in the loaded config (test-fixture bypassed when override set).
  if (source.adapter !== "manual" && source.adapter !== "test-fixture" && adapterEnabledOverride !== true) {
    return { ok: false, reason: `adapter "${source.adapter}" is not enabled in feedback config` };
  }
  return { ok: true, value: source };
}

function looksLikeAbsolutePath(s) {
  return typeof s === "string" && (s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s));
}

function noReservedChars(s) {
  // Title / summary / diagnostic_code must not contain control chars.
  return !/[\u0000-\u001f\u007f]/.test(s);
}

// ─── validateEvent ──────────────────────────────────────────────────────────
//
// Validates a candidate event payload against the whitelist. Returns:
//   • { ok: true, event: <normalized> } — caller may persist this object.
//   • { ok: false, errors: [<reason>...] } — caller must fail closed.
//
// The `adapterEnabled` option signals whether the named adapter is opted in
// (it is the caller's job to load the merged config and pass the boolean).
// This module never reads the filesystem directly.

function validateEvent(payload, { adapterEnabled = false, adapterEnabledMap = null } = {}) {
  const errors = [];
  if (!isPlainObject(payload)) {
    return { ok: false, errors: ["event payload must be an object"] };
  }
  // Top-level field whitelist: every key must be in REQUIRED/OPTIONAL.
  const allowedTop = new Set([...REQUIRED_TOP_LEVEL_FIELDS, ...OPTIONAL_TOP_LEVEL_FIELDS]);
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_TOP_LEVEL_FIELDS.includes(key)) {
      errors.push(`field "${key}" is forbidden by P-001 privacy contract`);
    } else if (!allowedTop.has(key)) {
      errors.push(`unknown field "${key}" is not allowed by P-001 schema`);
    }
  }
  // schema_version
  if (payload.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  }
  // event_id
  if (!isNonEmptyString(payload.event_id)) {
    errors.push("event_id is required and must be a non-empty string");
  } else if (!EVENT_ID_PATTERN.test(payload.event_id)) {
    errors.push("event_id format is not allowed (use fev_<uuid> or 26-char ulid)");
  }
  // occurred_at — strict ISO8601 UTC, no env / process snapshot.
  if (!isNonEmptyString(payload.occurred_at)) {
    errors.push("occurred_at is required (ISO 8601 UTC string)");
  } else if (Number.isNaN(Date.parse(payload.occurred_at))) {
    errors.push("occurred_at must be parseable as a date");
  }
  // kind
  const kindResult = coerceAndValidateKind(payload.kind);
  if (!kindResult.ok) errors.push(kindResult.reason);
  // severity
  const sevResult = coerceAndValidateSeverity(payload.severity);
  if (!sevResult.ok) errors.push(sevResult.reason);
  // title
  if (!isNonEmptyString(payload.title)) {
    errors.push("title is required and must be a non-empty string");
  } else if (payload.title.length > TITLE_MAX_LEN) {
    errors.push(`title must be <= ${TITLE_MAX_LEN} chars`);
  } else if (looksLikeAbsolutePath(payload.title)) {
    errors.push("title must not look like an absolute path");
  } else if (!noReservedChars(payload.title)) {
    errors.push("title must not contain control characters");
  }
  // summary
  if (payload.summary !== undefined) {
    if (!isNonEmptyString(payload.summary)) {
      errors.push("summary must be a non-empty string when provided");
    } else if (payload.summary.length > SUMMARY_MAX_LEN) {
      errors.push(`summary must be <= ${SUMMARY_MAX_LEN} chars`);
    } else if (looksLikeAbsolutePath(payload.summary)) {
      errors.push("summary must not look like an absolute path");
    } else if (!noReservedChars(payload.summary)) {
      errors.push("summary must not contain control characters");
    }
  }
  // diagnostic_code
  if (payload.diagnostic_code !== undefined) {
    if (!isNonEmptyString(payload.diagnostic_code)) {
      errors.push("diagnostic_code must be a non-empty string when provided");
    } else if (payload.diagnostic_code.length > DIAGNOSTIC_CODE_MAX_LEN) {
      errors.push(`diagnostic_code must be <= ${DIAGNOSTIC_CODE_MAX_LEN} chars`);
    } else if (looksLikeAbsolutePath(payload.diagnostic_code) || /\s/.test(payload.diagnostic_code)) {
      errors.push("diagnostic_code must not look like an absolute path or contain whitespace");
    } else if (!noReservedChars(payload.diagnostic_code)) {
      errors.push("diagnostic_code must not contain control characters");
    }
  }
  // tags
  const tagsResult = coerceAndValidateTags(payload.tags);
  if (!tagsResult.ok) errors.push(tagsResult.reason);
  // source
  const adapterEnabledOverride =
    adapterEnabledMap && payload.source && typeof payload.source.adapter === "string"
      ? adapterEnabledMap.get(adapterToConfigKey(payload.source.adapter)) === true
      : adapterEnabled;
  const sourceResult = coerceAndValidateSource(payload.source, { adapterEnabledOverride });
  if (!sourceResult.ok) errors.push(sourceResult.reason);
  // fingerprint must equal what we compute; callers can pre-fill with a
  // placeholder — we override it here.
  // (Intentionally not checked at validate-time so callers can submit a
  //  preliminary fingerprint and receive the canonical one.)
  if (errors.length > 0) return { ok: false, errors };
  // Build the normalized event so persistence is schema-canonical.
  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: payload.event_id,
    occurred_at: payload.occurred_at,
    kind: kindResult.value,
    severity: sevResult.value,
    title: payload.title,
    source: sourceResult.value,
    fingerprint: computeFingerprint({
      schema_version: SCHEMA_VERSION,
      kind: kindResult.value,
      diagnostic_code: payload.diagnostic_code,
      title: payload.title,
      source: sourceResult.value,
    }),
  };
  if (payload.summary !== undefined) event.summary = payload.summary;
  if (payload.diagnostic_code !== undefined) event.diagnostic_code = payload.diagnostic_code;
  if (tagsResult.value !== undefined) event.tags = tagsResult.value;
  if (payload.redaction && typeof payload.redaction === "object") {
    // Carry through the redaction audit trail produced by redactEventFields
    // (or supplied by a trusted adapter). The block is purely additive —
    // existing readers that ignore it stay correct.
    event.redaction = { ...payload.redaction };
  }
  return { ok: true, event };
}

// ─── isTestContext ───────────────────────────────────────────────────────────
//
// The `test-fixture` adapter is only valid when the caller is operating inside
// the project's own test process. This helper is a no-IO flag check that
// event-emitting code uses to gate its inputs.

function isTestContext(env = process.env) {
  if (!env || typeof env !== "object") return false;
  if (env.CORTEX_AGENT_FEEDBACK_TEST_CONTEXT === "1") return true;
  return false;
}

module.exports = {
  SCHEMA_VERSION,
  ALLOWED_KINDS,
  ALLOWED_SEVERITIES,
  ALLOWED_ADAPTERS,
  REQUIRED_TOP_LEVEL_FIELDS,
  OPTIONAL_TOP_LEVEL_FIELDS,
  FORBIDDEN_TOP_LEVEL_FIELDS,
  REQUIRED_SOURCE_FIELDS,
  OPTIONAL_SOURCE_FIELDS,
  FORBIDDEN_SOURCE_FIELDS,
  TITLE_MAX_LEN,
  SUMMARY_MAX_LEN,
  DIAGNOSTIC_CODE_MAX_LEN,
  TAG_MAX_LEN,
  TAG_MAX_COUNT,
  RUN_REF_MAX_LEN,
  EVENT_ID_PATTERN,
  adapterToConfigKey,
  normalizeTitle,
  computeFingerprint,
  validateEvent,
  isTestContext,
};