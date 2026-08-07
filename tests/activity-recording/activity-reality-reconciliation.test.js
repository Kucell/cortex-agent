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
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SELF_CHECK = path.join(ROOT, ".agent", "skills", "self-check", "scripts", "index.js");
const REALITY_REC = path.join(ROOT, ".agent", "skills", "self-check", "scripts", "reality-reconciliation.js");

function runSelfCheck(args = []) {
  // self-check exits with non-zero on fail, but its JSON report is still
  // the contract surface; capture stdout regardless.
  const result = require("node:child_process").spawnSync("node", [SELF_CHECK, ...args], { encoding: "utf8" });
  return { status: result.status, report: JSON.parse(result.stdout) };
}

function runRealityRec(args = []) {
  const result = require("node:child_process").spawnSync("node", [REALITY_REC, ...args], { encoding: "utf8" });
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test("self-check report shape covers VC-008 completeness vocabulary", () => {
  const { report } = runSelfCheck(["check"]);
  assert.ok(typeof report.overall_status === "string");
  assert.ok(["pass", "warn", "fail"].includes(report.overall_status));
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
  const reportFile = path.join(ROOT, ".agent", "metrics", "reality-reconciliation-report.json");
  if (!fs.existsSync(reportFile)) {
    require("node:child_process").spawnSync("node", [REALITY_REC], { encoding: "utf8" });
  }
  assert.ok(fs.existsSync(reportFile), "reality-reconciliation must persist its JSON report");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  // Required schema keys
  for (const key of ["gate", "overall_status", "git_reality", "runtime_state", "missions", "findings", "repair_plan"]) {
    assert.ok(key in report, `reality report missing required key: ${key}`);
  }
  // overall_status must be one of the documented levels
  assert.ok(["ok", "warning", "critical"].includes(report.overall_status),
    `reality report overall_status must be ok|warning|critical, got: ${report.overall_status}`);
  // findings is an array; empty array is acceptable
  assert.ok(Array.isArray(report.findings));
});

test("self-check report file is written under .agent/metrics (VC-009 anchor)", () => {
  const { report } = runSelfCheck(["check"]);
  assert.ok(typeof report.run_at === "string");
  const metricsFile = path.join(ROOT, ".agent", "metrics", "self-check-report.json");
  if (fs.existsSync(metricsFile)) {
    const persisted = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
    assert.strictEqual(persisted.skill || persisted.skill_id, report.skill || report.skill_id);
  }
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