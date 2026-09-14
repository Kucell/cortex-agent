"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const ledger = require("../../lib/governed/codex-shadow-ledger.js")
const summary = require("../../scripts/codex-shadow-summary.js")

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "codex-summary-")) }

function observation(attemptId, digest, tokens, day, truncated = false) {
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
    projection: { revision: "1.0", context_index_digest: "a".repeat(64), level: "minimal", estimated_tokens: tokens, truncated, omitted: 0, item_count: 3, fallback_used: false, reason_codes: ["l0_match"] }
  }
}

test("Codex Shadow summary aggregates by UTC day", () => {
  const root = tmp()
  ledger.appendObservation(observation("ocx-a", "digest-a", 12, "2026-09-07"), { root, now: new Date("2026-09-07T07:30:00Z") })
  ledger.appendObservation(observation("ocx-b", "digest-b", 18, "2026-09-07"), { root, now: new Date("2026-09-07T08:30:00Z") })
  ledger.appendObservation(observation("ocx-c", "digest-c", 30, "2026-09-08", true), { root, now: new Date("2026-09-08T07:30:00Z") })
  const s = summary.summarize(root)
  assert.equal(s.ok, true)
  assert.equal(s.total, 3)
  assert.equal(s.unique_attempts, 3)
  assert.equal(s.unique_digests, 3)
  assert.equal(s.total_estimated_tokens, 60)
  assert.equal(s.truncated_count, 1)
  assert.equal(s.daily.length, 2)
  assert.equal(s.daily[0][0], "2026-09-07")
  assert.equal(s.daily[0][1].count, 2)
  assert.equal(s.daily[1][1].truncated, 1)
})

test("Codex Shadow summary reports missing ledger", () => {
  const root = tmp()
  const s = summary.summarize(root)
  assert.equal(s.ok, false)
  assert.equal(s.reason, "ledger_missing")
})

test("Codex Shadow loadObservation rejects invalid attempt IDs", () => {
  const root = tmp()
  const r = summary.loadObservation(root, "../escape", "digest-a")
  assert.equal(r.ok, false)
})

test("Codex Shadow loadObservation rejects non-codex hosts", () => {
  const root = tmp()
  const dir = path.join(root, ".agent/shadow-observations")
  fs.mkdirSync(dir, { recursive: true })
  const unsafe = { schema_version: "1.0", recorded_at: "2026-09-09T07:30:00.000Z", host: "dsh", attempt_id: "ocx-d", task_id: null, run_id: null, policy: "P-002", stage: "shadow", side_effects: "none", persisted: false, policy_revision: "1.0", context_index_digest: "a".repeat(64), projection_digest: "d".repeat(64), admission_digest: "admission-digest-d", estimated_tokens: 12, item_count: 3, truncated: false, omitted: 0, fallback_used: false, reason_codes: ["l0_match"] }
  fs.writeFileSync(path.join(dir, "ocx-d-" + "d".repeat(64) + ".json"), JSON.stringify(unsafe, null, 2) + "\n")
  const result = summary.loadObservation(root, "ocx-d", "d".repeat(64))
  assert.equal(result.ok, false)
  assert.equal(result.error, "host_not_allowed")
})
