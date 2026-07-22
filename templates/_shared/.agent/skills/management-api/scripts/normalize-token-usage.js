"use strict";

// ─── normalize-token-usage (L1 management-api — protocol sink helper) ──────────
// Single-purpose pure function that coerces agent-host-reported token usage into
// the canonical numeric shape stored under `runs/<run_id>.json#token_usage`.
//
// Why a dedicated normalizer (rather than inline `Number(v) || 0` in
// `management-api`): every host that reports tokens (Claude Code, Cursor,
// Codex, ...) sends the same logical fields but with disagreeing shapes —
// numbers, numeric strings, thousand-separated strings ("1,234"), dirty
// strings produced by upstream stringification ("7,29000000"), booleans,
// null-ish sentinels. A single sink normalizer (see
// `.agent/rules/normalize-input-value.md` §强制规则) collapses these into
// integers BEFORE they reach `runs/<run_id>.json`. Downstream consumers
// (`agent-dashboard`, future analytics) get guaranteed integers or zero.
//
// Design rules (per `normalize-input-value.md` §2):
//   - No `Number(v) || 0` (drops legitimate 0).
//   - No `Number.isNaN(+v) ? 0 : +v` (locks dirty strings to 0 silently).
//   - No `parseInt(v) || 0` / `+v | 0`.
//   - The only place these conversions happen is inside this helper.

const KEY_NAMES = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

// Treat 0 as a legitimate measurement — never fold it to 0 via `||` fallbacks.
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Thousand-separated numeric strings ("1,234", "1,234,567") → Number.
// Strings that look like comma-joined fragments from upstream stringification
// ("7,29000000" — two numbers mashed together by .toString()) MUST NOT be
// parsed as thousand-separation; we reject any numeric string containing a
// comma that is NOT a clean thousands pattern (groups of 3 digits).
function parseNumericString(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const thousandsPattern = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
  if (thousandsPattern.test(trimmed)) {
    const num = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(num) ? num : null;
  }
  // Reject anything else that contains a comma — defends against the
  // array.toString() / object.toString() / concatenated-fields pattern.
  if (trimmed.includes(",")) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

// Coerce a single, possibly messy, value to a non-negative integer token count.
// Returns 0 when no positive interpretation exists — but never via `||` collapse
// that would mask legitimate zero.
function coerceToNonNegativeInt(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (isFiniteNumber(value)) {
    // Negative values are nonsensical; snap to 0 rather than propagate.
    return value < 0 ? 0 : Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = parseNumericString(value);
    if (parsed === null) return 0;
    return parsed < 0 ? 0 : Math.trunc(parsed);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const coerced = coerceToNonNegativeInt(item);
      if (coerced !== 0) return coerced;
    }
    return 0;
  }
  if (typeof value === "object") {
    // Try the canonical keys first; fall back to first numeric-looking child.
    for (const key of KEY_NAMES) {
      if (key in value) {
        const coerced = coerceToNonNegativeInt(value[key]);
        if (coerced !== 0) return coerced;
      }
    }
    for (const child of Object.values(value)) {
      const coerced = coerceToNonNegativeInt(child);
      if (coerced !== 0) return coerced;
    }
    return 0;
  }
  return 0;
}

// Public API: given an arbitrary raw input (agent-host payload, partial payload,
// legacy string-encoded value, ...), return the canonical token-usage shape.
//
// Always returns integers >= 0 for every field. Missing fields → 0. Extra
// fields are ignored. `samples` always reflects 1 (this report counts as one
// observation); aggregators are responsible for summing samples across calls.
function normalizeTokenUsage(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const result = { samples: 1 };
  for (const key of KEY_NAMES) {
    result[key] = coerceToNonNegativeInt(source[key]);
  }
  return result;
}

module.exports = { normalizeTokenUsage, coerceToNonNegativeInt, parseNumericString };
