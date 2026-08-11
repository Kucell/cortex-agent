"use strict";

// ─── GovernedAttemptProgress Query (M-013 SP-002) ────────────────────────────
//
// Focused query surface for GovernedAttemptProgress V1. Pure functions:
// callers feed the reducer-derived state; the query surface formats /
// filters / bounds it. No I/O.
//
// Two projections:
//   - queryProgress(state) — returns the progress summary for focused query
//   - queryDiagnostics(state) — returns bounded diagnostics list
//
// Both projections are read-only and do not mutate the input state. They
// follow the P-005 §9 privacy rules: never include raw prompt/response/stdout
// or absolute paths.

const MAX_DIAGNOSTICS = 50;

// ─── Progress projection ─────────────────────────────────────────────────────

/**
 * Project a GovernedAttemptProgress V1 state to the focused query payload.
 *
 * @param {object} state  - reducer output (frozen)
 * @returns {object} projection: {taskId, operationId, launchId, attempt,
 *   phase, evidenceLevel, lastActivityAt, lastProductiveAt,
 *   activity: {4 counters}, worktree: {6 fields}, validation: {3 fields}}
 */
function queryProgress(state) {
  if (!state || typeof state !== "object") {
    throw new Error("queryProgress: state must be a non-null object");
  }
  return Object.freeze({
    taskId: state.taskId,
    operationId: state.operationId,
    launchId: state.launchId,
    attempt: state.attempt,
    phase: state.phase,
    evidenceLevel: state.evidenceLevel,
    lastActivityAt: state.lastActivityAt,
    lastProductiveAt: state.lastProductiveAt,
    activity: Object.freeze({
      readOnlyToolCount: state.activity?.readOnlyToolCount || 0,
      writeToolCount: state.activity?.writeToolCount || 0,
      testToolCount: state.activity?.testToolCount || 0,
      failedToolCount: state.activity?.failedToolCount || 0,
    }),
    worktree: Object.freeze({
      baselineHead: state.worktree?.baselineHead || "unknown",
      statusDigest: state.worktree?.statusDigest || "unknown",
      diffDigest: state.worktree?.diffDigest || "unknown",
      changedFileCount: state.worktree?.changedFileCount || 0,
      insertions: state.worktree?.insertions || 0,
      deletions: state.worktree?.deletions || 0,
    }),
    validation: Object.freeze({
      lastCommandId: state.validation?.lastCommandId || null,
      status: state.validation?.status || "not_run",
      evidenceRef: state.validation?.evidenceRef || null,
    }),
  });
}

// ─── Diagnostics projection ──────────────────────────────────────────────────

/**
 * Project a state's diagnostics list to the focused query payload.
 *
 * @param {object} state      - reducer output (frozen)
 * @param {object} options    - { limit }
 * @returns {array} diagnostics[] bounded to MAX_DIAGNOSTICS by default
 */
function queryDiagnostics(state, options = {}) {
  if (!state || typeof state !== "object") return [];
  const list = Array.isArray(state.diagnostics) ? state.diagnostics : [];
  const limit = options.limit && options.limit > 0
    ? Math.min(options.limit, MAX_DIAGNOSTICS)
    : MAX_DIAGNOSTICS;
  return Object.freeze(list.slice(-limit).map((d) => Object.freeze({
    timestamp: d.timestamp,
    code: d.code,
    message: d.message,
    severity: d.severity,
  })));
}

module.exports = {
  queryProgress,
  queryDiagnostics,
  MAX_DIAGNOSTICS,
};