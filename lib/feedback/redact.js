"use strict";

// ─── P-001 Write-Before Redaction (F-003) ───────────────────────────────────
//
// Redacts PII / credential-like content from title, summary, tags and
// diagnostic_code BEFORE any value reaches the inbox file. Per
// `.agent/plans/proposals/projects/feedback-pipeline/proposals/P-001-collection-proposal.md`
// §8 (安全与隐私) #2.
//
// Public API:
//   • REDACTION_PATTERNS — built-in regex set (email, IPv4, IPv6, abs path,
//                          PEM blocks, common credential key=value, JWT)
//   • redactString(input, options?)  → { value, applied: [{name, count}] }
//   • redactEventFields(event)        → event clone with redacted strings
//
// The function NEVER mutates the input. Callers persist the returned object.

const { normalizeTitle } = require("./event-schema");

// ─── Built-in patterns ──────────────────────────────────────────────────────
//
// Order matters: earlier patterns run first. Counts are tallied per pattern
// so callers can report exactly which PII classes were scrubbed.
const REDACTION_PATTERNS = Object.freeze([
  {
    name: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: "[REDACTED:email]",
  },
  {
    name: "ipv4",
    // Match any 4 dotted octets (1..3 digits each). No word-boundary anchors
    // so embedded values like `AUTH_FAILED_10.0.0.5` are scrubbed.
    re: /(?:\d{1,3}\.){3}\d{1,3}/g,
    replacement: "[REDACTED:ipv4]",
  },
  {
    name: "ipv6",
    re: /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g,
    replacement: "[REDACTED:ipv6]",
  },
  {
    // Absolute path on POSIX or Windows. Run before credential pattern so a
    // /home/.../token=... path gets scrubbed as a path, not as a credential.
    name: "abs-path",
    re: /(?:[A-Za-z]:[\\/][^\s"']+|\/(?:home|root|Users|var|etc|opt|tmp|private|Volumes)[^\s"']*)/g,
    replacement: "[REDACTED:path]",
  },
  {
    // PEM-style block (begin ... end). Conservative: requires header line.
    name: "pem-block",
    re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    replacement: "[REDACTED:pem]",
  },
  {
    // Generic credential shape: key=value / key:value with common names.
    name: "credential-kv",
    re: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|pwd|token|auth(?:_token)?)\s*[:=]\s*[^\s,;"']+/gi,
    replacement: "[REDACTED:credential]",
  },
  {
    // JWT (three dot-separated base64url-ish segments).
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED:jwt]",
  },
]);

const SENSITIVE_FIELDS = Object.freeze(["title", "summary", "diagnostic_code"]);
const TAG_PATTERN = /^[A-Za-z0-9._:\- ]{1,48}$/;

// ─── redactString ──────────────────────────────────────────────────────────

function redactString(input, options = {}) {
  if (typeof input !== "string") return { value: input, applied: [] };
  const extraPatterns = Array.isArray(options.extraPatterns) ? options.extraPatterns : [];
  const patterns = [...REDACTION_PATTERNS, ...extraPatterns];
  let value = input;
  const applied = [];
  for (const pattern of patterns) {
    let count = 0;
    value = value.replace(pattern.re, (...args) => {
      count += 1;
      return typeof pattern.replacement === "function" ? pattern.replacement(...args) : pattern.replacement;
    });
    if (count > 0) applied.push({ name: pattern.name, count });
  }
  return { value, applied };
}

// ─── redactEventFields ─────────────────────────────────────────────────────
//
// Returns a NEW event object with sensitive fields redacted. The `redaction`
// audit block records which fields were touched and which patterns fired.
//
// Tags have a stricter policy: a tag that contains an email, an absolute
// path, a credential-shaped value or anything outside the safe alphabet
// (letters/digits/._:- and 1..48 chars) is either replaced wholesale or
// dropped. We choose to drop the offending tag and append a synthetic
// "[REDACTED:tag]" entry so downstream consumers can still see that
// something was filtered.

function isCleanTag(tag) {
  if (typeof tag !== "string") return false;
  if (!TAG_PATTERN.test(tag)) return false;
  if (tag.includes("@")) return false;
  if (/(?:\d{1,3}\.){3}\d{1,3}/.test(tag)) return false;
  return true;
}

function redactTags(tags, applied) {
  if (!Array.isArray(tags)) return { tags, dirty: false };
  const out = [];
  let dropped = 0;
  for (const entry of tags) {
    if (isCleanTag(entry)) {
      out.push(entry);
      continue;
    }
    dropped += 1;
  }
  if (dropped > 0) {
    applied.push({ name: "tag-violation", count: dropped });
    out.push("[REDACTED:tag]");
  }
  return { tags: out, dirty: dropped > 0 };
}

function redactEventFields(event) {
  if (!event || typeof event !== "object") {
    return { event, applied: [], dirty: false };
  }
  const applied = [];
  const next = { ...event };
  for (const field of SENSITIVE_FIELDS) {
    if (typeof next[field] === "string") {
      const { value, applied: fieldApplied } = redactString(next[field]);
      if (fieldApplied.length > 0) {
        applied.push(...fieldApplied.map((entry) => ({ ...entry, field })));
        next[field] = value;
      }
    }
  }
  if (Array.isArray(next.tags)) {
    const { tags, dirty } = redactTags(next.tags, applied);
    next.tags = tags;
    if (!dirty) {
      // no-op (dirty false, no synthetic append)
    }
  }
  // Normalize title to NFC for fingerprint stability.
  if (typeof next.title === "string") {
    next.title = normalizeTitle(next.title);
  }
  // Record the audit trail. P-001 always writes this when at least one
  // pattern fired; P-002+ can decide whether to always write it.
  const dirty = applied.length > 0;
  if (dirty) {
    next.redaction = {
      applied: true,
      fields: Array.from(new Set(applied.map((entry) => entry.field).filter(Boolean))),
      patterns: Array.from(new Set(applied.map((entry) => entry.name))),
      ...(event.redaction && typeof event.redaction === "object" ? event.redaction : {}),
    };
  }
  return { event: next, applied, dirty };
}

// ─── summarizeForReceipt ───────────────────────────────────────────────────
//
// Builds a short, non-sensitive summary suitable for CLI success output.
// Never echoes title or summary content — only counts and field names.

function summarizeForReceipt(applied) {
  if (!Array.isArray(applied) || applied.length === 0) return { redactionApplied: false };
  const counts = {};
  const fields = new Set();
  for (const entry of applied) {
    if (entry && entry.name) counts[entry.name] = (counts[entry.name] || 0) + (entry.count || 1);
    if (entry && entry.field) fields.add(entry.field);
  }
  return {
    redactionApplied: true,
    patterns: counts,
    fields: Array.from(fields),
  };
}

module.exports = {
  REDACTION_PATTERNS,
  redactString,
  redactEventFields,
  summarizeForReceipt,
};