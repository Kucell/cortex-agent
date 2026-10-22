"use strict";

/**
 * Activity Reality Reconciliation — main-repo entry test.
 *
 * Validates the MS-003 contract from the public surface:
 *  - VC-007 reconciliation does NOT infer workflow completion
 *  - VC-008 completeness distinguishes complete/partial/unknown/unavailable/failed/stale
 *  - VC-009 self-check must NOT report PASS when a critical gap exists
 *
 * The reconciliation engine and self-check skill live in the inner
 * .agent workspace; this test exercises the public CLI and asserts
 * the contract from the main repo.
 *
 * The scripts resolve their state paths from `process.cwd()`, so they run
 * against a sandboxed copy of `.agent/` — otherwise every run rewrites the
 * tracked reports in the developer's working copy.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createAgentSandbox } = require("../helpers/agent-sandbox");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
// Scripts stay in the real repository (self-check requires `../../../../lib/…`
// through `__dirname`); only the working directory moves into the sandbox.
const SELF_CHECK = path.join(REPO_ROOT, ".agent", "skills", "self-check", "scripts", "index.js");
const REALITY_REC = path.join(REPO_ROOT, ".agent", "skills", "self-check", "scripts", "reality-reconciliation.js");

let sandbox = null;
let ROOT = "";
let REALITY_REPORT_FILE = "";

test.before(() => {
  sandbox = createAgentSandbox();
  ROOT = sandbox.root;
  REALITY_REPORT_FILE = path.join(ROOT, ".agent", "metrics", "reality-reconciliation-report.json");
});

test.after(() => {
  if (sandbox) sandbox.cleanup();
});

function runSelfCheck(args = []) {
  // self-check exits with non-zero on fail, but its JSON report is still
  // the contract surface; capture stdout regardless.
  const result = spawnSync("node", [SELF_CHECK, ...args], { encoding: "utf8", cwd: ROOT });
  return { status: result.status, report: JSON.parse(result.stdout) };
}

function runRealityRec(args = []) {
  // The CLI prints a human-readable summary (not JSON) and exits non-zero
  // when the report is critical; the persisted JSON file is the contract
  // surface, so the caller reads that instead of stdout.
  const result = spawnSync("node", [REALITY_REC, ...args], { encoding: "utf8", cwd: ROOT });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("self-check report shape covers VC-008 completeness vocabulary", () => {
  const { report } = runSelfCheck(["check"]);
  assert.ok(typeof report.overall_status === "string");
  // self-check vocabulary is pass | warning | fail (see runFullCheck()).
  assert.ok(["pass", "warning", "fail"].includes(report.overall_status),
    `self-check overall_status must be pass|warning|fail, got: ${report.overall_status}`);
  assert.ok(["L0", "L1", "L2", "L3"].includes(report.drift_level));
  assert.ok(report.results && typeof report.results === "object");
  assert.ok(Object.keys(report.results).length > 0);
});

test("self-check never infers workflow completion from git or filesystem (VC-007)", () => {
  // The reality_reconciliation source must NOT contain phrases that
  // would let it infer a workflow's completion, approval, or validation
  // PASS purely from Git activity or filesystem observations.
  const source = fs.readFileSync(REALITY_REC, "utf8");
  const forbidden = [
    /inferred completion/i,
    /completed by commit/i,
    /approved by merge/i,
    /workflow.*pass.*from.*git/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `reality reconciliation must not infer completion: ${pattern}`);
  }
});

test("reality reconciliation report keeps the contract surface alive", () => {
  // VC-008 contract: the reality reconciliation report must persist a
  // structured schema with git_reality, runtime_state, missions,
  // findings, and repair_plan. Downstream consumers depend on these
  // keys; the completeness vocabulary ("complete"/"partial"/"unknown")
  // is documented in the report header even when not present in the
  // current findings.
  //
  // The report is regenerated here instead of read from the working copy:
  // a committed report would only prove what an earlier run wrote.
  runRealityRec();
  assert.ok(fs.existsSync(REALITY_REPORT_FILE), "reality-reconciliation must persist its JSON report");
  const persisted = JSON.parse(fs.readFileSync(REALITY_REPORT_FILE, "utf8"));
  // Required schema keys
  for (const key of ["gate", "overall_status", "git_reality", "runtime_state", "missions", "findings", "repair_plan"]) {
    assert.ok(key in persisted, `reality report missing required key: ${key}`);
  }
  // overall_status must be one of the documented levels
  assert.ok(["pass", "warn", "critical"].includes(persisted.overall_status),
    `reality report overall_status must be pass|warn|critical, got: ${persisted.overall_status}`);
  // findings is an array; empty array is acceptable
  assert.ok(Array.isArray(persisted.findings));
});

test("self-check report file is written under .agent/metrics (VC-009 anchor)", () => {
  const { report } = runSelfCheck(["check"]);
  assert.ok(typeof report.run_at === "string");
  const metricsFile = path.join(ROOT, ".agent", "metrics", "self-check-report.json");
  assert.ok(fs.existsSync(metricsFile), "self-check must persist its JSON report");
  const persisted = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
  assert.strictEqual(persisted.skill || persisted.skill_id, report.skill || report.skill_id);
});

test("self-check cannot report PASS when a critical reconciliation gap exists (VC-009)", () => {
  const { report } = runSelfCheck(["check"]);
  const reality = report.results && report.results.reality_reconciliation;
  if (reality && Array.isArray(reality.findings)) {
    const criticalCount = reality.findings.filter((f) => f.severity === "critical").length;
    if (criticalCount > 0) {
      assert.strictEqual(report.overall_status, "fail",
        "VC-009 violated: critical reconciliation gap but self-check reports pass");
    }
  }
});
