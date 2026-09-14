"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const ledger = require("../../lib/governed/codex-shadow-ledger.js")
const summary = require("../../scripts/codex-shadow-summary.js")
const status = require("../../scripts/codex-shadow-status.js")

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-")) }

function observation(attemptId, digest, tokens, day) {
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
    projection: { revision: "1.0", context_index_digest: "a".repeat(64), level: "minimal", estimated_tokens: tokens, truncated: false, omitted: 0, item_count: 3, fallback_used: false, reason_codes: ["l0_match"] },
  }
}

test("Codex Shadow status reports empty ledger honestly", () => {
  const root = tmp()
  const result = status.status(root)
  assert.equal(result.ok, false)
  assert.equal(result.state, "empty")
  assert.equal(result.sample_count, 0)
  assert.equal(typeof result.message, "string")
  assert.ok(Array.isArray(result.how_to_start))
  assert.ok(result.how_to_start.length >= 3)
  assert.equal(typeof result.boundary, "string")
})

test("Codex Shadow status reports populated ledger with deterministic daily breakdown", () => {
  const root = tmp()
  ledger.appendObservation(observation("ocx-1", "digest-1", 10, "2026-09-07"), { root, now: new Date("2026-09-07T07:30:00Z") })
  ledger.appendObservation(observation("ocx-2", "digest-2", 12, "2026-09-07"), { root, now: new Date("2026-09-07T08:30:00Z") })
  ledger.appendObservation(observation("ocx-3", "digest-3", 14, "2026-09-08"), { root, now: new Date("2026-09-08T07:30:00Z") })
  const result = status.status(root)
  assert.equal(result.ok, true)
  assert.equal(result.sample_count, 3)
  assert.equal(result.unique_attempts, 3)
  assert.equal(result.unique_digests, 3)
  assert.equal(result.total_estimated_tokens, 36)
  assert.deepEqual(Object.keys(result.daily), ["2026-09-07", "2026-09-08"])
  assert.deepEqual(result.daily["2026-09-07"].count, 2)
  assert.equal(result.latest_recorded_at, "2026-09-08T07:30:00.000Z")
})

test("Codex Shadow status output is JSON-stable across reruns", () => {
  const root = tmp()
  ledger.appendObservation(observation("ocx-stable", "digest-stable", 5, "2026-09-09"), { root, now: new Date("2026-09-09T07:30:00Z") })
  const a = JSON.stringify(status.status(root))
  const b = JSON.stringify(status.status(root))
  assert.equal(a, b)
})
