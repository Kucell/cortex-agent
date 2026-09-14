"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const ledger = require("../../lib/governed/codex-shadow-ledger.js")
const retention = require("../../scripts/codex-shadow-retention.js")

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-retention-"))
  fs.mkdirSync(path.join(dir, ".agent/decisions"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".agent/waitpoints"), { recursive: true })
  const decisionSrc = path.join(__dirname, "../../.agent/decisions/D-TCP-P011-shadow-retention-554fe6db.json")
  const waitpointSrc = path.join(__dirname, "../../.agent/waitpoints/WP-TCP-P011-shadow-retention-554fe6db.json")
  if (fs.existsSync(decisionSrc)) fs.copyFileSync(decisionSrc, path.join(dir, ".agent/decisions/D-TCP-P011-shadow-retention-554fe6db.json"))
  if (fs.existsSync(waitpointSrc)) fs.copyFileSync(waitpointSrc, path.join(dir, ".agent/waitpoints/WP-TCP-P011-shadow-retention-554fe6db.json"))
  return dir
}

function observation(attemptId, digest, when) {
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
    projection: { revision: "1.0", context_index_digest: "a".repeat(64), level: "minimal", estimated_tokens: 10, truncated: false, omitted: 0, item_count: 3, fallback_used: false, reason_codes: ["l0_match"] },
  }
}

function seedRecord(root, attemptId, digest, when) {
  ledger.appendObservation(observation(attemptId, digest, when), { root, now: when })
}

test("Codex Shadow retention plan refuses when ledger is missing", () => {
  const root = tmp()
  const result = retention.plan({ root })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "ledger_missing")
})

test("Codex Shadow retention plan classifies soft and hard aged records", () => {
  const root = tmp()
  const now = new Date("2026-09-08T08:00:00Z")
  const young = new Date("2026-09-01T08:00:00Z")
  const soft = new Date("2026-08-20T08:00:00Z")
  const hard = new Date("2026-08-01T08:00:00Z")
  seedRecord(root, "ocx-young", "y".repeat(64), young)
  seedRecord(root, "ocx-soft", "s".repeat(64), soft)
  seedRecord(root, "ocx-hard", "h".repeat(64), hard)
  const result = retention.plan({ root, softAgeDays: 14, hardAgeDays: 30, now: now.toISOString() })
  assert.equal(result.ok, true)
  assert.equal(result.would_archive_count, 1)
  assert.equal(result.would_delete_count, 1)
  assert.equal(result.kept_count, 1)
  assert.equal(result.decisions.length, 2)
  assert.equal(result.boundary.includes("read-only"), true)
})

test("Codex Shadow retention plan honors cohort pinning", () => {
  const root = tmp()
  const now = new Date("2026-09-08T08:00:00Z")
  const pinned = new Date("2026-08-01T08:00:00Z")
  seedRecord(root, "ocx-pinned", "p".repeat(64), pinned)
  const result = retention.plan({ root, softAgeDays: 14, hardAgeDays: 30, pinnedCohortFromUtc: "2026-07-25", pinnedCohortToUtc: "2026-08-31", now: now.toISOString() })
  assert.equal(result.ok, true)
  assert.equal(result.would_archive_count, 0)
  assert.equal(result.would_delete_count, 0)
  assert.equal(result.kept_count, 1)
})

test("Codex Shadow retention dry-run never mutates files", () => {
  const root = tmp()
  const now = new Date("2026-09-08T08:00:00Z")
  const old = new Date("2026-08-01T08:00:00Z")
  seedRecord(root, "ocx-old", "o".repeat(64), old)
  const before = fs.readFileSync(path.join(root, ".agent/shadow-observations/index.json"), "utf8")
  const result = retention.applyRetention({ root, dryRun: true, now: now.toISOString() })
  assert.equal(result.ok, true)
  assert.equal(result.dry_run, true)
  assert.equal(result.files_touched.length, 0)
  assert.equal(result.boundary.includes("dry-run"), true)
  const after = fs.readFileSync(path.join(root, ".agent/shadow-observations/index.json"), "utf8")
  assert.equal(before, after)
  assert.equal(fs.existsSync(path.join(root, ".agent/shadow-observations/.retention-audit.jsonl")), false)
})

test("Codex Shadow retention apply refuses without governance pair", () => {
  const root = tmp()
  const now = new Date("2026-09-08T08:00:00Z")
  const old = new Date("2026-08-01T08:00:00Z")
  seedRecord(root, "ocx-old", "o".repeat(64), old)
  const result = retention.applyRetention({ root, dryRun: false, now: now.toISOString() })
  assert.equal(result.ok, false)
  assert.equal(result.error, "governance_required")
  assert.deepEqual(result.required, ["--decision-id", "--waitpoint-id"])
  assert.equal(result.applied, false)
})

test("Codex Shadow retention apply refuses when decision or waitpoint is missing or unreleased", () => {
  const root = tmp()
  const now = new Date("2026-09-08T08:00:00Z")
  const old = new Date("2026-08-01T08:00:00Z")
  seedRecord(root, "ocx-old", "o".repeat(64), old)
  const decisionId = "D-DOES-NOT-EXIST-RETENTION"
  const waitpointId = "WP-DOES-NOT-EXIST-RETENTION"
  const result = retention.applyRetention({ root, dryRun: false, decisionId, waitpointId, now: now.toISOString() })
  assert.equal(result.ok, false)
  assert.equal(result.error, "decision_not_approved")
  assert.equal(result.decision_id, decisionId)
  assert.equal(result.applied, false)
})

test("Codex Shadow retention apply honors real approved decision and waitpoint", () => {
  const root = tmp()
  const now = new Date("2026-09-08T08:00:00Z")
  const old = new Date("2026-08-01T08:00:00Z")
  seedRecord(root, "ocx-old", "o".repeat(64), old)
  const decisionId = "D-TCP-P011-shadow-retention-554fe6db"
  const waitpointId = "WP-TCP-P011-shadow-retention-554fe6db"
  const result = retention.applyRetention({ root, dryRun: false, decisionId, waitpointId, now: now.toISOString() })
  assert.equal(result.ok, true)
  assert.equal(result.dry_run, false)
  assert.ok(Array.isArray(result.files_touched))
  assert.equal(result.audit.decision_id, decisionId)
  assert.equal(result.audit.waitpoint_id, waitpointId)
  assert.deepEqual(result.audit.removed_digests, ["o".repeat(64)])
  assert.ok(result.audit.after_count < result.audit.before_count)
  assert.equal(fs.existsSync(path.join(root, ".agent/shadow-observations/.retention-audit.jsonl")), true)
  assert.equal(fs.existsSync(path.join(root, ".agent/shadow-observations/ocx-old-" + "o".repeat(64) + ".json")), false)
})

test("Codex Shadow retention apply is idempotent on rerun", () => {
  const root = tmp()
  const now = new Date("2026-09-08T08:00:00Z")
  const old = new Date("2026-08-01T08:00:00Z")
  seedRecord(root, "ocx-old", "i".repeat(64), old)
  const decisionId = "D-TCP-P011-shadow-retention-554fe6db"
  const waitpointId = "WP-TCP-P011-shadow-retention-554fe6db"
  const first = retention.applyRetention({ root, dryRun: false, decisionId, waitpointId, now: now.toISOString() })
  const second = retention.applyRetention({ root, dryRun: false, decisionId, waitpointId, now: now.toISOString() })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(second.audit.removed_digests, [])
  assert.equal(second.audit.after_count, second.audit.before_count)
})
