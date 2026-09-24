"use strict"

// P-013 measurement-first budget analysis.
// Reads `.agent/shadow-observations/` ledger (append-only, allowlisted
// fields) and derives actionable token-budget recommendations:
//   - per-budget aggregate: count, mean estimated_tokens, max budget, hit_rate
//   - per-module aggregate: count, mean estimated_tokens, mean projected size
//   - sweet-spot curve: coverage vs budget, the point where truncation stops
//   - savings estimate: synthetic minimal-context total vs all-modules L0 sum
// Pure read-only. Never mutates ledger, never spawns processes, never touches
// Codex runtime.

const fs = require("node:fs")
const path = require("node:path")

const SCHEMA_VERSION = "1.0"
const LEDGER_DIR = ".agent/shadow-observations"
const INDEX_FILE = "index.json"
const ATTEMPT_PREFIX = "ocx-mf-"
// attempt_id pattern: ocx-mf-<safeName>-<budget>-<offset>
// safeName may contain `-` characters from sanitization (originally `/` -> `-`).
const ATTEMPT_RE = /^ocx-mf-(.+)-(\d+)-(\d+)$/

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
  const m = ATTEMPT_RE.exec(attemptId)
  if (!m) return null
  return { module: m[1], budget: Number(m[2]), offset: Number(m[3]) }
}

function safeInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

function enrichEntries(entries) {
  // Decorate entries with parsed module + budget from attempt_id.
  // Falls back to null if attempt_id is malformed.
  return entries.map((e) => {
    const parsed = parseAttempt(e.attempt_id)
    return {
      ...e,
      parsed_module: parsed ? parsed.module : null,
      parsed_budget: parsed ? parsed.budget : null,
    }
  })
}

function summarizePerBudget(entries) {
  const buckets = new Map()
  for (const e of entries) {
    const b = e.parsed_budget
    if (b === null) continue
    if (buckets.has(b)) {
      const v = buckets.get(b)
      v.count += 1
      v.totalEstimated += safeInt(e.estimated_tokens, 0)
      v.totalItemCount += safeInt(e.item_count, 0)
      v.truncatedCount += e.truncated === true ? 1 : 0
    } else {
      buckets.set(b, {
        budget: b,
        count: 1,
        totalEstimated: safeInt(e.estimated_tokens, 0),
        totalItemCount: safeInt(e.item_count, 0),
        truncatedCount: e.truncated === true ? 1 : 0,
      })
    }
  }
  const out = Array.from(buckets.values()).sort((a, b) => a.budget - b.budget)
  for (const v of out) {
    v.meanEstimated = v.count > 0 ? Math.round(v.totalEstimated / v.count) : 0
    v.meanItemCount = v.count > 0 ? Math.round((v.totalItemCount / v.count) * 100) / 100 : 0
    v.truncatedRate = v.count > 0 ? Math.round((v.truncatedCount / v.count) * 1000) / 1000 : 0
  }
  return out
}

function summarizePerModule(entries) {
  const buckets = new Map()
  for (const e of entries) {
    const m = e.parsed_module
    if (!m) continue
    if (buckets.has(m)) {
      const v = buckets.get(m)
      v.count += 1
      v.totalEstimated += safeInt(e.estimated_tokens, 0)
      v.totalItemCount += safeInt(e.item_count, 0)
    } else {
      buckets.set(m, {
        module: m,
        count: 1,
        totalEstimated: safeInt(e.estimated_tokens, 0),
        totalItemCount: safeInt(e.item_count, 0),
      })
    }
  }
  const out = Array.from(buckets.values()).sort((a, b) => a.module.localeCompare(b.module))
  for (const v of out) {
    v.meanEstimated = v.count > 0 ? Math.round(v.totalEstimated / v.count) : 0
    v.meanItemCount = v.count > 0 ? Math.round((v.totalItemCount / v.count) * 100) / 100 : 0
  }
  return out
}

function sweetSpotCurve(perBudget) {
  // Coverage = (1 - truncatedRate). Sweet spot: smallest budget where coverage >= 0.95.
  let sweetSpot = null
  for (const v of perBudget) {
    if (v.truncatedRate <= 0.05) {
      sweetSpot = v.budget
      break
    }
  }
  if (sweetSpot === null && perBudget.length > 0) sweetSpot = perBudget[perBudget.length - 1].budget
  return {
    sweet_spot_budget: sweetSpot,
    curve: perBudget.map((v) => ({ budget: v.budget, coverage: 1 - v.truncatedRate, mean_estimated: v.meanEstimated, mean_item_count: v.meanItemCount })),
  }
}

function estimateFullDumpCost(root) {
  // Read the original context-index.json to estimate what full-L0 cost
  // would be (sum of all modules` l0_tokens field). Returns null if file
  // missing or fields absent.
  const p = path.join(root || process.cwd(), ".agent/context-index.json")
  if (!fs.existsSync(p)) return null
  let raw
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")) } catch (_) { return null }
  const modules = Array.isArray(raw.modules) ? raw.modules : []
  let total = 0
  let withL0 = 0
  for (const m of modules) {
    const t = Number(m.l0_tokens)
    if (Number.isFinite(t) && t > 0) { total += t; withL0 += 1 }
  }
  if (withL0 === 0) return null
  return { total_l0_tokens: total, modules_with_l0: withL0, modules_total: modules.length }
}

function totalMinimalCost(entries) {
  let sum = 0
  for (const e of entries) sum += safeInt(e.estimated_tokens, 0)
  return sum
}

function analyze(root) {
  const idx = loadIndex(root)
  if (!idx.ok) return idx
  const enriched = enrichEntries(idx.entries)
  const perBudget = summarizePerBudget(enriched)
  const perModule = summarizePerModule(enriched)
  const sweet = sweetSpotCurve(perBudget)
  const full = estimateFullDumpCost(root)
  const minimalTotal = totalMinimalCost(enriched)

  let savings = null
  if (full && minimalTotal > 0 && full.total_l0_tokens > 0) {
    // baseline = sample_count * total_l0_tokens (each sample would otherwise dump all L0)
    const baseline = enriched.length * full.total_l0_tokens
    const optimized = minimalTotal
    savings = {
      baseline_total_estimated_tokens: baseline,
      optimized_total_estimated_tokens: optimized,
      saving_tokens: baseline - optimized,
      saving_ratio: Math.round(((baseline - optimized) / baseline) * 10000) / 10000,
      caveat: "baseline uses sample_count * sum(l0_tokens) — upper bound. Real savings depend on real Codex prompt payload, not just projection.",
    }
  }

  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    sample_count: enriched.length,
    parsed_count: enriched.filter((e) => e.parsed_budget !== null).length,
    unique_budgets: perBudget.length,
    unique_modules: perModule.length,
    per_budget: perBudget,
    per_module: perModule,
    sweet: sweet,
    savings_estimate: savings,
    boundary: "read-only; never mutates ledger; never touches Codex runtime payload.",
  }
}

function runCli(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") { opts.root = argv[i + 1]; i += 1 }
  }
  const result = analyze(opts.root || process.cwd())
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}

if (require.main === module) runCli(process.argv.slice(2))

module.exports = { analyze, parseAttempt, enrichEntries, summarizePerBudget, summarizePerModule, sweetSpotCurve, estimateFullDumpCost, totalMinimalCost, SCHEMA_VERSION }
