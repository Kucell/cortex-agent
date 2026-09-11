"use strict";

// Friction Score (P-003 / M-003B). Non-persistent assessment over canonical
// redacted FS events. Zero external dependencies. Node >=14.
//
// Public API:
//   - FrictionScoreError       : structured error code carrier
//   - FRICTION_SIGNAL_NAMES    : frozen 6-signal vocabulary (mirrors signal.js)
//   - normalizeHostMatrix(input): -> frozen {signal: observability}
//   - scoreSignals(events, hostMatrix?) : pure assessment
//   - scoreSession(root, {sessionId, hostMatrix}) : read signals.jsonl + score
//
// Redaction invariant: the assessment is aggregate-only. It contains counts,
// signal names, observability levels, coverage and a recommendation - never
// prompts, messages, args, output, credentials, or file content.

const fs = require("node:fs");
const path = require("node:path");
const { readFrictionEvents } = require("./signal.js");

const FRICTION_SIGNAL_NAMES = Object.freeze([
  "tool_denied",
  "tool_failed",
  "tool_retried",
  "user_interrupted",
  "user_correction",
  "lifecycle_stop",
]);

// Observability levels that contribute friction weight.
const SCORED_OBSERVABILITY = Object.freeze(["observed", "derived"]);

const SIGNAL_NAME_SET = new Set(FRICTION_SIGNAL_NAMES);
const SCORED_OBSERVABILITY_SET = new Set(SCORED_OBSERVABILITY);

class FrictionScoreError extends Error {
  constructor(code, details) {
    super("[" + (code || "ERR_FRICTION_SCORE") + "] " + JSON.stringify(details || {}));
    this.name = "FrictionScoreError";
    this.code = code || "ERR_FRICTION_SCORE";
    this.details = details || {};
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return value;
}

// Accept either {signal: observability} or {signals: {signal: observability}},
// i.e. the HostCapabilityDescriptor.friction_signals object. Unknown signal
// names or observability levels are rejected (closed vocabulary).
function normalizeHostMatrix(input) {
  if (input === undefined || input === null) return Object.freeze({});
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new FrictionScoreError("ERR_HOST_MATRIX_NOT_OBJECT", { where: "hostMatrix" });
  }
  let map = input;
  if (input.signals !== undefined) {
    map = input.signals;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      throw new FrictionScoreError("ERR_HOST_MATRIX_SIGNALS_NOT_OBJECT", { where: "hostMatrix.signals" });
    }
  }
  const out = {};
  for (const key of Object.keys(map)) {
    if (!SIGNAL_NAME_SET.has(key)) {
      throw new FrictionScoreError("ERR_SIGNAL_UNKNOWN", { signal: key });
    }
    const level = map[key];
    if (typeof level !== "string" || level.length === 0) {
      throw new FrictionScoreError("ERR_OBSERVABILITY_INVALID", { signal: key });
    }
    if (["observed", "derived", "not_observed", "not_supported"].indexOf(level) < 0) {
      throw new FrictionScoreError("ERR_OBSERVABILITY_UNKNOWN", { signal: key, value: level });
    }
    out[key] = level;
  }
  return deepFreeze(out);
}

// Pure assessment. events = canonical FS events. hostMatrix optional.
function scoreSignals(events, hostMatrix) {
  const matrix = normalizeHostMatrix(hostMatrix);
  if (!Array.isArray(events)) {
    throw new FrictionScoreError("ERR_EVENTS_NOT_ARRAY");
  }
  const bySignal = {};
  const total = { count: 0 };
  for (const signal of FRICTION_SIGNAL_NAMES) {
    bySignal[signal] = { count: 0, observability: matrix[signal] || null };
  }
  for (const ev of events) {
    if (!ev || typeof ev !== "object" || typeof ev.type !== "string" || !SIGNAL_NAME_SET.has(ev.type)) {
      throw new FrictionScoreError("ERR_EVENT_INVALID", { reason: "missing/unknown type" });
    }
    const count = typeof ev.count === "number" && Number.isInteger(ev.count) && ev.count > 0 ? ev.count : 0;
    bySignal[ev.type].count += count;
    total.count += count;
  }
  const coverage = { observed: [], derived: [], not_observed: [], not_supported: [], absent: [] };
  for (const signal of FRICTION_SIGNAL_NAMES) {
    const level = matrix[signal];
    if (level === undefined || level === null) coverage.absent.push(signal);
    else if (Object.prototype.hasOwnProperty.call(coverage, level)) coverage[level].push(signal);
    else coverage.absent.push(signal);
  }
  let score = 0;
  for (const ev of events) {
    if (!SCORED_OBSERVABILITY_SET.has(ev.observability)) continue;
    const c = typeof ev.count === "number" && Number.isInteger(ev.count) && ev.count > 0 ? ev.count : 0;
    score += c;
  }
  const matrixSupports = coverage.observed.length > 0 || coverage.derived.length > 0;
  let recommendation = "none";
  if (score > 0) {
    recommendation = matrixSupports ? "suggest" : "consider";
  }
  const signals = {};
  for (const signal of FRICTION_SIGNAL_NAMES) {
    signals[signal] = { count: bySignal[signal].count, observability: bySignal[signal].observability };
  }
  const out = {
    session_id: null,
    total: total.count,
    signals,
    coverage,
    score,
    recommendation,
  };
  return deepFreeze(out);
}

// Read signals.jsonl for one session and score it. Pure read; writes nothing.
function scoreSession(projectRoot, opts) {
  const options = opts || {};
  const sessionId = options.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new FrictionScoreError("ERR_SESSION_ID_REQUIRED");
  }
  const all = readFrictionEvents(projectRoot).events;
  const mine = all.filter(function (ev) { return ev.session_id === sessionId; });
  const assessment = scoreSignals(mine, options.hostMatrix);
  return deepFreeze(Object.assign({}, assessment, { session_id: sessionId }));
}

module.exports = {
  FrictionScoreError,
  FRICTION_SIGNAL_NAMES,
  normalizeHostMatrix,
  scoreSignals,
  scoreSession,
};
