#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// .agent/skills/agent-review-benchmark/scripts/reviewer-backend.js
// ---------------------------------------------------------------------------
// A reviewer backend turns raw review findings into a guided-review artifact.
//
// The contract is deliberately one-sided:
//
//   finding 的产出格式由 schema 固定，谁产出都行。
//
// The *proposal* may come from anywhere — the /code-review workflow, the
// code-reviewer sub-agent, an external reviewer shipped by the operator. The
// *enforcement* never leaves this file. A backend that only proposes findings
// cannot bypass the schema, because every finding is validated here before it
// reaches the artifact, and the artifact itself is validated before it is
// written.
//
// Two backends ship:
//   builtin  — reads a raw findings document and aggregates it. Zero deps.
//   external — loads an operator-supplied adapter module. The *interface* is
//              here on purpose; no adapter implementation is shipped, no
//              external reviewer is a dependency, and an adapter still cannot
//              skip validation. The adapter only proposes findings.
//
// Usage:
//   node .../reviewer-backend.js --backend builtin \
//     --input <raw-findings.json> --output <guided-review.json> \
//     [--workspace <dir>] [--now <iso8601>]
//
//   node .../reviewer-backend.js --backend external --adapter <module.cjs> \
//     --input <context.json> --output <guided-review.json> \
//     [--workspace <dir>] [--now <iso8601>]
//
// Deterministic: `generated_at` comes from the input envelope (or --now),
// never from the wall clock, so the same input always yields the same bytes.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { summarizeGroups } = require("./index.js");
const { formatErrors, validate } = require("./lib/json-schema.js");

const REFERENCES = path.resolve(__dirname, "..", "references");

const ENVELOPE_FIELDS = [
  "task_id",
  "run_id",
  "session_id",
  "workspace_ids",
  "base_revision",
  "head_revision",
  "changed_files",
];

function fail(error, details, code = 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, details })}\n`);
  process.exit(code);
}

// This CLI has no subcommand: every argument is a flag. The parser therefore
// starts at index 0 — treating argv[0] as a command would swallow `--backend`
// and silently fall back to the default backend.
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function readJson(file, label) {
  if (!file) fail(`${label}_required`, `Pass --${label.replace(/_/g, "-")}.`, 2);
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), "utf8");
  } catch (error) {
    fail(`${label}_unreadable`, error.message, 2);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label}_invalid_json`, error.message, 2);
  }
}

function loadSchema(name) {
  const file = path.join(REFERENCES, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail("schema_unreadable", { file, message: error.message }, 2);
  }
}

function sortedUnique(values) {
  return Array.from(new Set(values || [])).sort();
}

function deriveArtifactId(envelope) {
  const digest = crypto
    .createHash("sha256")
    .update(`${envelope.task_id}|${envelope.run_id}|${envelope.head_revision}`)
    .digest("hex")
    .slice(0, 12);
  return `GR-${digest}`;
}

function readEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_input", "The review input must be a JSON object.", 2);
  }
  const missing = ENVELOPE_FIELDS.filter(
    (field) => input[field] === undefined || input[field] === null || input[field] === ""
  );
  if (missing.length) fail("missing_fields", { context: "review_input", fields: missing }, 2);
  if (!Array.isArray(input.workspace_ids) || !input.workspace_ids.length) {
    fail("invalid_input", "workspace_ids must be a non-empty array.", 2);
  }
  if (!Array.isArray(input.changed_files) || !input.changed_files.length) {
    fail("invalid_input", "changed_files must be a non-empty array.", 2);
  }
  if (!input.generated_at) fail("missing_fields", { context: "review_input", fields: ["generated_at"] }, 2);
  return input;
}

// ---------------------------------------------------------------------------
// Finding acceptance
// ---------------------------------------------------------------------------

// A finding is accepted only when it is (a) schema-valid, (b) about the
// reviewed changeset, and (c) about files that exist.
//
// (b) enforces the code-reviewer's "input isolation" rule mechanically: a
//     reviewer may not report on files outside the changeset it was given.
// (c) catches the classic hallucinated file path.
//
// A rejected finding does not sink the whole review. It is dropped and
// reported in the diagnostics file, so one malformed finding cannot discard
// the findings that are fine.
function acceptFindings(findings, options) {
  const { findingSchema, changedFiles, workspace } = options;
  const accepted = [];
  const rejected = [];

  for (const [index, finding] of findings.entries()) {
    const label = finding && finding.group_id ? String(finding.group_id) : `#${index + 1}`;
    const result = validate(findingSchema, finding);
    if (!result.ok) {
      rejected.push({ group_id: label, reason: "schema_invalid", errors: formatErrors(result.errors) });
      continue;
    }
    const outside = finding.files.filter((file) => !changedFiles.has(file));
    if (outside.length) {
      rejected.push({ group_id: label, reason: "file_not_in_changeset", files: outside });
      continue;
    }
    const missing = finding.files.filter((file) => !fs.existsSync(path.resolve(workspace, file)));
    if (missing.length) {
      rejected.push({ group_id: label, reason: "file_not_found", files: missing });
      continue;
    }
    accepted.push({
      ...finding,
      files: sortedUnique(finding.files),
      validation_refs: sortedUnique(finding.validation_refs),
      follow_ups: sortedUnique(finding.follow_ups),
    });
  }

  accepted.sort((left, right) => left.group_id.localeCompare(right.group_id));
  return { accepted, rejected };
}

function buildArtifact(envelope, groups, generatedAt) {
  let summary;
  try {
    summary = summarizeGroups(groups);
  } catch (error) {
    fail("invalid_risk", error.risk, 2);
  }
  return {
    type: "guided_review",
    artifact_id: envelope.artifact_id || deriveArtifactId(envelope),
    task_id: envelope.task_id,
    run_id: envelope.run_id,
    session_id: envelope.session_id,
    workspace_ids: sortedUnique(envelope.workspace_ids),
    base_revision: envelope.base_revision,
    head_revision: envelope.head_revision,
    groups,
    summary,
    generated_at: generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

// The builtin backend reads the raw findings document directly. It is the
// /code-review workflow and the code-reviewer sub-agent's output format.
function builtinBackend(envelope) {
  if (!Array.isArray(envelope.findings)) {
    fail("invalid_input", "The review input must carry a findings array.", 2);
  }
  return envelope.findings;
}

// The external backend loads an operator-supplied adapter. The adapter only
// proposes findings; it never gets to decide what is accepted.
//
// Adapter contract:
//   module.exports = { review(context) { return { findings: [...] } } }
//   - `context` is the parsed review input envelope
//   - the return value must carry a `findings` array
//   - the adapter may be async (the return value may be a promise)
//
// No adapter implementation ships with Cortex Agent, and none is a dependency.
// The interface exists so an operator can wire their own reviewer without the
// core having to know about it.
async function externalBackend(adapterPath, envelope) {
  if (!adapterPath || adapterPath === true) {
    fail("adapter_required", "The external backend needs --adapter <module>.", 2);
  }
  let adapter;
  try {
    adapter = require(path.resolve(adapterPath));
  } catch (error) {
    fail("adapter_unloadable", { adapter: adapterPath, message: error.message }, 2);
  }
  if (!adapter || typeof adapter.review !== "function") {
    fail("adapter_invalid", "The adapter must export a review(context) function.", 2);
  }
  const produced = await adapter.review(envelope);
  const findings = produced && produced.findings;
  if (!Array.isArray(findings)) {
    fail("adapter_invalid", "The adapter must resolve to { findings: [...] }.", 2);
  }
  return findings;
}

function writeOutput(file, value) {
  if (!file) fail("output_required", "Pass --output.", 2);
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
  return target;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backend = args.backend || "builtin";
  if (!["builtin", "external"].includes(backend)) {
    fail("unknown_backend", backend, 2);
  }

  const envelope = readEnvelope(readJson(args.input, "input"));
  const workspace = args.workspace && args.workspace !== true ? path.resolve(args.workspace) : process.cwd();
  const generatedAt = args.now && args.now !== true ? args.now : envelope.generated_at;

  const findings =
    backend === "builtin"
      ? builtinBackend(envelope)
      : await externalBackend(args.adapter, envelope);

  const findingSchema = loadSchema("guided-review-finding.schema.json");
  const artifactSchema = loadSchema("guided-review.schema.json");

  const { accepted, rejected } = acceptFindings(findings, {
    findingSchema,
    changedFiles: new Set(envelope.changed_files),
    workspace,
  });

  if (!accepted.length) {
    fail("no_acceptable_findings", { rejected }, 2);
  }

  const artifact = buildArtifact(envelope, accepted, generatedAt);
  const check = validate(artifactSchema, artifact);
  if (!check.ok) {
    fail("artifact_invalid", formatErrors(check.errors), 2);
  }

  const target = writeOutput(args.output, artifact);
  writeOutput(`${target}.diagnostics.json`, {
    backend,
    dataset_scope: "reviewer-backend",
    generated_at: generatedAt,
    workspace,
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    rejected,
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      backend,
      output: target,
      type: artifact.type,
      artifact_id: artifact.artifact_id,
      findings: accepted.length,
      rejected: rejected.length,
    })}\n`
  );
}

if (require.main === module) {
  main();
}

module.exports = { acceptFindings, buildArtifact, deriveArtifactId, main, parseArgs };
