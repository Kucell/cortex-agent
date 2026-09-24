"use strict"

// P-014 measurement: P-003 (compaction / cache / shared prefix) read-only analysis
// on the existing `ocx-mf-` ledger. No governance required.
//
// Metrics derived:
//   - cmp_trigger_rate     (proportion of admissions that would have triggered
//                          compaction given a sample soft_input_tokens threshold)
//   - cmp_token_reduction_estimate (projected drop from "minimal" level to "abstract")
//   - cache_reuse_ratio    (unique projection_digest per module vs total admissions)
//   - cache_per_module_hit_rate
//   - shared_prefix_volume (cross-admission share of projection_digest occurrences)

const fs = require("node:fs")
const path = require("node:path")

const SCHEMA_VERSION = "1.0"
const LEDGER_DIR = ".agent/shadow-observations"
const INDEX_FILE = "index.json"

function ledgerDir(root) { return path.join(root || process.cwd(), LEDGER_DIR) }
function indexPath(root) { return path.join(ledgerDir(root), INDEX_FILE) }

function loadIndex(root) {
  const p = indexPath(root)
  if (!fs.existsSync(p)) return { ok: false, reason: "ledger_missing", path: p }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"))
  const entries = Array.isArray(raw.entries) ? raw.entries : []
  return { ok: true, raw, entries, path: p }
}

function parseAttempt(attemptId) {
  if (typeof attemptId !== "string") return null
  const m = /^ocx-mf-(.+)-(\d+)-(\d+)$/.exec(attemptId)
  if (!m) return null
  return { module: m[1], budget: Number(m[2]), offset: Number(m[3]) }
}

// === Compaction measurement ===
// A "compaction trigger" is approximated by: estimated_tokens for the module
// exceeds `soft_input_tokens` (caller-provided) OR the module has > N items
// in the projection (admission truncated). We do NOT actually trigger compaction.
function measureCompaction(entries, opts) {
  const soft = Number(opts && opts.soft_input_tokens) || 200000
  const hard = Number(opts && opts.hard_input_tokens) || 400000
  let softCount = 0
  let hardCount = 0
  let totalBefore = 0
  let totalAfter = 0
  const reasonCounts = {}
  for (const e of entries) {
    const est = Number(e.estimated_tokens) || 0
    totalBefore += est
    // Project: after compaction to "abstract" level (~30% retention per P-003 spec)
    const after = Math.max(0, Math.round(est * 0.3))
    totalAfter += after
    if (est > hard) {
      hardCount += 1
      reasonCounts.hard_exceeded = (reasonCounts.hard_exceeded || 0) + 1
    } else if (est > soft) {
      softCount += 1
      reasonCounts.soft_exceeded = (reasonCounts.soft_exceeded || 0) + 1
    }
    if (e.truncated === true) {
      reasonCounts.admission_truncated = (reasonCounts.admission_truncated || 0) + 1
    }
  }
  const reduction = totalBefore > 0 ? Math.round(((totalBefore - totalAfter) / totalBefore) * 10000) / 10000 : 0
  return {
    soft_input_tokens: soft,
    hard_input_tokens: hard,
    soft_trigger_count: softCount,
    hard_trigger_count: hardCount,
    soft_trigger_rate: entries.length > 0 ? Math.round((softCount / entries.length) * 10000) / 10000 : 0,
    hard_trigger_rate: entries.length > 0 ? Math.round((hardCount / entries.length) * 10000) / 10000 : 0,
    total_before: totalBefore,
    total_after_estimated: totalAfter,
    token_reduction_estimate: reduction,
    reason_counts: reasonCounts,
  }
}

// === Cache reuse measurement ===
function measureCacheReuse(entries) {
  const digestCounts = new Map()
  const moduleDigestCounts = new Map() // module -> Map(digest -> count)
  for (const e of entries) {
    const d = e.projection_digest
    if (!d) continue
    const parsed = parseAttempt(e.attempt_id)
    digestCounts.set(d, (digestCounts.get(d) || 0) + 1)
    if (parsed) {
      let m = moduleDigestCounts.get(parsed.module)
      if (!m) { m = new Map(); moduleDigestCounts.set(parsed.module, m) }
      m.set(d, (m.get(d) || 0) + 1)
    }
  }
  const total = entries.length
  const unique = digestCounts.size
  const reuse = total > 0 ? Math.round(((total - unique) / total) * 10000) / 10000 : 0
  const perModule = []
  for (const [module, m] of moduleDigestCounts.entries()) {
    const mTotal = 0
    let sum = 0
    for (const c of m.values()) sum += c
    perModule.push({
      module,
      admissions: sum,
      unique_digests: m.size,
      hit_rate: sum > 0 ? Math.round(((sum - m.size) / sum) * 10000) / 10000 : 0,
    })
  }
  perModule.sort((a, b) => a.module.localeCompare(b.module))
  return {
    total_admissions: total,
    unique_projection_digests: unique,
    cache_reuse_ratio: reuse,
    per_module: perModule,
  }
}

// === Shared prefix volume ===
// Approximation: for each digest, count cross-admission occurrences. The more
// shared occurrences, the larger the "shared prefix volume" benefit would be if
// the host used prompt caching.
function measureSharedPrefixVolume(entries) {
  const digestAdmissions = new Map()
  for (const e of entries) {
    const d = e.projection_digest
    if (!d) continue
    if (!digestAdmissions.has(d)) digestAdmissions.set(d, [])
    digestAdmissions.get(d).push(e)
  }
  let totalSharedBytes = 0
  let totalBytes = 0
  const ranked = []
  for (const [d, list] of digestAdmissions.entries()) {
    // Project shared prefix benefit = (list.length - 1) * projection size
    const projectionBytes = list.reduce((acc, e) => acc + (Number(e.estimated_tokens) || 0), 0) / list.length
    const sharedBytes = projectionBytes * (list.length - 1)
    totalSharedBytes += sharedBytes
    totalBytes += projectionBytes * list.length
    ranked.push({ projection_digest: d, admissions: list.length, shared_projection_tokens: Math.round(sharedBytes) })
  }
  ranked.sort((a, b) => b.shared_projection_tokens - a.shared_projection_tokens)
  const ratio = totalBytes > 0 ? Math.round((totalSharedBytes / totalBytes) * 10000) / 10000 : 0
  return {
    total_projection_tokens: Math.round(totalBytes),
    shared_projection_tokens: Math.round(totalSharedBytes),
    shared_prefix_ratio: ratio,
    top_digests: ranked.slice(0, 10),
  }
}

function analyze(root, opts) {
  const idx = loadIndex(root)
  if (!idx.ok) return idx
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    sample_count: idx.entries.length,
    compaction: measureCompaction(idx.entries, opts),
    cache: measureCacheReuse(idx.entries),
    shared_prefix: measureSharedPrefixVolume(idx.entries),
    boundary: "read-only; never mutates ledger; never triggers compaction or cache; never touches Codex runtime.",
  }
}

function runCli(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (k === "--root") { opts.root = argv[i + 1]; i += 1 }
    else if (k === "--soft-input-tokens") { opts.soft_input_tokens = Number(argv[i + 1]); i += 1 }
    else if (k === "--hard-input-tokens") { opts.hard_input_tokens = Number(argv[i + 1]); i += 1 }
  }
  const out = analyze(opts.root || process.cwd(), opts)
  process.stdout.write(JSON.stringify(out, null, 2) + "\n")
}

if (require.main === module) runCli(process.argv.slice(2))

module.exports = { analyze, parseAttempt, measureCompaction, measureCacheReuse, measureSharedPrefixVolume, SCHEMA_VERSION }
