"use strict";

// ─── Claude Hook Redaction (T-ACN-017) ──────────────────────────────────────
// Sensitive field patterns, evidence allowlist, test signal detection, and
// payload redaction. Separated from the adapter per project standards.
//
// Zero external dependencies — Node.js built-ins only.

const { scanContent } = require("../security/scan");

// ─── Sensitive field patterns ───────────────────────────────────────────────
//
// These patterns identify fields in hook payloads that MUST be redacted before
// forwarding to the coordination machine.

const SENSITIVE_FIELD_PATTERNS = [
  // Session identifiers
  { pattern: /session/i, redact: true },
  // Prompt content
  { pattern: /prompt/i, redact: true },
  // Command content
  { pattern: /^command$/i, redact: true },
  // File paths (absolute paths)
  { pattern: /^cwd$/i, redact: true },
  { pattern: /^pwd$/i, redact: true },
  // Tool payload
  { pattern: /^payload$/i, redact: true },
  { pattern: /^arguments$/i, redact: true },
  { pattern: /^input$/i, redact: true },
  { pattern: /^output$/i, redact: true },
  // Credentials
  { pattern: /token/i, redact: true },
  { pattern: /password/i, redact: true },
  { pattern: /secret/i, redact: true },
  { pattern: /credential/i, redact: true },
  { pattern: /api[_-]?key/i, redact: true },
  { pattern: /authorization/i, redact: true },
];

// ─── Evidence allowlist ─────────────────────────────────────────────────────
//
// Only evidence refs matching these patterns are allowed through ReadyForReview.

const EVIDENCE_REF_ALLOWED = [
  /^ARTIFACT-[A-Za-z0-9._-]+$/,
  /^RUN-[A-Za-z0-9._-]+$/,
  /^VC-[A-Za-z0-9._-]+$/,
  /^DEC-[A-Za-z0-9._-]+$/,
  /^\.\//,
  /^tests\//,
  /^docs\//,
  /^lib\//,
  /^src\//,
];

// ─── Test signal patterns ───────────────────────────────────────────────────

const TEST_SIGNAL_PATTERNS = [
  /\btest/i,
  /\btesting\b/i,
  /^vitest\b/,
  /^jest\b/,
  /^mocha\b/,
  /^ava\b/,
  /^node --test\b/,
  /npx jest/,
  /npx vitest/,
  /npm test/,
  /npm run test/,
  /yarn test/,
  /pnpm test/,
];

// ─── Redact hook payload ────────────────────────────────────────────────────
//
// Returns a new object with sensitive fields replaced by "[REDACTED]".

function redactHookPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(redactHookPayload);

  const redacted = {};
  for (const [key, value] of Object.entries(payload)) {
    const isSensitive = SENSITIVE_FIELD_PATTERNS.some((p) => p.pattern.test(key));
    if (isSensitive) {
      redacted[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "object" && value !== null) {
      redacted[key] = redactHookPayload(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

// ─── Secret scan on hook payload ───────────────────────────────────────────

function hookPayloadHasSecrets(payload) {
  const serialized = JSON.stringify(payload);
  const findings = scanContent(serialized);
  return findings.length > 0;
}

// ─── Detect test signal ─────────────────────────────────────────────────────

function detectTestSignal(payload) {
  if (!payload || typeof payload !== "object") return false;

  const toolName = payload.toolName || payload.tool || "";
  const result = payload.result || "";
  const command = payload.command || "";

  const searchText = [toolName, result, command].filter(Boolean).join(" ");
  return TEST_SIGNAL_PATTERNS.some((p) => p.test(searchText));
}

// ─── Validate evidence refs ────────────────────────────────────────────────

function validateEvidenceRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.filter((ref) => {
    if (!ref || typeof ref !== "string") return false;
    return EVIDENCE_REF_ALLOWED.some((p) => p.test(ref));
  });
}

module.exports = {
  SENSITIVE_FIELD_PATTERNS,
  EVIDENCE_REF_ALLOWED,
  TEST_SIGNAL_PATTERNS,
  redactHookPayload,
  hookPayloadHasSecrets,
  detectTestSignal,
  validateEvidenceRefs,
};