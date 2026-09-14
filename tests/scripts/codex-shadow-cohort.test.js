"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const ledger = require("../../lib/governed/codex-shadow-ledger.js")
const cohort = require("../../scripts/codex-shadow-cohort.js")

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "codex-cohort-")) }

function observation(attemptId, digest, tokens, when, truncated) {
  return {
    ok: true,
    stage: "shadow",
    policy: "P-002",
    host: "codex",
    attempt_id: attemptId,
    task_id: null,
    run_id: null,
    model: null,
    side_effects: "none",
    persisted: false,
    admission_digest: "admission-" + digest,
    projection_digest: digest,
    projection: { revision: "1.0", context_index_digest: "a".repeat(64), level: "minimal", estimated_tokens: tokens, truncated: !!truncated, omitted: 0, item_count: 3, fallback_used: false, reason_codes: ["l0_match"] },
  }
}

function seedDay(root, day, count, when) {
  for (let j = 0; j < count; j += 1) {
    const attempt = "ocx-" + day + "-" + j
    const digest = "digest-" + day + "-" + j
    ledger.appendObservation(observation(attempt, digest, 10, when), { root, now: when })
  }
}

test("Codex Shadow cohort reports empty state honestly", () => {
  const root = tmp()
  const result = cohort.freezeCohort({ root, fromUtc: "2026-09-03", toUtc: "2026-09-09" })
  assert.equal(result.ok, true)
  assert.equal(result.total_samples, 0)
  assert.equal(result.criteria.window.days, 7)
  assert.equal(result.gate.passed, false)
  assert.equal(result.gate.reason, "coverage_days_short")
  assert.equal(result.gate.counted_days, 0)
})

test("Codex Shadow cohort passes the gate when 7 days hit threshold", () => {
  const root = tmp()
  for (let i = 0; i < 7; i += 1) {
    const day = "2026-09-0" + (3 + i)
    seedDay(root, day, 100, new Date(day + "T08:00:00Z"))
  }
  const result = cohort.freezeCohort({ root, fromUtc: "2026-09-03", toUtc: "2026-09-09", minPerDay: 100 })
  assert.equal(result.gate.passed, true)
  assert.equal(result.gate.counted_days, 7)
  assert.equal(result.gate.max_zero_run, 0)
  assert.equal(result.gate.reason, "ok")
})

test("Codex Shadow cohort flags zero_run_too_long", () => {
  const root = tmp()
  const windowStart = "2026-09-01"
  const windowEnd = "2026-09-10"
  const startDay = 1
  for (let i = 0; i < 10; i += 1) {
    const dayNum = startDay + i
    const day = dayNum < 10 ? "2026-09-0" + dayNum : "2026-09-" + dayNum
    const isZeroDay = i === 4 || i === 5 || i === 6
    seedDay(root, day, isZeroDay ? 0 : 100, new Date(day + "T08:00:00Z"))
  }
  const result = cohort.freezeCohort({ root, fromUtc: windowStart, toUtc: windowEnd, minPerDay: 100 })
  assert.equal(result.gate.passed, false)
  assert.equal(result.gate.reason, "zero_run_too_long")
  assert.ok(result.gate.max_zero_run > 2)
  assert.equal(result.gate.counted_days, 7)
})

test("Codex Shadow cohort prefers zero_run_too_long over coverage_days_short", () => {
  const root = tmp()
  const windowStart = "2026-09-01"
  const windowEnd = "2026-09-10"
  const startDay = 1
  for (let i = 0; i < 10; i += 1) {
    const dayNum = startDay + i
    const day = dayNum < 10 ? "2026-09-0" + dayNum : "2026-09-" + dayNum
    const isZeroDay = i === 3 || i === 4 || i === 5 || i === 6
    seedDay(root, day, isZeroDay ? 0 : 100, new Date(day + "T08:00:00Z"))
  }
  const result = cohort.freezeCohort({ root, fromUtc: windowStart, toUtc: windowEnd, minPerDay: 100 })
  assert.equal(result.gate.passed, false)
  assert.equal(result.gate.reason, "zero_run_too_long")
  assert.ok(result.gate.counted_days < 7)
  assert.ok(result.gate.max_zero_run > 2)
})

test("Codex Shadow cohort digest is deterministic", () => {
  const root = tmp()
  seedDay(root, "2026-09-05", 2, new Date("2026-09-05T08:00:00Z"))
  const a = cohort.freezeCohort({ root, fromUtc: "2026-09-03", toUtc: "2026-09-09" })
  const b = cohort.freezeCohort({ root, fromUtc: "2026-09-03", toUtc: "2026-09-09" })
  assert.equal(a.cohort_digest, b.cohort_digest)
  assert.equal(a.cohort_digest.length, 64)
})

test("Codex Shadow cohort digest changes when samples change", () => {
  const root = tmp()
  const before = cohort.freezeCohort({ root, fromUtc: "2026-09-03", toUtc: "2026-09-09" })
  seedDay(root, "2026-09-05", 1, new Date("2026-09-05T08:00:00Z"))
  const after = cohort.freezeCohort({ root, fromUtc: "2026-09-03", toUtc: "2026-09-09" })
  assert.notEqual(before.cohort_digest, after.cohort_digest)
})
