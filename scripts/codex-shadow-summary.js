"use strict"

// Read-only Codex Shadow observation summary tool.
// It aggregates only the allowlisted Codex Shadow ledger records; it never
// reads the source context index, task terms, changed files, prompts, or any
// private path.

const fs = require("node:fs")
const path = require("node:path")

const LEDGER_DIR = ".agent/shadow-observations"
const INDEX_FILE = "index.json"
const ALLOWED_HOSTS = new Set(["codex"])

function resolveLedgerRoot(root = process.cwd()) {
  return path.join(root, LEDGER_DIR)
}

function loadIndex(root) {
  const dir = resolveLedgerRoot(root)
  const indexPath = path.join(dir, INDEX_FILE)
  if (!fs.existsSync(indexPath)) return { ok: false, reason: "ledger_missing", dir }
  const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"))
  const records = Array.isArray(raw.entries) ? raw.entries : []
  return { ok: true, dir, raw, records }
}

function summarize(root = process.cwd(), options = {}) {
  const loaded = loadIndex(root)
  if (!loaded.ok) return { ok: false, reason: loaded.reason, dir: loaded.dir }
  const records = loaded.records
  const byDay = new Map()
  const byDigest = new Map()
  let totalEstimated = 0
  let truncatedCount = 0
  let fallbackCount = 0
  for (const entry of records) {
    const stamp = typeof entry.recorded_at === "string" ? entry.recorded_at : null
    const day = stamp ? stamp.slice(0, 10) : "unknown"
    const bucket = byDay.get(day) || { count: 0, total_estimated_tokens: 0, truncated: 0, fallback: 0 }
    bucket.count += 1
    bucket.total_estimated_tokens += Number(entry.estimated_tokens) || 0
    if (entry.truncated) bucket.truncated += 1
    if (entry.fallback_used) bucket.fallback += 1
    byDay.set(day, bucket)
    totalEstimated += Number(entry.estimated_tokens) || 0
    if (entry.truncated) truncatedCount += 1
    if (entry.fallback_used) fallbackCount += 1
    const digest = entry.projection_digest || entry.context_index_digest
    if (digest) byDigest.set(digest, (byDigest.get(digest) || 0) + 1)
  }
  const daily = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return {
    ok: true,
    schema_version: "1.0",
    total: records.length,
    unique_attempts: new Set(records.map((r) => r.attempt_id)).size,
    unique_digests: byDigest.size,
    total_estimated_tokens: totalEstimated,
    truncated_count: truncatedCount,
    fallback_used_count: fallbackCount,
    daily,
    latest_recorded_at: records.reduce((acc, cur) => !acc || cur.recorded_at > acc ? cur.recorded_at : acc, null),
    host_filter: [...ALLOWED_HOSTS].sort(),
  }
}

function loadObservation(root, attemptId, projectionDigest) {
  const dir = resolveLedgerRoot(root)
  if (typeof attemptId !== "string" || !/^[A-Za-z0-9._:@/-]+$/.test(attemptId)) return { ok: false, error: "invalid_attempt_id" }
  if (typeof projectionDigest !== "string" || !/^[a-f0-9]{1,128}$/.test(projectionDigest)) return { ok: false, error: "invalid_projection_digest" }
  const file = path.join(dir, `${attemptId}-${projectionDigest}.json`)
  if (!fs.existsSync(file)) return { ok: false, error: "not_found" }
  const record = JSON.parse(fs.readFileSync(file, "utf8"))
  if (record.host && !ALLOWED_HOSTS.has(record.host)) return { ok: false, error: "host_not_allowed" }
  return { ok: true, record }
}

if (require.main === module) {
  const summary = summarize()
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n")
}

module.exports = { summarize, loadObservation, loadIndex, ALLOWED_HOSTS }
