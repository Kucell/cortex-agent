"use strict"

// Codex Shadow observation retention. Implements P-011:
//   - soft_age_days (default 14): eligible for archival (.archive/ subdir).
//   - hard_age_days (default 30): eligible for hard delete (record file + index entry).
//   - cohort pinning: records inside any pinned cohort window are exempt.
//   - digest pinning: every apply appends digests to pinned_digests.txt.
//   - audit log: .retention-audit.jsonl, append-only.
//   - apply requires --dry-run=false plus --decision-id and --waitpoint-id that
//     match approved governance records; otherwise it returns ok:false.
// Never touches Codex runtime payload, prompt, model, transcript, source body,
// credentials, MS-001 usage ledger, or any field outside the ledger allowlist.

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const LEDGER_DIR = ".agent/shadow-observations"
const INDEX_FILE = "index.json"
const ARCHIVE_DIR = ".archive"
const PINNED_DIGESTS_FILE = "pinned_digests.txt"
const AUDIT_LOG_FILE = ".retention-audit.jsonl"
const SCHEMA_VERSION = "1.0"
const DEFAULT_SOFT_AGE_DAYS = 14
const DEFAULT_HARD_AGE_DAYS = 30

function ledgerDir(root) { return path.join(root || process.cwd(), LEDGER_DIR) }
function archiveDir(root) { return path.join(ledgerDir(root), ARCHIVE_DIR) }
function indexPath(root) { return path.join(ledgerDir(root), INDEX_FILE) }
function pinnedDigestsPath(root) { return path.join(ledgerDir(root), PINNED_DIGESTS_FILE) }
function auditLogPath(root) { return path.join(ledgerDir(root), AUDIT_LOG_FILE) }

function safeInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

function safeDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return value
}

function safeDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return null
  return value
}

function parseIso(value, fallback) {
  if (typeof value !== "string") return fallback
  const t = Date.parse(value)
  return Number.isNaN(t) ? fallback : t
}

function loadIndex(root) {
  const p = indexPath(root)
  if (!fs.existsSync(p)) return { ok: false, reason: "ledger_missing", path: p }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"))
  const entries = Array.isArray(raw.entries) ? raw.entries : []
  return { ok: true, raw, entries, path: p }
}

function loadApprovedDecision(decisionId, root) {
  if (typeof decisionId !== "string" || !/^D-[A-Za-z0-9._:-]+$/.test(decisionId)) return null
  const p = path.join(root || process.cwd(), ".agent/decisions", decisionId + ".json")
  if (!fs.existsSync(p)) return null
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    if (j && j.decision_id === decisionId && j.status === "approved") return j
  } catch (_) {}
  return null
}

function loadReleasedWaitpoint(waitpointId, root) {
  if (typeof waitpointId !== "string" || !/^WP-[A-Za-z0-9._:-]+$/.test(waitpointId)) return null
  const p = path.join(root || process.cwd(), ".agent/waitpoints", waitpointId + ".json")
  if (!fs.existsSync(p)) return null
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    if (j && j.waitpoint_id === waitpointId && j.status === "released") return j
  } catch (_) {}
  return null
}

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}"
  }
  return JSON.stringify(value)
}

function sha256Hex(value) { return crypto.createHash("sha256").update(value).digest("hex") }

function resolveCriteria(options) {
  const soft = safeInt(options.softAgeDays, DEFAULT_SOFT_AGE_DAYS)
  const hard = safeInt(options.hardAgeDays, DEFAULT_HARD_AGE_DAYS)
  if (hard < soft) throw new Error("hard_age_days_must_be_gte_soft_age_days")
  const pinnedFrom = safeDay(options.pinnedCohortFromUtc)
  const pinnedTo = safeDay(options.pinnedCohortToUtc)
  const pinnedDigest = safeDigest(options.pinnedCohortDigest)
  return { soft, hard, pinnedFrom, pinnedTo, pinnedDigest }
}

function classifyEntries(entries, criteria, nowMs) {
  const decisions = []
  for (const entry of entries) {
    const t = parseIso(entry.recorded_at, null)
    if (t === null) continue
    const ageDays = (nowMs - t) / 86400000
    const day = entry.recorded_at.slice(0, 10)
    const inPinnedWindow = criteria.pinnedFrom && criteria.pinnedTo && day >= criteria.pinnedFrom && day <= criteria.pinnedTo
    if (inPinnedWindow) continue
    if (ageDays >= criteria.hard) decisions.push({ entry, action: "delete", age_days: ageDays })
    else if (ageDays >= criteria.soft) decisions.push({ entry, action: "archive", age_days: ageDays })
  }
  return decisions
}

function computePlan(entries, criteria, nowMs) {
  const decisions = classifyEntries(entries, criteria, nowMs)
  const archive = decisions.filter((d) => d.action === "archive").length
  const del = decisions.filter((d) => d.action === "delete").length
  const kept = entries.length - archive - del
  const planDigest = sha256Hex(stableStringify({ criteria: { soft_age_days: criteria.soft, hard_age_days: criteria.hard, pinned_from_utc: criteria.pinnedFrom, pinned_to_utc: criteria.pinnedTo, pinned_digest: criteria.pinnedDigest }, archive, delete: del, kept, total: entries.length }))
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    criteria: { soft_age_days: criteria.soft, hard_age_days: criteria.hard, pinned_from_utc: criteria.pinnedFrom, pinned_to_utc: criteria.pinnedTo, pinned_digest: criteria.pinnedDigest },
    before_count: entries.length,
    would_archive_count: archive,
    would_delete_count: del,
    kept_count: kept,
    decisions,
    plan_digest: planDigest,
    boundary: "read-only; never mutates files unless --apply is supplied.",
  }
}

function plan(options = {}) {
  const root = options.root || process.cwd()
  const now = parseIso(options.now, Date.now())
  const criteria = resolveCriteria(options)
  const idx = loadIndex(root)
  if (!idx.ok) return { ok: false, reason: idx.reason, path: idx.path }
  const planObj = computePlan(idx.entries, criteria, now)
  if (!options.apply) planObj.boundary = "read-only; never mutates files; never deletes inside pinned cohort windows."
  return planObj
}

function appendPinnedDigests(root, removedDigests) {
  if (removedDigests.length === 0) return
  const p = pinnedDigestsPath(root)
  const line = removedDigests.join("\n") + "\n"
  if (fs.existsSync(p)) fs.appendFileSync(p, line)
  else fs.writeFileSync(p, line, { mode: 0o600 })
}

function appendAuditLine(root, line) {
  const file = auditLogPath(root)
  fs.mkdirSync(ledgerDir(root), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(line) + "\n")
}

function applyRetention(options = {}) {
  const root = options.root || process.cwd()
  const dryRun = options.dryRun !== false
  const decisionId = options.decisionId || null
  const waitpointId = options.waitpointId || null
  const nowIso = options.now || new Date().toISOString()
  const nowMs = parseIso(nowIso, Date.now())
  const criteria = resolveCriteria(options)
  const idx = loadIndex(root)
  if (!idx.ok) return { ok: false, reason: idx.reason, path: idx.path }
  const planObj = computePlan(idx.entries, criteria, nowMs)
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      schema_version: SCHEMA_VERSION,
      plan: planObj,
      files_touched: [],
      boundary: "dry-run; no files were mutated.",
    }
  }
  if (!decisionId || !waitpointId) return { ok: false, error: "governance_required", required: ["--decision-id", "--waitpoint-id"], applied: false }
  const decision = loadApprovedDecision(decisionId, root)
  if (!decision) return { ok: false, error: "decision_not_approved", decision_id: decisionId, applied: false }
  const waitpoint = loadReleasedWaitpoint(waitpointId, root)
  if (!waitpoint) return { ok: false, error: "waitpoint_not_released", waitpoint_id: waitpointId, applied: false }
  if (waitpoint.decision_id !== decisionId) return { ok: false, error: "waitpoint_decision_mismatch", decision_id: decisionId, waitpoint_id: waitpointId, applied: false }
  const filesTouched = []
  const archiveRoot = archiveDir(root)
  fs.mkdirSync(archiveRoot, { recursive: true })
  const keptEntries = []
  const keptObservations = { ...idx.raw.observations }
  const removedDigests = []
  const keptDigests = []
  const classifyMap = new Map()
  for (const decision of planObj.decisions) classifyMap.set(decision.entry.projection_digest, decision.action)
  for (const entry of idx.entries) {
    const action = classifyMap.get(entry.projection_digest)
    if (!action) {
      keptEntries.push(entry)
      keptDigests.push(entry.projection_digest)
      continue
    }
    removedDigests.push(entry.projection_digest)
    delete keptObservations[
      entry.attempt_id + "::" + entry.projection_digest
    ]
    const fileName = entry.attempt_id + "-" + entry.projection_digest + ".json"
    const src = path.join(ledgerDir(root), fileName)
    if (action === "archive") {
      const dst = path.join(archiveRoot, fileName)
      try {
        fs.renameSync(src, dst)
        filesTouched.push(src + " -> " + dst)
      } catch (_) {
        filesTouched.push("archive_failed:" + fileName)
        keptEntries.push(entry)
        keptDigests.push(entry.projection_digest)
        removedDigests.pop()
      }
    } else if (action === "delete") {
      try {
        fs.unlinkSync(src)
        filesTouched.push("deleted:" + src)
      } catch (_) {
        filesTouched.push("delete_failed:" + fileName)
        keptEntries.push(entry)
        keptDigests.push(entry.projection_digest)
        removedDigests.pop()
      }
    }
  }
  fs.writeFileSync(idx.path, JSON.stringify({ schema_version: SCHEMA_VERSION, observations: keptObservations, entries: keptEntries }, null, 2) + "\n")
  filesTouched.push("updated:" + idx.path)
  appendPinnedDigests(root, removedDigests)
  const auditLine = {
    schema_version: SCHEMA_VERSION,
    applied_at: nowIso,
    decision_id: decisionId,
    waitpoint_id: waitpointId,
    soft_age_days: criteria.soft,
    hard_age_days: criteria.hard,
    before_count: planObj.before_count,
    after_count: keptEntries.length,
    removed_digests: removedDigests,
    kept_digests: keptDigests,
    pinned_digests: [criteria.pinnedDigest].filter(Boolean),
    plan_digest: planObj.plan_digest,
    boundary: "append-only audit; never edited.",
  }
  appendAuditLine(root, auditLine)
  filesTouched.push("appended:" + auditLogPath(root))
  return {
    ok: true,
    dry_run: false,
    schema_version: SCHEMA_VERSION,
    plan: planObj,
    audit: auditLine,
    files_touched: filesTouched,
    boundary: "non-dry-run; governance pair verified; cohort pinning enforced; digest pinning and audit log appended.",
  }
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === "--soft-age-days") { opts.softAgeDays = Number(argv[i + 1]); i += 1 }
    else if (t === "--hard-age-days") { opts.hardAgeDays = Number(argv[i + 1]); i += 1 }
    else if (t === "--pinned-cohort-from-utc") { opts.pinnedCohortFromUtc = argv[i + 1]; i += 1 }
    else if (t === "--pinned-cohort-to-utc") { opts.pinnedCohortToUtc = argv[i + 1]; i += 1 }
    else if (t === "--pinned-cohort-digest") { opts.pinnedCohortDigest = argv[i + 1]; i += 1 }
    else if (t === "--now") { opts.now = argv[i + 1]; i += 1 }
    else if (t === "--root") { opts.root = argv[i + 1]; i += 1 }
    else if (t === "--apply") { opts.apply = true }
    else if (t === "--dry-run") { opts.dryRun = true }
    else if (t === "--decision-id") { opts.decisionId = argv[i + 1]; i += 1 }
    else if (t === "--waitpoint-id") { opts.waitpointId = argv[i + 1]; i += 1 }
  }
  return opts
}

function runCli(argv) {
  const subcommand = argv[0]
  const opts = parseArgs(argv.slice(1))
  let result
  if (subcommand === "plan") {
    result = plan({ ...opts, apply: false })
  } else if (subcommand === "apply") {
    if (opts.apply) opts.dryRun = false
    result = applyRetention(opts)
  } else {
    result = { ok: false, error: "unknown_subcommand", available: ["plan", "apply"] }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}

if (require.main === module) runCli(process.argv.slice(2))

module.exports = { plan, applyRetention, parseArgs, resolveCriteria, computePlan, loadApprovedDecision, loadReleasedWaitpoint, SCHEMA_VERSION, DEFAULT_SOFT_AGE_DAYS, DEFAULT_HARD_AGE_DAYS, LEDGER_DIR, INDEX_FILE, ARCHIVE_DIR, PINNED_DIGESTS_FILE, AUDIT_LOG_FILE }
