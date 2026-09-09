"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const { appendObservation, buildSafeRecord, FORBIDDEN_FIELDS, resolveLedgerRoot } = require("../../lib/governed/codex-shadow-ledger.js")

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shadow-"))
  return dir
}

function fixedClock(iso) { return new Date(iso) }

const sampleObservation = {
  ok: true,
  stage: "shadow",
  policy: "P-002",
  host: "codex",
  attempt_id: "ocx-shadow-001",
  task_id: "T-CODEX-PILOT-SHADOW-001",
  run_id: null,
  model: null,
  side_effects: "none",
  persisted: false,
  admission_digest: "admission-digest-1",
  projection_digest: "projection-digest-1",
  projection: { revision: "1.0", context_index_digest: "a".repeat(64), level: "minimal", estimated_tokens: 42, truncated: false, omitted: 0, item_count: 3, fallback_used: false, reason_codes: ["l0_match"] }
}

test("Codex Shadow ledger writes only allowlisted fields", () => {
  const root = tmp()
  const result = appendObservation(sampleObservation, { root, now: fixedClock("2026-09-07T07:30:00.000Z") })
  assert.equal(result.ok, true)
  assert.equal(result.status, "appended")
  const file = fs.readFileSync(path.join(resolveLedgerRoot(root), `ocx-shadow-001-projection-digest-1.json`), "utf8")
  const record = JSON.parse(file)
  const f = new Set(["schema_version","recorded_at","host","attempt_id","task_id","run_id","policy","stage","side_effects","persisted","policy_revision","context_index_digest","projection_digest","admission_digest","estimated_tokens","item_count","truncated","omitted","fallback_used","reason_codes"])
  for (const key of Object.keys(record)) assert.ok(f.has(key), `unexpected field ${key}`)
})

test("Codex Shadow ledger rejects forbidden field names", () => {
  for (const field of FORBIDDEN_FIELDS) {
    const unsafeObservation = { ...sampleObservation, [field]: "private" }
    let threw = false
    try { buildSafeRecord(unsafeObservation, fixedClock("2026-09-07T07:30:00.000Z")) } catch (error) { threw = String(error.message || error).includes(field) }
    assert.equal(threw, true, `forbidden field ${field} should be rejected`)
  }
})

test("Codex Shadow ledger replays idempotently on same projection digest", () => {
  const root = tmp()
  appendObservation(sampleObservation, { root, now: fixedClock("2026-09-07T07:30:00.000Z") })
  const replay = appendObservation(sampleObservation, { root, now: fixedClock("2026-09-07T07:30:05.000Z") })
  assert.equal(replay.status, "idempotent")
  const index = JSON.parse(fs.readFileSync(path.join(resolveLedgerRoot(root), "index.json"), "utf8"))
  assert.equal(index.entries.length, 1)
})

test("Codex Shadow ledger write failure does not change acceptance", () => {
  const root = tmp()
  appendObservation(sampleObservation, { root, now: fixedClock("2026-09-07T07:30:00.000Z") })
  const before = JSON.parse(fs.readFileSync(path.join(resolveLedgerRoot(root), "index.json"), "utf8"))
  const newObservation = { ...sampleObservation, attempt_id: "ocx-shadow-002", projection_digest: "projection-digest-2", projection: { ...sampleObservation.projection, context_index_digest: "b".repeat(64) } }
  const tampered = { ...newObservation, writeHook: () => { throw new Error("write_failed") } }
  let threw = false
  try { appendObservation(tampered, { root, now: fixedClock("2026-09-07T07:30:06.000Z"), writeFile: () => { throw new Error("write_failed") } }) } catch (_) { threw = true }
  assert.equal(threw, true)
  const still = JSON.parse(fs.readFileSync(path.join(resolveLedgerRoot(root), "index.json"), "utf8"))
  assert.deepEqual(still, before)
})
