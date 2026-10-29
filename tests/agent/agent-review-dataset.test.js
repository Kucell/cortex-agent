"use strict";

// ---------------------------------------------------------------------------
// Agent Review Benchmark — real regression dataset gate.
//
// The skill can aggregate assertion counts, but a caller can always hand-fill
// those counts. This gate closes that hole: it executes the versioned dataset
// in `benchmarks/agent-review/` and asserts that
//
//   1. the reference candidate satisfies every blocking assertion, and
//   2. a candidate that does nothing scores materially lower.
//
// Point 2 is the important one. A benchmark that only ever sees a perfect
// candidate proves nothing — it would pass just as well against a regression.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const RUNNER = path.join(ROOT, "scripts", "agent-review-benchmark-runner.cjs");
const DATASET = path.join(ROOT, "benchmarks", "agent-review", "cortex-governance-bootstrap", "dataset.json");
const SCHEMA = path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-review-benchmark", "references", "benchmark-summary.schema.json");

function runCandidate(candidate, directory, name) {
  const output = path.join(directory, `${name}.json`);
  const result = spawnSync(process.execPath, [
    RUNNER, "run",
    "--dataset", DATASET,
    "--candidate", candidate,
    "--output", output,
    "--now", "2026-10-22T00:00:00.000Z",
  ], { encoding: "utf8", cwd: ROOT });
  assert.equal(result.status, 0, `runner failed: ${result.stdout}${result.stderr}`);
  const summary = JSON.parse(fs.readFileSync(output, "utf8"));
  const diagnostics = JSON.parse(fs.readFileSync(`${output}.diagnostics.json`, "utf8"));
  return { summary, diagnostics, output };
}

// Each candidate is executed once per file and reused: every case materialises
// a workspace and spawns real CLI commands, so repeating them would add
// avoidable load to a parallel test run.
const CACHE = new Map();

function candidateResult(candidate, directory) {
  if (!CACHE.has(candidate)) {
    CACHE.set(candidate, runCandidate(candidate, directory, candidate));
  }
  return CACHE.get(candidate);
}

// A minimal dataset for the assertions about *runner mechanics* (threshold
// handling, output layout). The real regression set runs the full governance
// CLI (init / update), which copies the whole template tree — far too heavy to
// re-execute just to check how the runner reacts to a threshold. These two
// cases cost two trivial node invocations instead of a full dataset run.
const SYNTHETIC_DATASET = {
  dataset_id: "synthetic-runner-mechanics",
  dataset_version: "1",
  cases: [
    {
      case_id: "marker",
      weight: 1,
      candidates: {
        pass: { command: ["node", "-e", "require('fs').writeFileSync('marker.txt','x\\n')"] },
        fail: { command: ["node", "-e", "process.exit(0)"] },
      },
      assertions: [{ id: "marker-exists", kind: "file_exists", path: "marker.txt" }],
    },
  ],
};

function writeSyntheticDataset(directory) {
  const file = path.join(directory, "synthetic-dataset.json");
  fs.writeFileSync(file, `${JSON.stringify(SYNTHETIC_DATASET, null, 2)}\n`);
  return file;
}

test("reference candidate satisfies every blocking assertion in the dataset", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const { summary, diagnostics } = candidateResult("reference", directory);
  const candidate = summary.candidates[0];

  assert.equal(summary.type, "agent_benchmark_summary");
  assert.equal(summary.dataset_id, "cortex-governance-bootstrap");
  assert.equal(summary.dataset_version, "1");
  assert.equal(summary.generated_at, "2026-10-22T00:00:00.000Z");
  assert.equal(summary.case_count, 3);
  assert.equal(candidate.candidate_id, "reference");
  assert.equal(candidate.passed_assertions, candidate.total_assertions);
  assert.equal(candidate.quality_basis_points, 10000);

  // Every assertion must actually have been evaluated — a dataset whose
  // assertions silently fail to run would report a vacuous 100%.
  for (const item of diagnostics.cases) {
    assert.ok(item.total_assertions > 0, `case ${item.case_id} evaluated no assertion`);
    for (const assertion of item.assertions) {
      assert.ok(assertion.ok, `assertion ${assertion.id} of ${item.case_id} failed`);
    }
  }
});

test("dataset discriminates: a candidate that does nothing scores materially lower", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const reference = candidateResult("reference", directory);
  const noop = candidateResult("noop", directory);
  const referenceScore = reference.summary.candidates[0].quality_basis_points;
  const noopScore = noop.summary.candidates[0].quality_basis_points;

  assert.equal(referenceScore, 10000);
  assert.ok(noopScore < 5000,
    `a no-op candidate scored ${noopScore} bp — the dataset cannot detect regressions`);
  assert.ok(noopScore < referenceScore);
});

test("benchmark summary stays inside the published schema", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const { summary } = candidateResult("reference", directory);
  const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
  for (const field of schema.required) {
    assert.ok(field in summary, `summary missing required field: ${field}`);
  }
  const candidate = summary.candidates[0];
  for (const field of schema.properties.candidates.items.required) {
    assert.ok(field in candidate, `candidate missing required field: ${field}`);
  }
  assert.ok(Number.isInteger(candidate.quality_basis_points));
  assert.ok(candidate.quality_basis_points >= 0 && candidate.quality_basis_points <= 10000);
  assert.equal(new Set(candidate.evidence_refs).size, candidate.evidence_refs.length,
    "evidence refs must be unique");
  assert.ok(candidate.evidence_refs.every((ref) => typeof ref === "string" && ref.includes("#")),
    "evidence refs must point at a specific assertion");
});

test("runner fails closed on a malformed dataset", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const broken = path.join(directory, "broken.json");
  fs.writeFileSync(broken, JSON.stringify({ dataset_id: "x" }));
  const result = spawnSync(process.execPath, [
    RUNNER, "run", "--dataset", broken, "--candidate", "reference", "--output", path.join(directory, "out.json"),
  ], { encoding: "utf8", cwd: ROOT });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /invalid_dataset/);
});

test("runner enforces the quality bounds in both directions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataset = writeSyntheticDataset(directory);

  const base = ["run", "--dataset", dataset, "--output", path.join(directory, "out.json"),
    "--now", "2026-10-22T00:00:00.000Z"];

  // A degraded candidate must trip the lower bound.
  const tooLow = spawnSync(process.execPath,
    [RUNNER, ...base, "--candidate", "fail", "--min-quality-bp", "10000"], { encoding: "utf8", cwd: ROOT });
  assert.equal(tooLow.status, 1);
  assert.match(tooLow.stdout, /quality_below_threshold/);

  // A candidate that scores too well to detect a regression must trip the
  // upper bound — that is what keeps the dataset honest.
  const tooHigh = spawnSync(process.execPath,
    [RUNNER, ...base, "--candidate", "pass", "--max-quality-bp", "100"], { encoding: "utf8", cwd: ROOT });
  assert.equal(tooHigh.status, 1);
  assert.match(tooHigh.stdout, /quality_above_threshold/);

  // The reference candidate satisfies both bounds at once.
  const ok = spawnSync(process.execPath,
    [RUNNER, ...base, "--candidate", "pass", "--min-quality-bp", "10000"], { encoding: "utf8", cwd: ROOT });
  assert.equal(ok.status, 0, `runner failed: ${ok.stdout}${ok.stderr}`);
});

test("runner writes only the requested artifacts and nothing else", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-benchmark-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataset = writeSyntheticDataset(directory);
  const output = path.join(directory, "artifacts.json");

  const result = spawnSync(process.execPath, [
    RUNNER, "run", "--dataset", dataset, "--candidate", "pass", "--output", output,
    "--now", "2026-10-22T00:00:00.000Z",
  ], { encoding: "utf8", cwd: ROOT });
  assert.equal(result.status, 0, `runner failed: ${result.stdout}${result.stderr}`);

  // The summary, the skill-facing benchmark input, and the diagnostics that
  // carry the measured wall-clock live next to the requested output. Nothing
  // else may appear in the output directory.
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    "artifacts.json",
    "artifacts.json.diagnostics.json",
    "artifacts.json.input.json",
    "synthetic-dataset.json",
  ]);
  assert.ok(fs.existsSync(output));
  const benchmarkInput = JSON.parse(fs.readFileSync(`${output}.input.json`, "utf8"));
  assert.equal(benchmarkInput.dataset_id, "synthetic-runner-mechanics");
  assert.equal(benchmarkInput.cases.length, 1);
  for (const item of benchmarkInput.cases) {
    assert.equal(item.runs.length, 1);
    assert.equal(item.runs[0].candidate_id, "pass");
    // A local deterministic run spends no model tokens; the honest value is 0.
    assert.equal(item.runs[0].cost_microunits, 0);
  }
});
