"use strict"

// Codex Shadow observation cohort freezer.
// It only reads .agent/shadow-observations/ and outputs a deterministic cohort
// digest plus a current Gate evaluation. It never touches Codex runtime
// payload, prompt, transcript, source, credentials, or any private path.

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { loadIndex, ALLOWED_HOSTS } = require("./codex-shadow-summary.js")

const SCHEMA_VERSION = "1.0"
const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_MIN_PER_DAY = 100
const ALLOWED_HOST_LIST = [...ALLOWED_HOSTS].sort()

function utcDay(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function parseUtcDate(value, fallback) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback
  const d = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? fallback : d
}

function listUtcDays(fromDate, toDate) {
  const days = []
  for (let cursor = new Date(fromDate.getTime()); cursor.getTime() <= toDate.getTime(); cursor = new Date(cursor.getTime() + 86400000)) {
    days.push(utcDay(cursor))
  }
  return days
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function freezeCohort(options = {}) {
  const root = options.root || process.cwd()
  const today = options.now ? new Date(options.now) : new Date()
  const toDate = parseUtcDate(options.toUtc, today)
  const fromDate = options.fromUtc ? new Date(`${options.fromUtc}T00:00:00.000Z`) : new Date(toDate.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 86400000)
  const windowDays = listUtcDays(fromDate, toDate)
  const minPerDay = Number.isInteger(options.minPerDay) && options.minPerDay > 0 ? options.minPerDay : DEFAULT_MIN_PER_DAY
  const loaded = loadIndex(root)
  const records = loaded.ok ? loaded.records : []
  const byDay = new Map()
  for (const day of windowDays) byDay.set(day, { day, count: 0, total_estimated_tokens: 0, truncated: 0, fallback: 0 })
  for (const entry of records) {
    const day = utcDay(new Date(entry.recorded_at))
    if (!byDay.has(day)) continue
    const bucket = byDay.get(day)
    bucket.count += 1
    bucket.total_estimated_tokens += Number(entry.estimated_tokens) || 0
    if (entry.truncated) bucket.truncated += 1
    if (entry.fallback_used) bucket.fallback += 1
  }
  const daily = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  let zeroRun = 0
  let maxZeroRun = 0
  for (const bucket of daily) {
    if (bucket.count === 0) { zeroRun += 1; if (zeroRun > maxZeroRun) maxZeroRun = zeroRun } else zeroRun = 0
  }
  const countedDays = daily.filter((d) => d.count >= minPerDay).length
  const totalSamples = daily.reduce((acc, b) => acc + b.count, 0)
  const criteria = {
    schema_version: SCHEMA_VERSION,
    host_filter: ALLOWED_HOST_LIST,
    window: { from_utc: utcDay(fromDate), to_utc: utcDay(toDate), days: windowDays.length },
    min_per_day: minPerDay,
    policy: "P-002",
  }
  const digestInput = stableStringify({ criteria, daily, total_samples: totalSamples })
  const cohortDigest = sha256Hex(digestInput)
  const gate = {
    passed: countedDays >= 7 && maxZeroRun <= 2,
    counted_days: countedDays,
    required_counted_days: 7,
    max_zero_run: maxZeroRun,
    allowed_max_zero_run: 2,
    min_per_day: minPerDay,
    reason: totalSamples === 0 ? "coverage_days_short" : maxZeroRun > 2 ? "zero_run_too_long" : countedDays < 7 ? "coverage_days_short" : "ok",
  }
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    criteria,
    daily,
    total_samples: totalSamples,
    cohort_digest: cohortDigest,
    gate,
    boundary: "read-only; never mutates ledger; never touches Codex runtime payload.",
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--from-utc") { opts.fromUtc = args[i + 1]; i += 1 } else if (token === "--to-utc") { opts.toUtc = args[i + 1]; i += 1 } else if (token === "--min-per-day") { opts.minPerDay = Number(args[i + 1]); i += 1 } else if (token === "--root") { opts.root = args[i + 1]; i += 1 }
  }
  process.stdout.write(JSON.stringify(freezeCohort(opts), null, 2) + "\n")
}

module.exports = { freezeCohort, SCHEMA_VERSION, DEFAULT_WINDOW_DAYS, DEFAULT_MIN_PER_DAY, ALLOWED_HOST_LIST }
