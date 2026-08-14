#!/usr/bin/env node
"use strict";

// ─── capture-usage (M-025/MS-003 collection entry) ────────────────────────────
// Zero-dependency stdin-to-ledger capture for Host usage envelopes.
//
// Accepts one already-sanitized public usage envelope as JSON on stdin:
//   {
//     "host": "codex",                    // required
//     "attempt_id": "...",                // required
//     "model": "qwen3.8-max",             // optional
//     "task_id": "...", "run_id": "...", "session_id": "...",  // optional quality IDs
//     "usage": {                          // public usage numbers
//       "input_tokens": 0,
//       "output_tokens": 0,
//       "cache_creation_input_tokens": 0,
//       "cache_read_input_tokens": 0
//     },
//     "recorded_at": "ISO-8601"           // optional
//   }
//
// The envelope must already be sanitized: no prompt, response, tool payload,
// source body, credential or private path. This script never reads Host private
// storage; it only writes receipts through the MS-001 contract and ledger.
//
// Usage:
//   cat envelope.json | node scripts/capture-usage.js [--dry-run]
//   echo '{...}' | node scripts/capture-usage.js --dry-run
//
// Test-prefixed attempt IDs are excluded (matching Phase B VC-016 semantics) and
// reported as excluded; they do not count toward the sample gate.

const fs = require("node:fs");
const path = require("node:path");

const ledger = require("../templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js");

const TEST_ATTEMPT_PREFIXES = Object.freeze([
  "test-",
  "mock-",
  "fake-",
  "dummy-",
  "unit-test-",
  "integration-test-",
  "e2e-test-",
]);

const TEST_HOST_PATTERNS = Object.freeze([
  /^test/i,
  /^mock/i,
  /^fake/i,
  /^dummy/i,
  /unit[-_]?test/i,
  /integration[-_]?test/i,
  /e2e[-_]?test/i,
]);

function readStdin() {
  const chunks = [];
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", reject);
  });
}

function isTestAttempt(attemptId) {
  return typeof attemptId === "string" && TEST_ATTEMPT_PREFIXES.some((prefix) => attemptId.startsWith(prefix));
}

function isTestHost(host) {
  return typeof host === "string" && TEST_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function pickUsage(raw) {
  if (!raw || typeof raw !== "object") return {};
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
  const out = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]) {
    if (Object.prototype.hasOwnProperty.call(usage, key)) out[key] = usage[key];
  }
  return out;
}

function projectRoot() {
  const explicit = process.env.CORTEX_PROJECT_ROOT;
  if (explicit && path.isAbsolute(explicit)) return explicit;
  return path.resolve(__dirname, "..");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rawText = (await readStdin()).trim();
  if (!rawText) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "empty_stdin", reason: "No envelope JSON provided on stdin" }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse(rawText);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid_json", reason: error.message }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const attemptId = typeof envelope.attempt_id === "string" ? envelope.attempt_id : "";
  const host = typeof envelope.host === "string" ? envelope.host : "";
  if (!attemptId) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "attempt_id_required", reason: "attempt_id is required" }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  if (!host) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "host_required", reason: "host is required" }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const exclusion = isTestHost(host)
    ? "test_host"
    : isTestAttempt(attemptId)
      ? "test_attempt"
      : null;
  if (exclusion) {
    process.stdout.write(`${JSON.stringify({ ok: false, excluded: true, exclusion_reason: exclusion, attempt_id: attemptId, host }, null, 2)}\n`);
    return;
  }

  const usage = pickUsage(envelope);
  const hasUsage = Object.keys(usage).length > 0;
  if (!hasUsage) {
    process.stdout.write(`${JSON.stringify({ ok: false, excluded: true, exclusion_reason: "no_usage", attempt_id: attemptId, host }, null, 2)}\n`);
    return;
  }

  const root = projectRoot();
  const ledgerDir = path.join(root, ".agent", "token-attempts");

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dry_run: true,
      attempt_id: attemptId,
      host,
      model: envelope.model || null,
      usage,
      ledger_dir: ledgerDir,
      note: "Envelope is valid; no receipt written (--dry-run).",
    }, null, 2)}\n`);
    return;
  }

  const result = ledger.submitTokenUsage(
    ledgerDir,
    attemptId,
    host,
    usage,
    {
      model: envelope.model || null,
      run_id: envelope.run_id || null,
      task_id: envelope.task_id || null,
      session_id: envelope.session_id || null,
      status: envelope.status || "host_reported",
    },
  );

  if (!result.ok && !result.isDuplicate) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: result.error, reason: result.reason || null, attempt_id: attemptId }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    duplicate: Boolean(result.isDuplicate),
    attempt_id: attemptId,
    host,
    receipt: result.entry ? result.entry.receipt : null,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: "capture_failed", reason: error.message })}\n`);
  process.exitCode = 1;
});
