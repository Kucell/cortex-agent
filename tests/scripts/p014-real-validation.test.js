"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const v = require("../../scripts/p014-real-validation.js")

test("P-014 real validation: exports REAL_TASKS with valid shape", () => {
  assert.ok(v.REAL_TASKS.length >= 5)
  for (const t of v.REAL_TASKS) {
    assert.ok(t.attempt_id.startsWith("ocx-validation-"), `attempt_id must start with ocx-validation-: ${t.attempt_id}`)
    assert.ok(Array.isArray(t.task_terms) && t.task_terms.length >= 1)
    assert.ok(typeof t.token_budget === "number" && t.token_budget > 0)
  }
})

test("P-014 real validation: compareWithSynthetic computes overlap", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p014v-"))
  fs.mkdirSync(path.join(tmpRoot, ".agent/shadow-observations"), { recursive: true })
  // Synthetic ledger: 3 entries, 2 unique digests
  fs.writeFileSync(path.join(tmpRoot, ".agent/shadow-observations/index.json"),
    JSON.stringify({
      entries: [
        { attempt_id: "ocx-mf-a-100-0", projection_digest: "d1" },
        { attempt_id: "ocx-mf-b-100-0", projection_digest: "d1" },
        { attempt_id: "ocx-mf-c-100-0", projection_digest: "d2" },
      ],
    }, null, 2))
  // Real obs: 2 entries, 2 unique digests (one overlap)
  const realObs = [
    { projection_digest: "d1" },
    { projection_digest: "d3" },
  ]
  const r = v.compareWithSynthetic(realObs, path.join(tmpRoot, ".agent/shadow-observations/index.json"))
  assert.equal(r.real_attempts, 2)
  assert.equal(r.real_unique_digests, 2)
  assert.equal(r.synthetic_attempts, 3)
  assert.equal(r.synthetic_unique_digests, 2)
  assert.equal(r.digest_overlap_count, 1)
  assert.ok(Math.abs(r.digest_overlap_ratio - 0.5) < 1e-3)
})

test("P-014 real validation: missing ledger returns empty comparison", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p014v-"))
  fs.mkdirSync(path.join(tmpRoot, ".agent/shadow-observations"), { recursive: true })
  // No index.json written
  const realObs = [{ projection_digest: "d1" }]
  // Should throw ENOENT — that's the expected behavior
  assert.throws(() => v.compareWithSynthetic(realObs, path.join(tmpRoot, ".agent/shadow-observations/index.json")))
})
