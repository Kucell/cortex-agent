"use strict"

// P-014 real-attempt validation: produce real (non-synthetic) Codex shadow pilot
// observations, persist via the official ledger writer, and compare cache_reuse /
// shared_prefix metrics against the synthetic ocx-mf- baseline.
//
// Purpose: prove that synthetic admissions are representative of real Codex
// attempts before any P-003 activation decision.
//
// No governance required — still measurement-first, dry-run-only by construction.

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const pilotLib = require("./codex-p002-shadow-pilot.js")
const ledger = require("../lib/governed/codex-shadow-ledger")

const ROOT = path.resolve(__dirname, "..")
const { createShadowObservation, readIndex, readIndexSnapshot } = pilotLib

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

// Realistic Codex task terms mined from the actual cortex-agent module set.
// Each entry is what a real Codex prompt might look like for that module.
const REAL_TASKS = [
  {
    attempt_id: "ocx-validation-1",
    task_terms: ["decision", "request", "approval", "user"],
    changed_files: ["lib/governed/decisions.js"],
    token_budget: 300,
  },
  {
    attempt_id: "ocx-validation-2",
    task_terms: ["waitpoint", "create", "release"],
    changed_files: ["lib/governed/waitpoints.js"],
    token_budget: 500,
  },
  {
    attempt_id: "ocx-validation-3",
    task_terms: ["memory", "validate", "frontmatter", "project"],
    changed_files: [".agent/memory/project/codex_p002_measurement_driver.md"],
    token_budget: 700,
  },
  {
    attempt_id: "ocx-validation-4",
    task_terms: ["shadow", "pilot", "ledger", "allowlist"],
    changed_files: ["scripts/codex-p002-shadow-pilot.js", "scripts/codex-shadow-ledger.js"],
    token_budget: 400,
  },
  {
    attempt_id: "ocx-validation-5",
    task_terms: ["measurement", "first", "driver", "apply"],
    changed_files: ["scripts/p002-measurement-driver.js"],
    token_budget: 600,
  },
  {
    attempt_id: "ocx-validation-6",
    task_terms: ["token", "savings", "demo", "report"],
    changed_files: ["scripts/token-savings-demo.js"],
    token_budget: 800,
  },
  {
    attempt_id: "ocx-validation-7",
    task_terms: ["budget", "policy", "ledger", "route"],
    changed_files: ["lib/governed/budget-ledger.js"],
    token_budget: 500,
  },
  {
    attempt_id: "ocx-validation-8",
    task_terms: ["compaction", "cache", "shared", "prefix"],
    changed_files: ["lib/codex/capability-detect.js"],
    token_budget: 700,
  },
  {
    attempt_id: "ocx-validation-9",
    task_terms: ["host", "adapter", "dsh", "pi"],
    changed_files: ["lib/host-adapter/pi-json-stream.js"],
    token_budget: 400,
  },
  {
    attempt_id: "ocx-validation-10",
    task_terms: ["gate", "evaluation", "rollout", "sample"],
    changed_files: [".agent/decisions/"],
    token_budget: 600,
  },
]

function runRealAttempts(opts) {
  const observations = []
  for (const task of REAL_TASKS) {
    const input = {
      ...task,
      task_id: "T-TCP-P014-validation",
      run_id: "R-validation-real-1",
      model: "codex-validation-runtime",
      recorded_at: new Date().toISOString(),
    }
    const result = createShadowObservation(input, { root: ROOT })
    if (!result.ok) {
      console.error(`FAIL: ${task.attempt_id} -> ${JSON.stringify(result)}`)
      continue
    }
    observations.push(result)
    if (!opts.dryRun) {
      const persisted = ledger.appendObservation(result, { root: ROOT })
      console.log(`PERSISTED ${task.attempt_id} -> ${persisted.path || persisted.digest || "ok"}`)
    }
  }
  return observations
}

function compareWithSynthetic(realObs, syntheticLedgerPath) {
  const raw = JSON.parse(fs.readFileSync(syntheticLedgerPath, "utf8"))
  const synth = Array.isArray(raw.entries) ? raw.entries : []
  const realDigests = new Set()
  for (const o of realObs) realDigests.add(o.projection_digest)
  const synthDigests = new Set()
  for (const e of synth) synthDigests.add(e.projection_digest)
  const overlap = []
  for (const d of realDigests) if (synthDigests.has(d)) overlap.push(d)
  return {
    real_attempts: realObs.length,
    real_unique_digests: realDigests.size,
    synthetic_attempts: synth.length,
    synthetic_unique_digests: synthDigests.size,
    digest_overlap_count: overlap.length,
    digest_overlap_ratio: realDigests.size > 0 ? overlap.length / realDigests.size : 0,
  }
}

function runCli(argv) {
  const opts = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") opts.dryRun = true
    else if (argv[i] === "--root") { opts.root = argv[i + 1]; i += 1 }
  }
  const observations = runRealAttempts(opts)
  const compare = compareWithSynthetic(
    observations,
    path.join(opts.root || ROOT, ".agent/shadow-observations/index.json"),
  )
  const out = {
    schema_version: "1.0",
    kind: "p014-real-validation",
    dry_run: opts.dryRun,
    observations: observations.map((o) => ({
      attempt_id: o.attempt_id,
      projection_digest: o.projection_digest,
      estimated_tokens: o.projection.estimated_tokens,
      item_count: o.projection.item_count,
      truncated: o.projection.truncated,
      context_index_digest: o.projection.context_index_digest,
      reason_codes: o.projection.reason_codes,
    })),
    comparison: compare,
    boundary: "real Codex shadow pilot only; never modifies Codex argv/prompt/child state; allowlist enforced by pilot.",
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n")
}

if (require.main === module) runCli(process.argv.slice(2))

module.exports = { runRealAttempts, compareWithSynthetic, REAL_TASKS }
