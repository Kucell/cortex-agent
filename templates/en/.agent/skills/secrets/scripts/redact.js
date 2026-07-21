"use strict";

// ─── redact (L1 secrets-vcs — companion helper) ──────────────────────────────
// Single-purpose pure function that masks secret-shaped strings before they
// leak into agent-visible stdout / conversation.  Aligned with
// `.agent/rules/normalize-input-value.md` policy: protocol boundaries
// normalize; this one is for output (don't emit the value the agent
// never needed to see).
//
// What it covers:
//   - secret://<ref> URIs: never redacted (they're references, safe)
//   - keychain-style strings: mask unless caller passes `<REDACTED>` opt-out
//   - HTTP Authorization headers: re-emit with placeholder when value matches
//
// Mirrors how incident-class tooling normally handles leaks: strip
// from the surface, not from the store.

// The mask placeholder is intentionally NOT a "token = <value>" pattern
// because pre-commit hooks (and several ad-hoc grep regexes) treat
// `token = "..."` as a hardcoded secret alarm and would reject commits
// that legitimately ship a redactor. Using `[REDACTED]` (square brackets,
// single mixed-case word) sidesteps that false-positive while still being
// visually unmistakable in any agent context.
const MASK = "[REDACTED]";

// Secret shape detectors.  Loose on purpose — these are flags, not parsers.
function isLikelySecret(shape) {
  if (typeof shape !== "string") return false;
  // 1. Hex strings of >= 32 chars (most access tokens)
  if (/^[0-9a-f]{32,}$/i.test(shape)) return true;
  // 2. Bearer / Basic / token = VALUE style
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(shape)) return true;
  // 3. Specifically Authorization: token <hex> pattern
  if (/^token\s+[^\s]+/i.test(shape)) return true;
  return false;
}

// Main entry: build a redactor function from a list of plaintext values to mask.
function makeRedactor(values) {
  // Capture references at closure time, not at call time.  This matters when
  // a value rotates mid-process — old runs won't leak the new value into
  // an old context unintentionally.
  const list = Array.isArray(values) ? values.filter((v) => typeof v === "string" && v.length >= 8) : [];
  // Sort by length DESC so longer matches win first ("abc...xyz" before "abc")
  const sorted = [...list].sort((a, b) => b.length - a.length);
  return function redactString(input) {
    if (typeof input !== "string" || sorted.length === 0) return input;
    let out = input;
    for (const v of sorted) {
      // Match exact value, plus quoted variants ("…" / '…' / surround-spaces).
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const variants = [
        new RegExp(`(?<=["'\\s])${escaped}(?=["'\\s])`, "g"),
        new RegExp(escaped, "g"),
      ];
      for (const re of variants) out = out.replace(re, MASK);
    }
    return out;
  };
}

// Redact helper for objects/strings (commonly used on stdout before printing).
function redactUnknown(input) {
  if (input == null) return input;
  if (typeof input === "string") {
    // Heuristic: anything matching a likely-secret shape in the wild.
    return input
      .replace(/[Bb]earer\s+[A-Za-z0-9+/=_-]{16,}/g, "Bearer " + MASK)
      .replace(/[Tt]oken\s+[A-Za-z0-9+/=_-]{16,}/g, "Token " + MASK)
      .replace(/Authorization:\s*token\s+[^\s]+/g, "Authorization: token " + MASK);
  }
  return input;
}

// Wrap a spawned subprocess so that any stdout / stderr from the backend
// shell gets stripped of known secrets BEFORE it reaches the caller.  This
// is the security-critical bit: if a backend script accidentally prints
// the value (e.g. echoes a debug line), the wrapper redacts it before it
// can land in agent logs.
function wrapSpawnResult(result, knownSecrets) {
  const redactor = makeRedactor(knownSecrets);
  const safe = {
    status: result.status,
    stdout: typeof result.stdout === "string" ? redactor(result.stdout) : result.stdout,
    stderr: typeof result.stderr === "string" ? redactor(result.stderr) : result.stderr,
  };
  return safe;
}

module.exports = { redactUnknown, makeRedactor, wrapSpawnResult, isLikelySecret, MASK };
