#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// scripts/agent-review-benchmark-runner.cjs
// ---------------------------------------------------------------------------
// Executes a versioned Agent Review Benchmark dataset and produces the
// benchmark summary consumed by the `agent-review-benchmark` skill.
//
// Why this exists:
//   The skill's `benchmark` command aggregates assertion counts that a caller
//   supplies by hand. That makes the number a self-report: nobody checks
//   whether the assertions were actually evaluated. This runner closes the
//   loop — it materialises each case's fixture, runs the candidate command,
//   evaluates the blocking assertions mechanically, and only then hands the
//   resulting counts to the skill.
//
// Design constraints (kept from the skill contract):
//   - Deterministic and local: no LLM judge, no network, pure Node stdlib.
//   - Quality / cost / duration stay separate dimensions. Local runs spend no
//     model tokens, so cost_microunits is honestly 0 and duration is measured.
//   - The summary is byte-stable for the same input; measured wall-clock and
//     per-assertion detail live in a separate diagnostics file.
//
// Usage:
//   node scripts/agent-review-benchmark-runner.cjs run \
//     --dataset benchmarks/agent-review/<id>/dataset.json \
//     --candidate reference \
//     --output .agent/metrics/agent-benchmark-summary.json \
//     [--now 2026-01-01T00:00:00.000Z] \
//     [--min-quality-bp 10000] [--max-quality-bp 5000]
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function fail(error, details, code = 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, details })}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
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

function resolveToken(value) {
  return String(value).replace(/\$\{cortex\}/g, ROOT);
}

function findSkillScript() {
  const candidates = [
    path.join(ROOT, ".agent", "skills", "agent-review-benchmark", "scripts", "index.js"),
    path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-review-benchmark", "scripts", "index.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadDataset(file) {
  if (!file) fail("dataset_required", "Pass --dataset <dataset.json>.", 2);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    fail("invalid_dataset", error.message, 2);
  }
  for (const field of ["dataset_id", "dataset_version", "cases"]) {
    if (!raw[field]) fail("invalid_dataset", `missing ${field}`, 2);
  }
  if (!Array.isArray(raw.cases) || !raw.cases.length) fail("invalid_dataset", "cases must be a non-empty array", 2);
  return raw;
}

// ---- workspace helpers -----------------------------------------------------

function writeFile(workspace, relative, content) {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function removePath(workspace, relative) {
  const target = path.join(workspace, relative);
  fs.rmSync(target, { recursive: true, force: true });
}

function runCommand(command, cwd) {
  const [executable, ...rest] = command.map(resolveToken);
  const started = Date.now();
  const result = spawnSync(executable, rest, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return {
    command,
    exitCode: result.status === null ? -1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    durationMs: Date.now() - started,
  };
}

// ---- assertion evaluation --------------------------------------------------

function assertionId(assertion, index) {
  return assertion.id || `${assertion.kind}-${index + 1}`;
}

function collectSymlinks(root, relative, acc = []) {
  const target = path.join(root, relative);
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isSymbolicLink()) acc.push(full);
    else if (entry.isDirectory()) collectSymlinks(root, path.relative(root, full), acc);
  }
  return acc;
}

function readJsonField(file, field) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let current = data;
  for (const part of String(field).split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function evaluate(assertion, context) {
  const { workspace, run } = context;
  const at = path.join(workspace, assertion.path || "");
  switch (assertion.kind) {
    case "file_exists":
      return fs.existsSync(at);
    case "file_absent":
      return !fs.existsSync(at);
    case "file_contains": {
      if (!fs.existsSync(at)) return false;
      return new RegExp(assertion.pattern).test(fs.readFileSync(at, "utf8"));
    }
    case "file_not_contains": {
      if (!fs.existsSync(at)) return true;
      return !new RegExp(assertion.pattern).test(fs.readFileSync(at, "utf8"));
    }
    case "file_equals":
      return fs.existsSync(at) && fs.readFileSync(at, "utf8") === assertion.content;
    case "no_absolute_symlink": {
      // The tree must exist: "no absolute symlink" is vacuously true for a
      // missing directory, and a vacuous assertion would let a candidate that
      // does nothing at all score points.
      if (!fs.existsSync(at)) return false;
      const links = collectSymlinks(workspace, assertion.path || ".");
      return links.every((link) => !path.isAbsolute(fs.readlinkSync(link)));
    }
    case "json_field_equals": {
      if (!fs.existsSync(at)) return false;
      return readJsonField(at, assertion.field) === assertion.value;
    }
    case "output_contains":
      return new RegExp(assertion.pattern).test(run.stdout + run.stderr);
    case "output_not_contains":
      return !new RegExp(assertion.pattern).test(run.stdout + run.stderr);
    case "output_json_field_equals": {
      try {
        const data = JSON.parse(run.stdout);
        let current = data;
        for (const part of String(assertion.field).split(".")) {
          if (current === null || current === undefined) return false;
          current = current[part];
        }
        return current === assertion.value;
      } catch {
        return false;
      }
    }
    case "command_exit": {
      const probe = runCommand(assertion.command, workspace);
      return probe.exitCode === assertion.expect;
    }
    default:
      fail("unknown_assertion", assertion.kind, 2);
      return false;
  }
}

// ---- case execution --------------------------------------------------------

function executeCase(item, candidateId, dataset) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-case-"));
  try {
    for (const step of item.setup || []) runCommand(step.command, workspace);
    const fixture = item.fixture || {};
    for (const [relative, content] of Object.entries(fixture.files || {})) writeFile(workspace, relative, content);
    for (const relative of fixture.remove || []) removePath(workspace, relative);

    const candidate = (item.candidates || {})[candidateId];
    if (!candidate) fail("unknown_candidate", { case_id: item.case_id, candidate_id: candidateId }, 2);
    const run = runCommand(candidate.command, workspace);

    const assertions = item.assertions || [];
    let passed = 0;
    const details = [];
    for (let index = 0; index < assertions.length; index += 1) {
      const assertion = assertions[index];
      let ok = false;
      try {
        ok = evaluate(assertion, { workspace, run });
      } catch (error) {
        ok = false;
        details.push({ id: assertionId(assertion, index), kind: assertion.kind, ok: false, error: error.message });
        continue;
      }
      if (ok) passed += 1;
      details.push({ id: assertionId(assertion, index), kind: assertion.kind, ok });
    }

    return {
      case_id: item.case_id,
      weight: item.weight,
      passed_assertions: passed,
      total_assertions: assertions.length,
      cost_microunits: 0,
      duration_ms: run.durationMs,
      evidence_refs: assertions.map((assertion, index) => `${item.case_id}#${assertionId(assertion, index)}`),
      details,
      exit_code: run.exitCode,
      stdout_tail: run.stdout.slice(-400),
      stderr_tail: run.stderr.slice(-400),
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// ---- main ------------------------------------------------------------------

// The engine behind every dataset in this repository: it materializes a
// fixture, runs a candidate command, evaluates the assertions mechanically and
// hands the counts to the benchmark skill for the basis-point score.
//
// It is exported so that a dataset with a different *output* contract can
// reuse the same engine — the runtime-evidence runner scores the same way but
// writes `.agent/metrics/verification-summary.json` instead of a benchmark
// summary. The dataset semantics, the assertion vocabulary and the
// discriminating contract (reference = 10000 bp, noop materially lower) are
// identical for both.
function runBenchmark(args) {
  const dataset = loadDataset(args.dataset);
  const candidateId = args.candidate;
  if (!candidateId) fail("candidate_required", "Pass --candidate <id>.", 2);
  if (!args.output) fail("output_required", "Pass --output <file>.", 2);

  const skillScript = findSkillScript();
  if (!skillScript) fail("skill_missing", "agent-review-benchmark skill script not found", 2);

  const executed = dataset.cases
    .map((item) => executeCase(item, candidateId, dataset))
    .sort((left, right) => left.case_id.localeCompare(right.case_id));

  const benchmarkInput = {
    dataset_id: dataset.dataset_id,
    dataset_version: dataset.dataset_version,
    generated_at: args.now || "1970-01-01T00:00:00.000Z",
    cases: executed.map((item) => ({
      case_id: item.case_id,
      weight: item.weight,
      runs: [{
        candidate_id: candidateId,
        passed_assertions: item.passed_assertions,
        total_assertions: item.total_assertions,
        cost_microunits: item.cost_microunits,
        duration_ms: item.duration_ms,
        evidence_refs: item.evidence_refs,
      }],
    })),
  };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-summary-"));
  try {
    const inputFile = path.join(scratch, "benchmark-input.json");
    const summaryFile = path.join(scratch, "benchmark-summary.json");
    fs.writeFileSync(inputFile, `${JSON.stringify(benchmarkInput, null, 2)}\n`);
    const result = spawnSync(process.execPath, [skillScript, "benchmark", "--input", inputFile, "--output", summaryFile], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      fail("benchmark_failed", { stdout: result.stdout, stderr: result.stderr }, 2);
    }
    const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));

    const target = path.resolve(args.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(`${target}.input.json`, `${JSON.stringify(benchmarkInput, null, 2)}\n`);
    fs.writeFileSync(`${target}.diagnostics.json`, `${JSON.stringify({
      dataset_id: dataset.dataset_id,
      candidate_id: candidateId,
      cases: executed.map((item) => ({
        case_id: item.case_id,
        weight: item.weight,
        passed_assertions: item.passed_assertions,
        total_assertions: item.total_assertions,
        duration_ms: item.duration_ms,
        exit_code: item.exit_code,
        assertions: item.details,
        stdout_tail: item.stdout_tail,
        stderr_tail: item.stderr_tail,
      })),
    }, null, 2)}\n`);

    return { summary, benchmarkInput, executed, target, skillScript };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "run") fail("unknown_command", args.command || "<none>", 2);

  const { summary, target } = runBenchmark(args);
  const candidate = summary.candidates[0];
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dataset_id: summary.dataset_id,
    candidate_id: candidate.candidate_id,
    quality_basis_points: candidate.quality_basis_points,
    passed_assertions: candidate.passed_assertions,
    total_assertions: candidate.total_assertions,
    output: target,
  })}\n`);

  if (args["min-quality-bp"] !== undefined && candidate.quality_basis_points < Number(args["min-quality-bp"])) {
    fail("quality_below_threshold", {
      quality_basis_points: candidate.quality_basis_points,
      required: Number(args["min-quality-bp"]),
    }, 1);
  }

  // The upper bound is what makes a dataset *discriminating*: a candidate
  // that does nothing at all has to score materially lower than the
  // reference. Without it, a dataset whose assertions never fail would
  // still report a perfect score and could not detect a regression.
  if (args["max-quality-bp"] !== undefined && candidate.quality_basis_points > Number(args["max-quality-bp"])) {
    fail("quality_above_threshold", {
      quality_basis_points: candidate.quality_basis_points,
      required: Number(args["max-quality-bp"]),
    }, 1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluate,
  executeCase,
  findSkillScript,
  loadDataset,
  main,
  parseArgs,
  runBenchmark,
  runCommand,
};
