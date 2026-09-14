"use strict"

// Codex Shadow observation status: prints ledger state plus clear empty-state
// guidance. It only reads .agent/shadow-observations/ -- never the source
// context index, admission payloads, or any private field.

const path = require("node:path")
const { summarize } = require("./codex-shadow-summary.js")

const LEDGER_REL = ".agent/shadow-observations"

function status(root) {
  if (root === undefined) root = process.cwd()
  const ledgerAbs = path.join(root, LEDGER_REL)
  const summary = summarize(root)
  if (!summary.ok) {
    return {
      ok: false,
      ledger_path: ledgerAbs,
      state: "empty",
      sample_count: 0,
      message: "Codex Shadow observation ledger does not exist yet. No Codex managed launch has passed --codex-shadow-admission. Token optimization remains inactive; only this measurement plane is wired.",
      how_to_start: [
        "Pass --codex-shadow-admission followed by a sanitized JSON to a governed Codex launch.",
        "JSON example: {\"attempt_id\":\"ocx-<id>\",\"task_terms\":[\"safe\",\"identifier\",\"terms\"],\"changed_files\":[\"relative/path.js\"],\"token_budget\":300}",
        "Records persist to .agent/shadow-observations/ with only allowlisted fields.",
      ],
      boundary: "no P-003/P-004 activation, no Codex prompt mutation, no multi-Host rollout Gate change.",
    }
  }
  return {
    ok: true,
    ledger_path: ledgerAbs,
    schema_version: summary.schema_version,
    sample_count: summary.total,
    unique_attempts: summary.unique_attempts,
    unique_digests: summary.unique_digests,
    total_estimated_tokens: summary.total_estimated_tokens,
    truncated_count: summary.truncated_count,
    fallback_used_count: summary.fallback_used_count,
    latest_recorded_at: summary.latest_recorded_at,
    daily: Object.fromEntries(summary.daily),
    host_filter: summary.host_filter,
    boundary: "no P-003/P-004 activation, no Codex prompt mutation, no multi-Host rollout Gate change.",
  }
}

if (require.main === module) {
  const result = status()
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}

module.exports = { status }
