#!/usr/bin/env node
"use strict";

// Codex-only P-002 Shadow Pilot. Accepts explicitly sanitized admission metadata
// and emits an in-memory projection summary. It never alters Codex context or
// writes receipts, prompts, source bodies, or policy state.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MINIMAL_CONTEXT = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "minimal-context.js");
const FORBIDDEN_FIELDS = new Set(["prompt", "response", "transcript", "messages", "tool_args", "tool_result", "source", "source_body", "credentials", "private_path"]);
const ALLOWED_FIELDS = new Set(["attempt_id", "task_id", "run_id", "model", "recorded_at", "task_terms", "changed_files", "token_budget"]);
const TERM_PATTERN = /^[\p{L}\p{N}_.:/-]{1,64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;
const RELATIVE_PATH_PATTERN = /^(?![\/])(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._@/+-]{1,240}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readIndexSnapshot(root = ROOT) {
  const indexPath = path.join(root, ".agent", "context-index.json");
  const raw = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : JSON.stringify({ _meta: {}, modules: [] });
  return { index: JSON.parse(raw), digest: sha256(raw) };
}

function readIndex(root = ROOT) {
  return readIndexSnapshot(root).index;
}

function validateAdmission(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "admission_object_required" };
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_FIELDS.has(key)) return { ok: false, error: "forbidden_field", field: key };
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, error: "unknown_field", field: key };
  }
  if (typeof input.attempt_id !== "string" || !input.attempt_id.startsWith("ocx-") || !IDENTIFIER_PATTERN.test(input.attempt_id)) return { ok: false, error: "codex_attempt_id_required" };
  for (const field of ["task_id", "run_id", "model"]) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || !IDENTIFIER_PATTERN.test(input[field]))) return { ok: false, error: "invalid_identifier", field };
  }
  if (input.recorded_at !== undefined && (typeof input.recorded_at !== "string" || Number.isNaN(Date.parse(input.recorded_at)))) return { ok: false, error: "invalid_recorded_at" };
  if (!Array.isArray(input.task_terms) || input.task_terms.length === 0 || input.task_terms.length > 40 || !input.task_terms.every((term) => typeof term === "string" && TERM_PATTERN.test(term))) return { ok: false, error: "invalid_task_terms" };
  if (input.changed_files !== undefined && (!Array.isArray(input.changed_files) || input.changed_files.length > 100 || !input.changed_files.every((file) => typeof file === "string" && RELATIVE_PATH_PATTERN.test(file)))) return { ok: false, error: "invalid_changed_files" };
  const tokenBudget = input.token_budget === undefined ? 300 : input.token_budget;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 50 || tokenBudget > 2000) return { ok: false, error: "invalid_token_budget" };
  return { ok: true };
}

function createShadowObservation(input, options = {}) {
  const validation = validateAdmission(input);
  if (!validation.ok) return validation;
  const minimal = options.minimalContext || require(MINIMAL_CONTEXT);
  const snapshot = options.index
    ? { index: options.index, digest: options.indexDigest || sha256(JSON.stringify(options.index)) }
    : readIndexSnapshot(options.root || ROOT);
  const taskTerms = input.task_terms.join(" ");
  const changedFiles = (input.changed_files || []).join(",");
  const tokenBudget = input.token_budget === undefined ? 300 : input.token_budget;
  const projection = minimal.projectMinimalContext(snapshot.index, taskTerms, changedFiles, tokenBudget, "minimal");
  const safeProjection = {
    revision: minimal.REVISION,
    context_index_digest: snapshot.digest,
    level: projection.level,
    estimated_tokens: projection.estimated_tokens,
    truncated: projection.truncated,
    omitted: projection.omitted,
    item_count: projection.items.length,
    fallback_used: projection.fallback_used,
    reason_codes: [...new Set(projection.items.map((item) => item.reason_code))].sort(),
  };
  return {
    ok: true,
    stage: "shadow",
    policy: "P-002",
    host: "codex",
    attempt_id: input.attempt_id,
    task_id: input.task_id || null,
    run_id: input.run_id || null,
    model: input.model || null,
    recorded_at: input.recorded_at || null,
    admission_digest: sha256(JSON.stringify({ task_terms: input.task_terms, changed_files: input.changed_files || [] })),
    projection: safeProjection,
    projection_digest: sha256(JSON.stringify(safeProjection)),
    side_effects: "none",
    persisted: false,
  };
}

function toPublicError() {
  return { ok: false, error: "pilot_failed" };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stdout.write(JSON.stringify({ ok: false, error: "empty_stdin" }) + "\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = createShadowObservation(JSON.parse(raw));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.ok ? 0 : 2;
  } catch (_) {
    process.stdout.write(JSON.stringify(toPublicError()) + "\n");
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { createShadowObservation, readIndex, readIndexSnapshot, toPublicError, validateAdmission };
