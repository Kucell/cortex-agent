"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const m = require("../../scripts/p014-p003-measurement.js")

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p014-"))
  fs.mkdirSync(path.join(dir, ".agent/shadow-observations"), { recursive: true })
  return dir
}
function writeEntries(root, entries) {
  fs.writeFileSync(path.join(root, ".agent/shadow-observations/index.json"),
    JSON.stringify({ schema_version: "1.0", observations: {}, entries }, null, 2))
}
function aid(module, budget, offset) { return `ocx-mf-${module}-${budget}-${offset}` }

test("P-014 refuses on missing ledger", () => {
  const root = fakeRoot()
  const r = m.analyze(root)
  assert.equal(r.ok, false)
  assert.equal(r.reason, "ledger_missing")
})

test("P-014 parseAttempt extracts module/budget/offset", () => {
  const p = m.parseAttempt("ocx-mf-alpha-100-0")
  assert.deepEqual(p, { module: "alpha", budget: 100, offset: 0 })
  assert.equal(m.parseAttempt("malformed"), null)
  assert.equal(m.parseAttempt(null), null)
})

test("P-014 compaction measurement classifies soft vs hard triggers", () => {
  const out = m.measureCompaction([
    { estimated_tokens: 100000, truncated: false },
    { estimated_tokens: 250000, truncated: false },
    { estimated_tokens: 500000, truncated: false },
  ], { soft_input_tokens: 200000, hard_input_tokens: 400000 })
  assert.equal(out.soft_trigger_count, 1)
  assert.equal(out.hard_trigger_count, 1)
  assert.ok(Math.abs(out.soft_trigger_rate - 1/3) < 1e-3)
  assert.ok(Math.abs(out.hard_trigger_rate - 1/3) < 1e-3)
  // total_before = 850000; total_after = ~30% = 255000; reduction = ~70%
  assert.equal(out.total_before, 850000)
  assert.equal(out.token_reduction_estimate, 0.7)
})

test("P-014 cache reuse measures digest re-occurrence", () => {
  const out = m.measureCacheReuse([
    { attempt_id: aid("a", 100, 0), projection_digest: "d1" },
    { attempt_id: aid("a", 100, 1), projection_digest: "d1" },
    { attempt_id: aid("b", 200, 0), projection_digest: "d2" },
    { attempt_id: aid("b", 200, 1), projection_digest: "d1" },
  ])
  assert.equal(out.total_admissions, 4)
  assert.equal(out.unique_projection_digests, 2)
  assert.equal(out.cache_reuse_ratio, 0.5) // (4-2)/4
  const aMod = out.per_module.find((x) => x.module === "a")
  assert.equal(aMod.admissions, 2)
  assert.equal(aMod.unique_digests, 1)
  assert.equal(aMod.hit_rate, 0.5)
})

test("P-014 shared prefix volume ranks by reuse", () => {
  const out = m.measureSharedPrefixVolume([
    { projection_digest: "d1", estimated_tokens: 30 },
    { projection_digest: "d1", estimated_tokens: 30 },
    { projection_digest: "d1", estimated_tokens: 30 },
    { projection_digest: "d2", estimated_tokens: 50 },
  ])
  // totalBytes = 30*3 + 50*1 = 140
  // shared = (3-1)*30 + (1-1)*50 = 60
  // ratio = 60/140 ≈ 0.43
  assert.equal(out.total_projection_tokens, 140)
  assert.equal(out.shared_projection_tokens, 60)
  assert.ok(Math.abs(out.shared_prefix_ratio - 0.4286) < 1e-3)
  assert.equal(out.top_digests[0].projection_digest, "d1")
  assert.equal(out.top_digests[0].admissions, 3)
})

test("P-014 analyze integrates all 3 metrics on full ledger", () => {
  const root = fakeRoot()
  writeEntries(root, [
    { attempt_id: aid("alpha", 100, 0), projection_digest: "d1", estimated_tokens: 30, truncated: true },
    { attempt_id: aid("alpha", 100, 1), projection_digest: "d1", estimated_tokens: 28, truncated: false },
    { attempt_id: aid("beta", 200, 0), projection_digest: "d2", estimated_tokens: 40, truncated: true },
  ])
  const r = m.analyze(root)
  assert.equal(r.ok, true)
  assert.equal(r.sample_count, 3)
  assert.ok(r.compaction)
  assert.ok(r.cache)
  assert.ok(r.shared_prefix)
  assert.ok(Math.abs(r.cache.cache_reuse_ratio - 1/3) < 1e-3)
})
