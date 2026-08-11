"use strict";

// ─── Read-only GovernedAttemptProgress Projection (M-013 SP-006 / VC-010) ───
//
// Two projections:
//   - governed-attempt-progress: latest GovernedAttemptProgress V1 per launchId
//   - governed-attempt-diagnostics: bounded diagnostics list (≤50 entries, FIFO)
//
// Both projections are pure, read-only. They NEVER mutate state, NEVER
// invoke runs upsert / decisions resolve / inbox send / any mutation primitive.
//
// Privacy (P-005 §9): no raw prompt/response/stdout or absolute paths. Only
// bounded metadata + sha256 digests flow back to consumers.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = "1.0";
const MAX_DIAGNOSTICS = 50;

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ─── State journal discovery ────────────────────────────────────────────────
//
// The reducer emits frozen GovernedAttemptProgress V1 records to .agent/
// progress journal. The default location is `<agentRoot>/progress/<launchId>.json`,
// but the projection is path-agnostic: it accepts any path resolvable through
// the agentRoot.

function listProgressEntries(agentRoot) {
  const dir = path.join(agentRoot, "progress");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => safeReadJson(path.join(dir, name)))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.lastActivityAt || 0) - Date.parse(a.lastActivityAt || 0));
}

// ─── Progress projection ───────────────────────────────────────────────────

function queryGovernedAttemptProgress(agentRoot) {
  const entries = listProgressEntries(agentRoot);
  const latest = entries[0] || null;
  return {
    _meta: { generated_at: nowIso(), schema_version: SCHEMA_VERSION },
    progress: latest,
    summary: latest
      ? {
          evidenceLevel: latest.evidenceLevel,
          phase: latest.phase,
          lastActivityAt: latest.lastActivityAt,
          changedFileCount: latest.worktree?.changedFileCount || 0,
          validationStatus: latest.validation?.status || "not_run",
        }
      : null,
    count: entries.length,
  };
}

// ─── Diagnostics projection ────────────────────────────────────────────────

function queryGovernedAttemptDiagnostics(agentRoot) {
  const entries = listProgressEntries(agentRoot);
  const latest = entries[0] || null;
  const diagnostics = latest && Array.isArray(latest.diagnostics)
    ? latest.diagnostics.slice(-MAX_DIAGNOSTICS)
    : [];
  return {
    _meta: { generated_at: nowIso(), schema_version: SCHEMA_VERSION },
    diagnostics,
    summary: {
      count: diagnostics.length,
      bounded: MAX_DIAGNOSTICS,
    },
  };
}

module.exports = {
  queryGovernedAttemptProgress,
  queryGovernedAttemptDiagnostics,
  MAX_DIAGNOSTICS,
  SCHEMA_VERSION,
};