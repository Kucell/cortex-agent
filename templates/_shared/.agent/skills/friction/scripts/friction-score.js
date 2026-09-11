"use strict";

// friction-score.js — non-persistent friction assessment CLI (P-003 / M-003B).
// Self-contained, zero external dependencies (ships to user projects).
// Node >=14.
// Usage:
//   node friction-score.js --project <root> [--session <S-id>] [--host-matrix dsh|pi]
// Prints the assessment JSON to stdout. Writes nothing.

const fs = require("node:fs");
const path = require("node:path");

const SIGNAL_NAMES = ["tool_denied", "tool_failed", "tool_retried", "user_interrupted", "user_correction", "lifecycle_stop"];
const SCORED = ["observed", "derived"];

// Frozen per-host matrices (must mirror HostCapabilityDescriptor.friction_signals).
const HOST_MATRICES = {
  dsh: {
    tool_denied: "not_observed",
    tool_failed: "derived",
    tool_retried: "derived",
    user_interrupted: "not_observed",
    user_correction: "not_observed",
    lifecycle_stop: "derived",
  },
  pi: {
    tool_denied: "not_supported",
    tool_failed: "not_supported",
    tool_retried: "not_supported",
    user_interrupted: "not_supported",
    user_correction: "not_supported",
    lifecycle_stop: "not_supported",
  },
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function main() {
  const root = arg("--project");
  const sessionId = arg("--session");
  const hostArg = arg("--host-matrix");
  if (!root) {
    console.error("usage: friction-score.js --project <root> [--session <S-id>] [--host-matrix dsh|pi]");
    process.exit(2);
  }
  const matrix = hostArg ? HOST_MATRICES[hostArg] : undefined;
  if (hostArg && !matrix) {
    console.error("unknown host-matrix: " + hostArg + " (expected dsh|pi)");
    process.exit(2);
  }
  const file = path.join(root, ".agent", "runtime-evidence", "friction", "signals.jsonl");
  const events = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (sessionId && ev.session_id !== sessionId) continue;
        events.push(ev);
      } catch (_) { /* skip malformed */ }
    }
  }
  const bySignal = {};
  let total = 0;
  for (const s of SIGNAL_NAMES) bySignal[s] = { count: 0, observability: matrix ? matrix[s] : null };
  for (const ev of events) {
    if (!ev || typeof ev.type !== "string" || bySignal[ev.type] === undefined) continue;
    const c = Number.isInteger(ev.count) && ev.count > 0 ? ev.count : 0;
    bySignal[ev.type].count += c;
    total += c;
  }
  const coverage = { observed: [], derived: [], not_observed: [], not_supported: [], absent: [] };
  for (const s of SIGNAL_NAMES) {
    const level = matrix ? matrix[s] : undefined;
    if (level === undefined || level === null) coverage.absent.push(s);
    else if (coverage[level] !== undefined) coverage[level].push(s);
    else coverage.absent.push(s);
  }
  let score = 0;
  for (const ev of events) {
    if (SCORED.indexOf(ev.observability) < 0) continue;
    const c = Number.isInteger(ev.count) && ev.count > 0 ? ev.count : 0;
    score += c;
  }
  const supports = coverage.observed.length > 0 || coverage.derived.length > 0;
  let recommendation = "none";
  if (score > 0) recommendation = supports ? "suggest" : "consider";
  const signals = {};
  for (const s of SIGNAL_NAMES) signals[s] = { count: bySignal[s].count, observability: bySignal[s].observability };
  process.stdout.write(JSON.stringify({ session_id: sessionId || null, total, signals, coverage, score, recommendation, host_matrix: hostArg || null }, null, 2) + "\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + "\n");
  process.exit(1);
}
