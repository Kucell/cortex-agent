"use strict";

// ─── Focused Query CLI Helper (M-013 SP-006) ────────────────────────────────
//
// Pure helper that shapes the GovernedAttemptProgress V1 projection for the
// `cortex-agent query governed-attempt-progress / -diagnostics` CLI surface.
//
// The CLI delegates actual data lookup to the Management API projection
// (which reads from the reducer-derived state journal). This helper exists
// for two reasons:
//   1. Provide an offline fallback when no .agent/ is initialized
//   2. Enforce the P-005 §9 privacy invariant at the projection boundary
//      (no raw prompt/response/stdout or absolute paths)
//
// Per P-005 §8.3: "同时修复公共 task status / event list 对 Coordination
// projection 的路由, 避免消费者退回读取内部文件."

const { queryProgress, queryDiagnostics, MAX_DIAGNOSTICS } = require("../governed-attempt-progress/query.js");

// ─── Names ───────────────────────────────────────────────────────────────────

const SUPPORTED_PROJECTIONS = Object.freeze([
  "governed-attempt-progress",
  "governed-attempt-diagnostics",
]);

const CLI_USAGE = `cortex-agent query <projection> [--project <path>]

  Supported projections (P-005 / M-013):
    governed-attempt-progress     Latest GovernedAttemptProgress V1 per launchId
    governed-attempt-diagnostics  Bounded diagnostics list (≤50 entries, FIFO)`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildOfflineEnvelope(projection, summary) {
  return Object.freeze({
    ok: true,
    projection,
    offline: true,
    summary,
    note:
      "Offline fallback — Management API projection unavailable. " +
      "Run `cortex-agent init` in a project directory to enable the live projection.",
  });
}

/**
 * Validate that the requested projection is one of the SP-006 supported
 * projections. Returns null on success, or an error envelope.
 */
function validateProjection(projection) {
  if (!projection || typeof projection !== "string") {
    return {
      ok: false,
      error: {
        code: "INVALID_PROJECTION",
        message: `projection must be one of ${SUPPORTED_PROJECTIONS.join("|")} (got ${JSON.stringify(projection)})`,
      },
    };
  }
  if (!SUPPORTED_PROJECTIONS.includes(projection)) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_PROJECTION",
        message: `Unsupported projection: ${projection}`,
        details: { supported: [...SUPPORTED_PROJECTIONS] },
      },
    };
  }
  return null;
}

/**
 * Pure projection — bound a state-shaped object to the public envelope.
 * The CLI caller is responsible for loading state from the journal;
 * this helper applies the SP-006 privacy boundaries.
 */
function projectEnvelope(projection, state) {
  if (projection === "governed-attempt-progress") {
    const progress = state ? queryProgress(state) : null;
    return Object.freeze({
      ok: true,
      projection,
      offline: false,
      progress,
      summary: progress
        ? {
            evidenceLevel: progress.evidenceLevel,
            phase: progress.phase,
            lastActivityAt: progress.lastActivityAt,
            changedFileCount: progress.worktree.changedFileCount,
            validationStatus: progress.validation.status,
          }
        : { evidenceLevel: null, message: "no progress state available" },
    });
  }
  if (projection === "governed-attempt-diagnostics") {
    const diagnostics = state ? queryDiagnostics(state, { limit: MAX_DIAGNOSTICS }) : [];
    return Object.freeze({
      ok: true,
      projection,
      offline: false,
      diagnostics,
      summary: {
        count: diagnostics.length,
        bounded: MAX_DIAGNOSTICS,
      },
    });
  }
  return buildOfflineEnvelope(projection, { reason: "no_matching_projection" });
}

/**
 * Pretty-print the envelope to stdout. JSON for --json flag, plain for default.
 */
function formatEnvelope(envelope, options = {}) {
  if (options.json) {
    return JSON.stringify(envelope, null, 2) + "\n";
  }
  // Plain text format
  if (envelope.projection === "governed-attempt-progress") {
    if (!envelope.progress) {
      return `progress: (none available)\n`;
    }
    const p = envelope.progress;
    return [
      `taskId:           ${p.taskId}`,
      `operationId:      ${p.operationId}`,
      `launchId:         ${p.launchId}`,
      `attempt:          ${p.attempt}`,
      `phase:            ${p.phase}`,
      `evidenceLevel:    ${p.evidenceLevel}`,
      `lastActivityAt:   ${p.lastActivityAt}`,
      `lastProductiveAt: ${p.lastProductiveAt}`,
      `activity:         read=${p.activity.readOnlyToolCount} write=${p.activity.writeToolCount} test=${p.activity.testToolCount} failed=${p.activity.failedToolCount}`,
      `worktree:         files=${p.worktree.changedFileCount} +${p.worktree.insertions}/-${p.worktree.deletions}`,
      `validation:       status=${p.validation.status}`,
      ``,
    ].join("\n");
  }
  if (envelope.projection === "governed-attempt-diagnostics") {
    if (envelope.diagnostics.length === 0) {
      return `diagnostics: (none available)\n`;
    }
    const lines = envelope.diagnostics.map((d) =>
      `  ${d.timestamp} ${d.severity.padEnd(7)} ${d.code} — ${d.message}`
    );
    return [`diagnostics (${envelope.diagnostics.length} entries, bounded ${MAX_NOTIFICATIONS()}):`, ...lines, ``].join("\n");
  }
  return JSON.stringify(envelope, null, 2) + "\n";
}

function MAX_NOTIFICATIONS() {
  return MAX_DIAGNOSTICS;
}

module.exports = {
  buildOfflineEnvelope,
  validateProjection,
  projectEnvelope,
  formatEnvelope,
  SUPPORTED_PROJECTIONS,
  CLI_USAGE,
};