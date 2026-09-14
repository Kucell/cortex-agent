"use strict"

// P-002 measurement-first driver (P-012).
// Reads .agent/context-index.json, derives deterministic synthetic ocx-mf-
// admissions from real module names + keywords, and pipes them through the
// existing codex-p002-shadow-pilot.js into the existing
// .agent/shadow-observations/ ledger. Dry-run by default. Non-dry-run
// requires both --decision-id and --waitpoint-id pointing at approved,
// released records.
//
// Hard boundaries:
//   * never spawns child processes
//   * never reads .agent/context-index.json outside --root
//   * never mutates .agent/context-index.json
//   * never invokes Codex runtime / Codex argv
//   * never introduces new fields beyond the pilot + ledger allowlist

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const SCHEMA_VERSION = "1.0"
const INDEX_FILE = ".agent/context-index.json"
const ATTEMPT_PREFIX = "ocx-mf-"
const DEFAULT_BUDGET_MIN = 50
const DEFAULT_BUDGET_MAX = 800
const DEFAULT_BUDGET_STEP = 50
const DEFAULT_PER_SCENARIO = 3
const DEFAULT_SEED = 0
const MAX_TASK_TERMS = 6
const TERM_PATTERN = /^[\p{L}\p{N}_.:/-]{1,64}$/u
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/
const RELATIVE_PATH_PATTERN = /^(?![\/])(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._@/+-]{1,240}$/

function ledgerDir(root) { return path.join(root, ".agent/shadow-observations") }
function indexPath(root) { return path.join(root, INDEX_FILE) }
function auditLogPath(root) { return path.join(ledgerDir(root), ".p012-audit.jsonl") }

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex") }

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === "--root") { opts.root = argv[i + 1]; i += 1 }
    else if (t === "--budget-min") { opts.budgetMin = Number(argv[i + 1]); i += 1 }
    else if (t === "--budget-max") { opts.budgetMax = Number(argv[i + 1]); i += 1 }
    else if (t === "--budget-step") { opts.budgetStep = Number(argv[i + 1]); i += 1 }
    else if (t === "--seed") { opts.seed = Number(argv[i + 1]); i += 1 }
    else if (t === "--scenarios") { opts.scenarios = Number(argv[i + 1]); i += 1 }
    else if (t === "--per-scenario") { opts.perScenario = Number(argv[i + 1]); i += 1 }
    else if (t === "--now") { opts.now = argv[i + 1]; i += 1 }
    else if (t === "--dry-run") { opts.dryRun = true }
    else if (t === "--apply") { opts.dryRun = false }
    else if (t === "--decision-id") { opts.decisionId = argv[i + 1]; i += 1 }
    else if (t === "--waitpoint-id") { opts.waitpointId = argv[i + 1]; i += 1 }
  }
  return opts
}

function readIndex(root) {
  const p = indexPath(root)
  if (!fs.existsSync(p)) return null
  const raw = fs.readFileSync(p, "utf8")
  const parsed = JSON.parse(raw)
  return { raw, index: parsed, digest: sha256(raw) }
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function safeInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return fallback
  return n
}

function pickFirstPath(module) {
  if (typeof module.module_path !== "string") return null
  const candidate = module.module_path.split(/[ +]/)[0].replace(/[^A-Za-z0-9._/@+-]/g, "_")
  if (!candidate || candidate.length === 0) return null
  if (!RELATIVE_PATH_PATTERN.test(candidate + "/")) return null
  return candidate + "/index.js"
}

function deriveScenarioAdmissions(scenarioIndex, module, budgetLevels, rng, perScenario) {
  const admissions = []
  const terms = Array.isArray(module.keywords) ? module.keywords.slice(0, MAX_TASK_TERMS) : []
  const fallback = [module.name || module.module || "module"]
  const safeTerms = terms.length > 0 ? terms : fallback
  const rawName = module.name || module.module || "module"
  const safeName = rawName.replace(/\//g, "-").replace(/[^A-Za-z0-9._:@-]/g, "_")
  for (let j = 0; j < perScenario; j += 1) {
    const budget = budgetLevels[j % budgetLevels.length]
    const offset = j
    const attemptId = ATTEMPT_PREFIX + safeName + "-" + budget + "-" + offset
    const chosen = safeTerms.slice(0, Math.min(safeTerms.length, 3 + offset)).filter((t) => typeof t === "string" && TERM_PATTERN.test(t))
    const changedFile = pickFirstPath(module)
    admissions.push({
      scenario_id: "scenario-" + safeName + "-" + scenarioIndex,
      admission: {
        attempt_id: attemptId,
        task_terms: chosen.length > 0 ? chosen : ["module"],
        changed_files: changedFile ? [changedFile] : [],
        token_budget: budget,
      },
    })
  }
  return admissions
}

function buildPlan(root, options) {
  const idx = readIndex(root)
  if (!idx) return { ok: false, reason: "context_index_missing", path: indexPath(root) }
  const modules = Array.isArray(idx.index.modules) ? idx.index.modules : []
  const budgetMin = safeInt(options.budgetMin, DEFAULT_BUDGET_MIN, 50, 2000)
  const budgetMax = safeInt(options.budgetMax, DEFAULT_BUDGET_MAX, budgetMin, 2000)
  const budgetStep = safeInt(options.budgetStep, DEFAULT_BUDGET_STEP, 10, 500)
  const seed = safeInt(options.seed, DEFAULT_SEED, 0, Number.MAX_SAFE_INTEGER)
  const scenarios = safeInt(options.scenarios, Math.min(modules.length, 10), 1, modules.length || 1)
  const perScenario = safeInt(options.perScenario, DEFAULT_PER_SCENARIO, 1, 12)
  const budgetLevels = []
  for (let b = budgetMin; b <= budgetMax; b += budgetStep) budgetLevels.push(b)
  if (budgetLevels.length === 0) budgetLevels.push(budgetMin)
  const rng = mulberry32(seed)
  const orderedModules = modules.slice().sort((a, b) => {
    const an = a.name || a.module || ""
    const bn = b.name || b.module || ""
    if (an < bn) return -1
    if (an > bn) return 1
    return 0
  })
  const perm = []
  for (let i = 0; i < orderedModules.length; i += 1) perm.push(i)
  for (let i = perm.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp
  }
  const chosenModules = perm.slice(0, scenarios).map((i) => orderedModules[i])
  const admissions = []
  for (let i = 0; i < chosenModules.length; i += 1) {
    const mod = chosenModules[i]
    admissions.push(...deriveScenarioAdmissions(i, mod, budgetLevels, rng, perScenario))
  }
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    index_digest: idx.digest,
    module_count: modules.length,
    scenario_count: chosenModules.length,
    per_scenario: perScenario,
    budget_levels: budgetLevels,
    seed,
    admissions,
    boundary: "read-only; never invokes Codex runtime; never writes the ledger.",
  }
}

function loadApprovedDecision(decisionId, root) {
  if (typeof decisionId !== "string" || !/^D-[A-Za-z0-9._:-]+$/.test(decisionId)) return null
  const p = path.join(root, ".agent/decisions", decisionId + ".json")
  if (!fs.existsSync(p)) return null
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    if (j && j.decision_id === decisionId && j.status === "approved") return j
  } catch (_) {}
  return null
}

function loadReleasedWaitpoint(waitpointId, root) {
  if (typeof waitpointId !== "string" || !/^WP-[A-Za-z0-9._:-]+$/.test(waitpointId)) return null
  const p = path.join(root, ".agent/waitpoints", waitpointId + ".json")
  if (!fs.existsSync(p)) return null
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    if (j && j.waitpoint_id === waitpointId && j.status === "released") return j
  } catch (_) {}
  return null
}

function applyDriver(options = {}) {
  const root = options.root || process.cwd()
  const dryRun = options.dryRun !== false
  const decisionId = options.decisionId || null
  const waitpointId = options.waitpointId || null
  const nowIso = options.now || new Date().toISOString()
  const nowDate = new Date(nowIso)
  const planObj = buildPlan(root, options)
  if (!planObj.ok) return { ok: false, reason: planObj.reason, path: planObj.path, applied: false }
  if (dryRun) {
    const perStatus = planObj.admissions.map((entry) => {
      const idem = entry.admission.attempt_id
      const idOk = typeof idem === "string" && IDENTIFIER_PATTERN.test(idem) && idem.startsWith("ocx-mf-")
      const termsOk = Array.isArray(entry.admission.task_terms) && entry.admission.task_terms.length > 0 && entry.admission.task_terms.length <= 40 && entry.admission.task_terms.every((t) => typeof t === "string" && TERM_PATTERN.test(t))
      const budgetOk = Number.isSafeInteger(entry.admission.token_budget) && entry.admission.token_budget >= 50 && entry.admission.token_budget <= 2000
      const ok = idOk && termsOk && budgetOk
      return { scenario_id: entry.scenario_id, attempt_id: entry.admission.attempt_id, status: ok ? "would_validate" : "would_reject", reject_reasons: ok ? [] : [idOk ? null : "invalid_attempt_id", termsOk ? null : "invalid_task_terms", budgetOk ? null : "invalid_token_budget"].filter(Boolean) }
    })
    return {
      ok: true,
      dry_run: true,
      schema_version: SCHEMA_VERSION,
      plan: planObj,
      per_status: perStatus,
      would_apply_count: perStatus.filter((s) => s.status === "would_validate").length,
      would_reject_count: perStatus.filter((s) => s.status === "would_reject").length,
      files_touched: [],
      boundary: "dry-run; no files were mutated; no audit lines appended.",
    }
  }
  if (!decisionId || !waitpointId) return { ok: false, error: "governance_required", required: ["--decision-id", "--waitpoint-id"], applied: false }
  const decision = loadApprovedDecision(decisionId, root)
  if (!decision) return { ok: false, error: "decision_not_approved", decision_id: decisionId, applied: false }
  const waitpoint = loadReleasedWaitpoint(waitpointId, root)
  if (!waitpoint) return { ok: false, error: "waitpoint_not_released", waitpoint_id: waitpointId, applied: false }
  if (waitpoint.decision_id !== decisionId) return { ok: false, error: "waitpoint_decision_mismatch", decision_id: decisionId, waitpoint_id: waitpointId, applied: false }
  const pilot = require("./codex-p002-shadow-pilot.js")
  const ledger = require("../lib/governed/codex-shadow-ledger.js")
  fs.mkdirSync(ledgerDir(root), { recursive: true })
  const perStatus = []
  let applied = 0
  let rejected = 0
  for (const entry of planObj.admissions) {
    const observation = pilot.createShadowObservation(entry.admission, { root })
    if (!observation.ok) {
      rejected += 1
      perStatus.push({ scenario_id: entry.scenario_id, attempt_id: entry.admission.attempt_id, status: "rejected", error: observation.error })
      continue
    }
    const write = ledger.appendObservation(observation, { root, now: nowDate })
    if (!write.ok) {
      rejected += 1
      perStatus.push({ scenario_id: entry.scenario_id, attempt_id: entry.admission.attempt_id, status: "rejected", error: write.status })
      continue
    }
    applied += 1
    perStatus.push({ scenario_id: entry.scenario_id, attempt_id: entry.admission.attempt_id, status: write.status === "appended" ? "appended" : "idempotent", key: write.key })
  }
  const auditLine = {
    schema_version: SCHEMA_VERSION,
    applied_at: nowIso,
    decision_id: decisionId,
    waitpoint_id: waitpointId,
    applied_count: applied,
    rejected_count: rejected,
    index_digest: planObj.index_digest,
    boundary: "append-only audit; P-012 measurement-first driver; never edited.",
  }
  fs.appendFileSync(auditLogPath(root), JSON.stringify(auditLine) + "\n")
  return {
    ok: true,
    dry_run: false,
    schema_version: SCHEMA_VERSION,
    plan_summary: { module_count: planObj.module_count, scenario_count: planObj.scenario_count, per_scenario: planObj.per_scenario, seed: planObj.seed },
    per_status: perStatus,
    audit: auditLine,
    files_touched: ["appended:" + auditLogPath(root)],
    boundary: "non-dry-run; governance pair verified; ledger entries are append-only and P-002/P-010 allowlisted.",
  }
}

function runCli(argv) {
  const sub = argv[0]
  const opts = parseArgs(argv.slice(1))
  let result
  if (sub === "plan") result = buildPlan(opts.root || process.cwd(), opts)
  else if (sub === "apply") {
    if (opts.apply) opts.dryRun = false
    result = applyDriver(opts)
  } else result = { ok: false, error: "unknown_subcommand", available: ["plan", "apply"] }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}

if (require.main === module) runCli(process.argv.slice(2))

module.exports = { buildPlan, applyDriver, parseArgs, SCHEMA_VERSION, ATTEMPT_PREFIX }
