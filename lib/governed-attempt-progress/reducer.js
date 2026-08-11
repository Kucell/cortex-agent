"use strict";

// ─── GovernedAttemptProgress Reducer (P-005 §3.1 + SP-002) ───────────────────
//
// Pure deterministic reducer that computes the GovernedAttemptProgress V1
// state from a stream of normalized events (heartbeat, host_event,
// worktree_probe, validation_probe).
//
// Promotion rules (P-005 §3.1, monotonic — never regress):
//   alive      → active      host_event yields 1+ turn/tool event
//   active     → productive  worktree_probe diff OR validation receipt (artifact)
//   productive → verified    validation_probe status=passed
//   any        → blocked     failedToolCount > 0 (phase hint; level stays)
//
// The reducer is a *pure* function:
//   - No I/O, no fs, no network, no child processes
//   - Identical inputs always produce identical outputs (deterministic)
//   - The output is a frozen GovernedAttemptProgress V1 object

const crypto = require("node:crypto");

// ─── Evidence level ordering (monotonic promotion) ──────────────────────────
const LEVEL_ORDER = Object.freeze({
  alive: 0,
  active: 1,
  productive: 2,
  verified: 3,
});

const PHASE_ORDER = Object.freeze([
  "observing",
  "editing",
  "testing",
  "ready",
  "blocked",
  "failed",
]);

const SCHEMA_VERSION = "1.0";
const MAX_DIAGNOSTICS = 50;
const BLOCKED_PRODUCTIVE_GRACE_MS = 5 * 60 * 1000; // 5 min

// ─── Public reducer function ─────────────────────────────────────────────────

/**
 * Compute the next GovernedAttemptProgress V1 state.
 *
 * @param {object} state   - Previous state (or initial state from makeInitialState)
 * @param {object} events  - Normalized events: {heartbeat?, host_event?, worktree_probe?, validation_probe?}
 * @returns {object} GovernedAttemptProgress V1 (frozen)
 */
function reduce(state, events) {
  if (!events || typeof events !== "object") {
    throw new Error("reducer: events must be a non-null object");
  }
  const prev = state || makeInitialState({ heartbeat: { timestamp: nowIso(events) } });
  const next = { ...prev };

  // Always reconcile timestamps
  const heartbeatTs = extractTimestamp(events.heartbeat);
  const hostEventTs = extractTimestamp(events.host_event);
  const probeTs = extractTimestamp(events.worktree_probe);
  const validationTs = extractTimestamp(events.validation_probe);
  const eventTs = maxIso([heartbeatTs, hostEventTs, probeTs, validationTs].filter(Boolean));
  next.lastActivityAt = eventTs || prev.lastActivityAt;

  // Activity counters — accumulate from host_event
  if (events.host_event) {
    next.activity = {
      readOnlyToolCount: prev.activity.readOnlyToolCount + (events.host_event.readOnly ? 1 : 0),
      writeToolCount: prev.activity.writeToolCount + (!events.host_event.readOnly && events.host_event.category === "write" ? 1 : 0),
      testToolCount: prev.activity.testToolCount + (events.host_event.category === "test" ? 1 : 0),
      failedToolCount: prev.activity.failedToolCount + (events.host_event.success === false ? 1 : 0),
    };
  } else {
    next.activity = { ...prev.activity };
  }

  // Worktree probe — replace when fired
  if (events.worktree_probe) {
    next.worktree = {
      baselineHead: prev.worktree.baselineHead,
      statusDigest: events.worktree_probe.statusDigest || "unknown",
      diffDigest: events.worktree_probe.diffDigest || "unknown",
      changedFileCount: events.worktree_probe.changedFileCount || 0,
      insertions: events.worktree_probe.insertions || 0,
      deletions: events.worktree_probe.deletions || 0,
    };
  } else {
    next.worktree = { ...prev.worktree };
  }

  // Validation probe — replace when fired
  if (events.validation_probe) {
    next.validation = {
      lastCommandId: events.validation_probe.commandId || null,
      status: events.validation_probe.status || "not_run",
      evidenceRef: events.validation_probe.evidenceRef || null,
    };
  } else {
    next.validation = { ...prev.validation };
  }

  // Evidence level promotion (monotonic — never regress)
  next.evidenceLevel = promote(next, prev);
  if (LEVEL_ORDER[next.evidenceLevel] > LEVEL_ORDER[prev.evidenceLevel || "alive"]) {
    if (next.evidenceLevel === "productive" || next.evidenceLevel === "verified") {
      next.lastProductiveAt = eventTs || nowIso(events);
    }
  }

  // Phase derivation
  next.phase = derivePhase(next, prev);

  // Diagnostics — append on failed events
  if (events.host_event && events.host_event.success === false) {
    const diagnostic = {
      timestamp: eventTs || nowIso(events),
      code: events.host_event.code || "TOOL_FAILED",
      message: events.host_event.message || `Tool ${events.host_event.category} failed`,
      severity: "error",
    };
    const merged = [...(prev.diagnostics || []), diagnostic];
    next.diagnostics = merged.slice(-MAX_DIAGNOSTICS);
  } else {
    next.diagnostics = [...(prev.diagnostics || [])].slice(-MAX_DIAGNOSTICS);
  }

  return Object.freeze(next);
}

/**
 * Build the initial GovernedAttemptProgress V1 state.
 *
 * @param {object} input - {taskId, operationId, launchId, heartbeat: {timestamp}, baselineHead?}
 * @returns {object} initial state (frozen)
 */
function makeInitialState(input) {
  if (!input || typeof input !== "object") {
    throw new Error("makeInitialState: input must be a non-null object");
  }
  const heartbeat = input.heartbeat || { timestamp: new Date().toISOString() };
  const initial = {
    schemaVersion: SCHEMA_VERSION,
    taskId: input.taskId || null,
    operationId: input.operationId || null,
    launchId: input.launchId || null,
    attempt: input.attempt || 1,
    phase: "observing",
    evidenceLevel: "alive",
    lastActivityAt: heartbeat.timestamp || new Date().toISOString(),
    lastProductiveAt: null,
    activity: {
      readOnlyToolCount: 0,
      writeToolCount: 0,
      testToolCount: 0,
      failedToolCount: 0,
    },
    worktree: {
      baselineHead: input.baselineHead || "unknown",
      statusDigest: "unknown",
      diffDigest: "unknown",
      changedFileCount: 0,
      insertions: 0,
      deletions: 0,
    },
    validation: {
      lastCommandId: null,
      status: "not_run",
      evidenceRef: null,
    },
    diagnostics: [],
  };
  return Object.freeze(initial);
}

/**
 * Compute a deterministic sha256 hash of the state. Same input always
 * produces the same hash (VC-005a — reducer is deterministic).
 */
function hashState(state) {
  // Sort keys recursively for stable serialization
  const normalized = JSON.stringify(sortKeysDeep(state));
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function promote(state, prev) {
  const currentLevel = prev.evidenceLevel || "alive";
  const currentRank = LEVEL_ORDER[currentLevel];
  let candidate = currentLevel;

  // alive → active: host_event with any category present
  if (
    currentRank < LEVEL_ORDER.active &&
    (state.activity.readOnlyToolCount > 0 ||
      state.activity.writeToolCount > 0 ||
      state.activity.testToolCount > 0)
  ) {
    candidate = "active";
  }

  // active → productive: worktree diff present OR validation passed
  if (LEVEL_ORDER[candidate] < LEVEL_ORDER.productive) {
    const hasWorktreeDiff =
      state.worktree.changedFileCount > 0 && state.worktree.diffDigest !== "unknown";
    const hasPassedValidation = state.validation.status === "passed";
    if (hasWorktreeDiff || hasPassedValidation) {
      candidate = "productive";
    }
  }

  // productive → verified: validation status=passed AND worktree diff present.
  // (verified requires BOTH productive evidence types — reviewable worktree
  // diff AND a structured validation receipt. P-005 §3.1 verified evidence.)
  if (
    LEVEL_ORDER[candidate] < LEVEL_ORDER.verified &&
    state.validation.status === "passed" &&
    state.worktree.changedFileCount > 0 &&
    state.worktree.diffDigest !== "unknown"
  ) {
    candidate = "verified";
  }

  // Never regress
  if (LEVEL_ORDER[candidate] < currentRank) return currentLevel;
  return candidate;
}

function derivePhase(state, prev) {
  // Validation passed → ready
  if (state.validation.status === "passed") return "ready";
  // Validation failed or running → testing/failed
  if (state.validation.status === "running") return "testing";
  if (state.validation.status === "failed") return "failed";

  // Blocked: failed tools with no productive history (or productive > 5min old)
  if (state.activity.failedToolCount > 0) {
    const lastProductive = state.lastProductiveAt || prev.lastProductiveAt;
    if (!lastProductive) return "blocked";
    const lastProductiveMs = Date.parse(lastProductive);
    const activityMs = Date.parse(state.lastActivityAt);
    if (activityMs - lastProductiveMs > BLOCKED_PRODUCTIVE_GRACE_MS) return "blocked";
  }

  // Activity-based phase
  if (state.activity.writeToolCount > 0) return "editing";
  if (state.activity.testToolCount > 0) return "testing";
  if (state.activity.readOnlyToolCount > 0) return "observing";
  return "observing";
}

function extractTimestamp(obj) {
  if (!obj || typeof obj !== "object") return null;
  return obj.timestamp || null;
}

function nowIso(events) {
  // Stable helper: pick the most recent timestamp we know about, or "now"
  const candidates = [];
  if (events && typeof events === "object") {
    candidates.push(extractTimestamp(events.heartbeat));
    candidates.push(extractTimestamp(events.host_event));
    candidates.push(extractTimestamp(events.worktree_probe));
    candidates.push(extractTimestamp(events.validation_probe));
  }
  candidates.push(new Date().toISOString());
  return maxIso(candidates.filter(Boolean));
}

function maxIso(values) {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => (Date.parse(v) > Date.parse(acc) ? v : acc));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  reduce,
  makeInitialState,
  hashState,
  SCHEMA_VERSION,
  LEVEL_ORDER,
  PHASE_ORDER,
  MAX_DIAGNOSTICS,
};