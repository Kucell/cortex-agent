"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const driver = require("../../scripts/p002-measurement-driver.js")

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p012-mf-"))
  fs.mkdirSync(path.join(dir, ".agent/decisions"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".agent/waitpoints"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".agent/context-index.json"), JSON.stringify({
    _meta: { generated_by: "test" },
    modules: [
      { module: "alpha", name: "alpha", module_path: "alpha/src", keywords: ["a", "b", "c"] },
      { module: "beta", name: "beta", module_path: "beta/src", keywords: ["d", "e"] },
      { module: "gamma", name: "gamma", module_path: "gamma/src", keywords: ["f"] },
    ],
  }))
  const decisionSrc = path.join(__dirname, "../../.agent/decisions/D-TCP-P012-p002-driver-9666ad4f.json")
  const waitpointSrc = path.join(__dirname, "../../.agent/waitpoints/WP-TCP-P012-p002-driver-9666ad4f.json")
  if (fs.existsSync(decisionSrc)) fs.copyFileSync(decisionSrc, path.join(dir, ".agent/decisions/D-TCP-P012-p002-driver-9666ad4f.json"))
  if (fs.existsSync(waitpointSrc)) fs.copyFileSync(waitpointSrc, path.join(dir, ".agent/waitpoints/WP-TCP-P012-p002-driver-9666ad4f.json"))
  return dir
}

test("P-012 driver plan refuses when context-index is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p012-empty-"))
  const result = driver.buildPlan(root, {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, "context_index_missing")
})

test("P-012 driver plan is deterministic for the same seed and index bytes", () => {
  const root = tmp()
  const a = driver.buildPlan(root, { seed: 0, scenarios: 2, perScenario: 2, budgetMin: 50, budgetMax: 200, budgetStep: 50 })
  const b = driver.buildPlan(root, { seed: 0, scenarios: 2, perScenario: 2, budgetMin: 50, budgetMax: 200, budgetStep: 50 })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(JSON.stringify(a.admissions), JSON.stringify(b.admissions))
})

test("P-012 driver plan admits only ocx-mf- prefix and never invents data", () => {
  const root = tmp()
  const result = driver.buildPlan(root, { seed: 0, scenarios: 3, perScenario: 2, budgetMin: 50, budgetMax: 200, budgetStep: 50 })
  assert.equal(result.ok, true)
  assert.equal(result.boundary.startsWith("read-only"), true)
  for (const entry of result.admissions) {
    assert.ok(entry.admission.attempt_id.startsWith("ocx-mf-"))
    assert.ok(entry.admission.task_terms.length >= 1)
    assert.ok(entry.admission.task_terms.length <= 6)
    assert.ok(entry.admission.token_budget >= 50 && entry.admission.token_budget <= 2000)
  }
  const moduleNames = new Set(result.admissions.map((entry) => entry.scenario_id.split("-")[1]))
  for (const name of moduleNames) assert.ok(["alpha", "beta", "gamma"].includes(name))
})

test("P-012 driver plan sanitizes slashes in module names so attempt_id is path-safe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p012-slash-"))
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true })
  fs.writeFileSync(path.join(root, ".agent/context-index.json"), JSON.stringify({
    _meta: {},
    modules: [{ module: "a/b", name: "a/b", module_path: "a/b/src", keywords: ["x"] }],
  }))
  const result = driver.buildPlan(root, { seed: 0, scenarios: 1, perScenario: 1, budgetMin: 50, budgetMax: 200, budgetStep: 50 })
  assert.equal(result.ok, true)
  assert.ok(result.admissions[0].admission.attempt_id.includes("a-b"))
  assert.ok(!result.admissions[0].admission.attempt_id.includes("/"))
})

test("P-012 driver apply dry-run never mutates files", () => {
  const root = tmp()
  const before = fs.existsSync(path.join(root, ".agent/shadow-observations"))
  const result = driver.applyDriver({ root, dryRun: true, seed: 0, scenarios: 2, perScenario: 2, budgetMin: 50, budgetMax: 200, budgetStep: 50 })
  assert.equal(result.ok, true)
  assert.equal(result.dry_run, true)
  assert.equal(result.files_touched.length, 0)
  assert.ok(result.would_apply_count > 0)
  assert.equal(fs.existsSync(path.join(root, ".agent/shadow-observations/.p012-audit.jsonl")), false)
  assert.equal(before, fs.existsSync(path.join(root, ".agent/shadow-observations")))
})

test("P-012 driver apply refuses without governance pair", () => {
  const root = tmp()
  const result = driver.applyDriver({ root, dryRun: false, seed: 0, scenarios: 1, perScenario: 1, budgetMin: 50, budgetMax: 200, budgetStep: 50 })
  assert.equal(result.ok, false)
  assert.equal(result.error, "governance_required")
  assert.deepEqual(result.required, ["--decision-id", "--waitpoint-id"])
  assert.equal(result.applied, false)
})

test("P-012 driver apply refuses when decision or waitpoint is missing or unreleased", () => {
  const root = tmp()
  const result = driver.applyDriver({ root, dryRun: false, decisionId: "D-DOES-NOT-EXIST-P012", waitpointId: "WP-DOES-NOT-EXIST-P012", seed: 0, scenarios: 1, perScenario: 1, budgetMin: 50, budgetMax: 200, budgetStep: 50 })
  assert.equal(result.ok, false)
  assert.equal(result.error, "decision_not_approved")
  assert.equal(result.applied, false)
})

test("P-012 driver apply writes ledger entries and audit log when governance pair is real", () => {
  const root = tmp()
  const decisionId = "D-TCP-P012-p002-driver-9666ad4f"
  const waitpointId = "WP-TCP-P012-p002-driver-9666ad4f"
  const result = driver.applyDriver({ root, dryRun: false, decisionId, waitpointId, seed: 0, scenarios: 2, perScenario: 1, budgetMin: 50, budgetMax: 200, budgetStep: 50, now: "2026-09-08T08:00:00.000Z" })
  assert.equal(result.ok, true)
  assert.equal(result.dry_run, false)
  assert.ok(result.audit.applied_count > 0)
  assert.equal(result.audit.decision_id, decisionId)
  assert.equal(result.audit.waitpoint_id, waitpointId)
  const auditFile = path.join(root, ".agent/shadow-observations/.p012-audit.jsonl")
  assert.equal(fs.existsSync(auditFile), true)
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n")
  assert.equal(lines.length, 1)
  const ledgerIndex = path.join(root, ".agent/shadow-observations/index.json")
  const idx = JSON.parse(fs.readFileSync(ledgerIndex, "utf8"))
  assert.ok(idx.entries.length > 0)
})

test("P-012 driver apply rerun is idempotent on ledger writes", () => {
  const root = tmp()
  const decisionId = "D-TCP-P012-p002-driver-9666ad4f"
  const waitpointId = "WP-TCP-P012-p002-driver-9666ad4f"
  const first = driver.applyDriver({ root, dryRun: false, decisionId, waitpointId, seed: 0, scenarios: 2, perScenario: 1, budgetMin: 50, budgetMax: 200, budgetStep: 50, now: "2026-09-08T08:00:00.000Z" })
  const second = driver.applyDriver({ root, dryRun: false, decisionId, waitpointId, seed: 0, scenarios: 2, perScenario: 1, budgetMin: 50, budgetMax: 200, budgetStep: 50, now: "2026-09-08T08:00:00.000Z" })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  const auditFile = path.join(root, ".agent/shadow-observations/.p012-audit.jsonl")
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
})
