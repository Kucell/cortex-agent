/**
 * tests/runtime-evidence/verification-summary-contract.test.js
 *
 * `verification-summary.json` has three producers, and until now they fought
 * over the same file with incompatible vocabularies:
 *
 *   init.js              wrote `overall_status: "not_run"` plus
 *                        `coverage` / `results` / `blockers` / `warnings`
 *   generate-summary.js  wrote `overall_status: "healthy"|"warning"|
 *                        "critical"|"unknown"` plus `components`, **overwriting**
 *                        everything the first producer had written
 *
 * The skill contract (and every downstream reader, including
 * `skill-telemetry`) only understands `pass` / `fail` / `partial` /
 * `not_run`, so neither producer could ever satisfy it: the telemetry reader
 * silently dropped the signal, and `/ship` CLEAN had nothing to block on.
 *
 * The contract these tests pin:
 *   - `overall_status` belongs to the *verification* side. Only a real
 *     verification run may set it to pass/fail/partial.
 *   - The repository health aggregate moves to `repo_health_status` /
 *     `repo_health_score`; it is a different question and must not be
 *     mistaken for "the application was verified".
 *   - `generate-summary.js` merges. It must never drop the verification
 *     conclusion written by the runtime-evidence runner.
 *
 * The tests run the scripts against a sandbox project (test-policy §2.5:
 * governance scripts derive their state paths from `process.cwd()`, so they
 * must never run against a real working copy).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SKILL_DIR = path.resolve(
  __dirname,
  "../../templates/_shared/.agent/skills/runtime-evidence/scripts"
);
const INIT = path.join(SKILL_DIR, "init.js");
const GENERATE = path.join(SKILL_DIR, "generate-summary.js");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-contract-"));
  fs.mkdirSync(path.join(dir, ".agent", "metrics"), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runScript(script, cwd) {
  return spawnSync("node", [script], { cwd, encoding: "utf8" });
}

function readSummary(dir) {
  return JSON.parse(
    fs.readFileSync(path.join(dir, ".agent", "metrics", "verification-summary.json"), "utf8")
  );
}

const VERIFICATION_STATUSES = ["pass", "fail", "partial", "not_run"];

// ─── the empty shell ─────────────────────────────────────────────────────────

test("init writes an empty shell whose overall_status is not_run", () => {
  const dir = makeProject();
  try {
    const result = runScript(INIT, dir);
    assert.equal(result.status, 0, result.stderr);
    const summary = readSummary(dir);
    assert.equal(summary.overall_status, "not_run");
    assert.ok(VERIFICATION_STATUSES.includes(summary.overall_status));
    assert.deepEqual(Object.keys(summary.coverage).sort(), ["api", "trace", "ui"]);
    assert.deepEqual(Object.keys(summary.results).sort(), ["api", "trace", "ui"]);
    assert.equal(summary.results.api.status, "not_run");
    assert.deepEqual(summary.blockers, []);
    assert.deepEqual(summary.warnings, []);
  } finally {
    cleanup(dir);
  }
});

test("init does not overwrite an existing summary", () => {
  const dir = makeProject();
  try {
    fs.writeFileSync(
      path.join(dir, ".agent", "metrics", "verification-summary.json"),
      JSON.stringify({ overall_status: "pass", results: { api: { status: "pass" } } }),
      "utf8"
    );
    assert.equal(runScript(INIT, dir).status, 0);
    const summary = readSummary(dir);
    assert.equal(summary.overall_status, "pass", "an existing verification result must survive init");
  } finally {
    cleanup(dir);
  }
});

// ─── the merge ───────────────────────────────────────────────────────────────

test("generate-summary preserves a verification conclusion written by the runner", () => {
  const dir = makeProject();
  try {
    // What the runtime-evidence runner writes after a real run.
    fs.writeFileSync(
      path.join(dir, ".agent", "metrics", "verification-summary.json"),
      JSON.stringify(
        {
          generated_at: "2026-10-22T00:00:00.000Z",
          triggered_by: "runtime-evidence-runner",
          overall_status: "fail",
          coverage: { ui: "skipped", api: "minimal", trace: "skipped" },
          results: {
            ui: { status: "not_run", paths_checked: 0, screenshot_paths: [] },
            api: { status: "fail", endpoints_checked: 3, cases_checked: 1, passed_assertions: 2, total_assertions: 3 },
            trace: { status: "skipped", reason: "n/a" },
          },
          blockers: [{ case_id: "c", assertion_id: "a", kind: "k" }],
          warnings: [],
        },
        null,
        2
      ),
      "utf8"
    );

    const result = runScript(GENERATE, dir);
    assert.equal(result.status, 0, result.stderr);
    const summary = readSummary(dir);

    assert.equal(summary.overall_status, "fail", "the verification conclusion must not be overwritten");
    assert.equal(summary.coverage.api, "minimal", "coverage must survive the merge");
    assert.equal(summary.results.api.endpoints_checked, 3, "results must survive the merge");
    assert.equal(summary.blockers.length, 1, "blockers must survive the merge");
  } finally {
    cleanup(dir);
  }
});

test("generate-summary keeps not_run when no verification ever ran", () => {
  const dir = makeProject();
  try {
    assert.equal(runScript(GENERATE, dir).status, 0);
    const summary = readSummary(dir);
    assert.equal(
      summary.overall_status,
      "not_run",
      "repository health must never be reported as a verification pass"
    );
    assert.ok(
      ["healthy", "warning", "critical", "unknown"].includes(summary.repo_health_status),
      `the health aggregate must live in repo_health_status: ${summary.repo_health_status}`
    );
    assert.equal(typeof summary.repo_health_score, "number");
    assert.ok(summary.components, "components must still be written");
  } finally {
    cleanup(dir);
  }
});

test("generate-summary writes a complete shell when the summary does not exist yet", () => {
  const dir = makeProject();
  try {
    assert.equal(runScript(GENERATE, dir).status, 0);
    const summary = readSummary(dir);
    assert.deepEqual(Object.keys(summary.coverage).sort(), ["api", "trace", "ui"]);
    assert.deepEqual(Object.keys(summary.results).sort(), ["api", "trace", "ui"]);
    assert.deepEqual(summary.blockers, []);
    assert.deepEqual(summary.warnings, []);
  } finally {
    cleanup(dir);
  }
});

// ─── the two producers must not fight ────────────────────────────────────────

test("the runtime-evidence runner preserves the repository health fields", () => {
  const dir = makeProject();
  try {
    // generate-summary.js runs first: the repository health lands in the file.
    assert.equal(runScript(GENERATE, dir).status, 0);
    const before = readSummary(dir);
    assert.ok(before.components, "generate-summary must write the components");
    assert.ok(before.repo_health_status, "generate-summary must write the health status");

    // The runner runs second: it owns the verification side and must not
    // drop the health side on the way through.
    const runner = path.resolve(__dirname, "../../scripts/runtime-evidence-runner.cjs");
    const dataset = path.resolve(
      __dirname,
      "../../benchmarks/runtime-evidence/event-bus/dataset.json"
    );
    const result = spawnSync(
      "node",
      [
        runner,
        "run",
        "--dataset",
        dataset,
        "--candidate",
        "reference",
        "--output",
        path.join(dir, ".agent", "metrics", "verification-summary.json"),
      ],
      { cwd: dir, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);

    const after = readSummary(dir);
    assert.equal(after.overall_status, "pass", "the runner must write the verification result");
    assert.ok(after.components, "the runner must not drop the repository health");
    assert.equal(after.repo_health_status, before.repo_health_status);
    assert.equal(after.repo_health_score, before.repo_health_score);
  } finally {
    cleanup(dir);
  }
});
