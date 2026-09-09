"use strict"
const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const { persistObservation } = require("../../lib/governed/codex-shadow-persist.js")

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "codex-persist-")) }

const admission = JSON.stringify({ attempt_id: "ocx-persist-001", task_terms: ["safe", "term"], changed_files: ["lib/example.js"], token_budget: 300 })

test("Codex Shadow persist stores the safe summary", () => {
  const root = tmp()
  const result = persistObservation(admission, { root })
  assert.equal(result.status, "observed")
  assert.equal(result.ledger.status, "appended")
  const ledgerDir = path.join(root, ".agent/shadow-observations")
  const files = fs.readdirSync(ledgerDir).filter((name) => name.endsWith(".json") && name !== "index.json")
  assert.ok(files.length === 1)
  const record = JSON.parse(fs.readFileSync(path.join(ledgerDir, files[0]), "utf8"))
  for (const key of Object.keys(record)) {
    assert.equal(["task_terms","changed_files","prompt"].includes(key), false, "private field " + key + " should not be persisted")
  }
})

test("Codex Shadow persist rejects unsafe admission", () => {
  const root = tmp()
  const result = persistObservation(JSON.stringify({ attempt_id: "ocx-bad", task_terms: ["x"], prompt: "secret" }), { root })
  assert.equal(result.status, "rejected")
})

test("Codex Shadow persist does not block on ledger failure", () => {
  const root = tmp()
  const result = persistObservation(admission, { root, writeFile: () => { throw new Error("disk_error") } })
  assert.equal(result.status, "ledger_failed")
})
