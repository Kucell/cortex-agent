"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const analysis = require("../../scripts/p013-budget-analysis.js")

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p013-"))
  fs.mkdirSync(path.join(dir, ".agent/shadow-observations"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".agent/context-index.json"), JSON.stringify({
    modules: [
      { name: "alpha", l0_tokens: 100 },
      { name: "beta", l0_tokens: 200 },
      { name: "gamma", l0_tokens: 150 },
    ],
  }))
  return dir
}

function writeEntries(root, entries) {
  fs.writeFileSync(path.join(root, ".agent/shadow-observations/index.json"), JSON.stringify({
    schema_version: "1.0",
    observations: {},
    entries,
  }, null, 2))
}

// Helper: build an ocx-mf- attempt_id from module/budget/offset
function aid(module, budget, offset) { return `ocx-mf-${module}-${budget}-${offset}` }

test("P-013 analysis refuses when ledger missing", () => {
  const root = fakeRoot()
  const idxPath = path.join(root, ".agent/shadow-observations/index.json")
  if (fs.existsSync(idxPath)) fs.rmSync(idxPath)
  const result = analysis.analyze(root)
  assert.equal(result.ok, false)
  assert.equal(result.reason, "ledger_missing")
})

test("P-013 parseAttempt extracts module/budget/offset", () => {
  const parsed = analysis.parseAttempt("ocx-mf-alpha-100-0")
  assert.deepEqual(parsed, { module: "alpha", budget: 100, offset: 0 })
})

test("P-013 analysis produces per-budget aggregates from attempt_id", () => {
  const root = fakeRoot()
  writeEntries(root, [
    { attempt_id: aid("alpha", 100, 0), estimated_tokens: 80, item_count: 1, truncated: false },
    { attempt_id: aid("alpha", 100, 1), estimated_tokens: 90, item_count: 1, truncated: true },
    { attempt_id: aid("beta", 200, 0), estimated_tokens: 150, item_count: 2, truncated: false },
    { attempt_id: aid("beta", 200, 1), estimated_tokens: 170, item_count: 2, truncated: false },
  ])
  const result = analysis.analyze(root)
  assert.equal(result.ok, true)
  assert.equal(result.sample_count, 4)
  assert.equal(result.parsed_count, 4)
  assert.equal(result.per_budget.length, 2)
  const b100 = result.per_budget.find((b) => b.budget === 100)
  assert.equal(b100.count, 2)
  assert.equal(b100.meanEstimated, 85)
  assert.equal(b100.truncatedCount, 1)
  assert.equal(b100.truncatedRate, 0.5)
  assert.equal(b100.meanItemCount, 1)
})

test("P-013 analysis derives sweet-spot budget", () => {
  const root = fakeRoot()
  writeEntries(root, [
    { attempt_id: aid("alpha", 100, 0), estimated_tokens: 80, truncated: true },
    { attempt_id: aid("alpha", 200, 0), estimated_tokens: 150, truncated: true },
    { attempt_id: aid("alpha", 400, 0), estimated_tokens: 350, truncated: false },
    { attempt_id: aid("alpha", 400, 1), estimated_tokens: 360, truncated: false },
  ])
  const result = analysis.analyze(root)
  assert.equal(result.sweet.sweet_spot_budget, 400)
})

test("P-013 analysis computes savings estimate vs full L0 dump", () => {
  const root = fakeRoot()
  writeEntries(root, [
    { attempt_id: aid("alpha", 100, 0), estimated_tokens: 80, truncated: false },
    { attempt_id: aid("beta", 100, 0), estimated_tokens: 80, truncated: false },
    { attempt_id: aid("gamma", 100, 0), estimated_tokens: 80, truncated: false },
  ])
  const result = analysis.analyze(root)
  assert.ok(result.savings_estimate)
  // 3 modules with l0 tokens 100+200+150 = 450 total_l0_tokens
  // baseline = sample_count (3) * total_l0_tokens (450) = 1350
  // optimized = sum of estimated_tokens = 80 * 3 = 240
  // saving = 1110, ratio = 0.8222
  assert.equal(result.savings_estimate.baseline_total_estimated_tokens, 1350)
  assert.equal(result.savings_estimate.optimized_total_estimated_tokens, 240)
  assert.equal(result.savings_estimate.saving_tokens, 1110)
})

test("P-013 analysis handles missing context-index gracefully", () => {
  const root = fakeRoot()
  fs.unlinkSync(path.join(root, ".agent/context-index.json"))
  writeEntries(root, [
    { attempt_id: aid("alpha", 100, 0), estimated_tokens: 80, truncated: false },
  ])
  const result = analysis.analyze(root)
  assert.equal(result.ok, true)
  assert.equal(result.savings_estimate, null)
})

test("P-013 analysis skips malformed attempt_id entries without crashing", () => {
  const root = fakeRoot()
  writeEntries(root, [
    { attempt_id: aid("alpha", 100, 0), estimated_tokens: 80, truncated: false },
    { attempt_id: "malformed-id", estimated_tokens: 50, truncated: false },
    { attempt_id: null, estimated_tokens: 30, truncated: false },
  ])
  const result = analysis.analyze(root)
  assert.equal(result.ok, true)
  assert.equal(result.sample_count, 3)
  assert.equal(result.parsed_count, 1)
  assert.equal(result.per_budget.length, 1)
  assert.equal(result.per_module.length, 1)
})
