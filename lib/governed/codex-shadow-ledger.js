"use strict"

const fs = require("node:fs")
const path = require("node:path")

const SCHEMA_VERSION = "1.0"
const LEDGER_DIR = ".agent/shadow-observations"
const INDEX_FILE = "index.json"

const ALLOWED_FIELDS = new Set(["schema_version","recorded_at","host","attempt_id","task_id","run_id","policy","stage","side_effects","persisted","policy_revision","context_index_digest","projection_digest","admission_digest","estimated_tokens","item_count","truncated","omitted","fallback_used","reason_codes"])

const FORBIDDEN_FIELDS = new Set(["task_terms","changed_files","task_title","task_description","prompt","response","transcript","messages","tool_args","tool_result","source","source_body","credentials","private_path","context_index","projection_items","selected_paths"])

function resolveLedgerRoot(root = process.cwd()) {
  return path.join(root, LEDGER_DIR)
}

function ensureLedgerRoot(root) {
  const dir = resolveLedgerRoot(root)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function safeNowIso(now = new Date()) {
  if (Number.isNaN(now.getTime())) throw new Error("invalid_clock")
  return now.toISOString()
}

function safeId(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._:@/-]+$/.test(value)) throw new Error(`invalid_${code}`)
  return value
}

function safeReasonCodes(value) {
  if (!Array.isArray(value)) throw new Error("invalid_reason_codes")
  if (value.length > 32) throw new Error("invalid_reason_codes")
  for (const entry of value) if (typeof entry !== "string" || !/^[a-z0-9_]{1,32}$/.test(entry)) throw new Error("invalid_reason_codes")
  return [...new Set(value)].sort()
}

function buildSafeRecord(observation, clock) {
  if (!observation || observation.ok !== true) throw new Error("non_observation")
  const projection = observation.projection || {}
  if (typeof projection.context_index_digest !== "string" || !/^[a-f0-9]{64}$/.test(projection.context_index_digest)) throw new Error("missing_context_index_digest")
  if (typeof projection.revision !== "string") throw new Error("missing_revision")
  for (const key of Object.keys(observation)) if (FORBIDDEN_FIELDS.has(key)) throw new Error(`forbidden_field:${key}`)
  for (const key of Object.keys(projection)) if (FORBIDDEN_FIELDS.has(key)) throw new Error(`forbidden_field:${key}`)
  const record = { schema_version: SCHEMA_VERSION, recorded_at: safeNowIso(clock), host: "codex", attempt_id: safeId(observation.attempt_id, "attempt_id"), task_id: observation.task_id === null || observation.task_id === undefined ? null : safeId(observation.task_id, "task_id"), run_id: observation.run_id === null || observation.run_id === undefined ? null : safeId(observation.run_id, "run_id"), policy: observation.policy, stage: observation.stage, side_effects: observation.side_effects, persisted: observation.persisted, policy_revision: projection.revision, context_index_digest: projection.context_index_digest, projection_digest: observation.projection_digest, admission_digest: observation.admission_digest, estimated_tokens: projection.estimated_tokens, item_count: projection.item_count, truncated: projection.truncated, omitted: projection.omitted, fallback_used: projection.fallback_used, reason_codes: safeReasonCodes(projection.reason_codes || []) }
  for (const key of Object.keys(record)) if (!ALLOWED_FIELDS.has(key)) throw new Error(`disallowed_field:${key}`)
  return record
}

function appendObservation(observation, options = {}) {
  const root = options.root || process.cwd()
  const dir = ensureLedgerRoot(root)
  const clock = options.now || new Date()
  const record = buildSafeRecord(observation, clock)
  const idemKey = `${record.attempt_id}::${record.projection_digest}`
  const indexPath = path.join(dir, INDEX_FILE)
  const writer = options.writeFile || fs.writeFileSync
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : { schema_version: SCHEMA_VERSION, observations: {}, entries: [] }
  if (index.observations[idemKey]) return { ok: true, status: "idempotent", key: idemKey }
  index.observations[idemKey] = { attempt_id: record.attempt_id, recorded_at: record.recorded_at, projection_digest: record.projection_digest }
  index.entries.push({ attempt_id: record.attempt_id, recorded_at: record.recorded_at, projection_digest: record.projection_digest, estimated_tokens: record.estimated_tokens, item_count: record.item_count, truncated: record.truncated })
  writer(indexPath, JSON.stringify({ schema_version: SCHEMA_VERSION, observations: index.observations, entries: index.entries }, null, 2) + "\n")
  writer(path.join(dir, `${record.attempt_id}-${record.projection_digest}.json`), JSON.stringify(record, null, 2) + "\n")
  return { ok: true, status: "appended", key: idemKey }
}

function throwNoPrivate(value) {
  if (!value || typeof value !== "object") return
  for (const key of Object.keys(value)) if (FORBIDDEN_FIELDS.has(key)) throw new Error(`forbidden_field:${key}`)
  throwNoPrivate(value[key])
}

module.exports = { SCHEMA_VERSION, LEDGER_DIR, ALLOWED_FIELDS, FORBIDDEN_FIELDS, appendObservation, buildSafeRecord, resolveLedgerRoot, safeNowIso, throwNoPrivate }
