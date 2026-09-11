"use strict";

// FrictionAssessment state machine + append-only journal (P-003 / M-003B).
// Zero external dependencies. Node >=14.
//
// States: observed -> assessed -> suggested -> user_approved | dismissed | expired
// Terminal states (user_approved / dismissed / expired) are preserved: no
// transition out of them is legal.
//
// Journal: <root>/.agent/runtime-evidence/friction/assessments/<assessment_id>.jsonl
// Append-only: the ONLY write path is appendFileSync; a journal file is never
// rewritten or truncated. Single-writer assumption: the caller is responsible
// for serialising writers (appendFileSync is atomic for small lines).
//
// Redaction guard: journal lines carry only stable ids, state names, an actor
// label and an opaque evidence_ref - never prompts, messages, args, output,
// credentials, or file content.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ASSESSMENT_STATES = Object.freeze([
  "observed",
  "assessed",
  "suggested",
  "user_approved",
  "dismissed",
  "expired",
]);

const ASSESSMENT_TERMINAL_STATES = Object.freeze(["user_approved", "dismissed", "expired"]);

// Legal transitions. Keys are "from:to" pairs.
const LEGAL_TRANSITIONS = Object.freeze({
  "observed:assessed": true,
  "assessed:suggested": true,
  "suggested:user_approved": true,
  "suggested:dismissed": true,
  "assessed:expired": true,
  "suggested:expired": true,
  "observed:expired": true,
});

const STATE_SET = new Set(ASSESSMENT_STATES);
const TERMINAL_SET = new Set(ASSESSMENT_TERMINAL_STATES);

class AssessmentError extends Error {
  constructor(code, details) {
    super("[" + (code || "ERR_ASSESSMENT") + "] " + JSON.stringify(details || {}));
    this.name = "AssessmentError";
    this.code = code || "ERR_ASSESSMENT";
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

function generateId(prefix) {
  const rnd = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return prefix + rnd;
}

function asStr(value, where, max) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AssessmentError("ERR_FIELD_REQUIRED", { where });
  }
  if (value.length > max) {
    throw new AssessmentError("ERR_FIELD_TOO_LONG", { where, maxLength: max });
  }
  return value;
}

function journalPath(projectRoot, assessmentId) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new AssessmentError("ERR_PROJECT_ROOT_INVALID", { where: "projectRoot" });
  }
  return path.join(projectRoot, ".agent", "runtime-evidence", "friction", "assessments", assessmentId + ".jsonl");
}

// Append one transition line. Never overwrites.
function appendLine(projectRoot, assessmentId, line) {
  const file = journalPath(projectRoot, assessmentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  return file;
}

function createAssessment(projectRoot, opts) {
  const options = opts || {};
  const sessionId = asStr(options.sessionId, "sessionId", 128);
  const host = asStr(options.host, "host", 64);
  const redaction = options.redaction === undefined ? "aggregate_only" : asStr(options.redaction, "redaction", 32);
  if (["aggregate_only", "full"].indexOf(redaction) < 0) {
    throw new AssessmentError("ERR_REDACTION_UNKNOWN", { value: redaction });
  }
  const assessmentId = generateId("FA-");
  const createdAt = new Date().toISOString();
  const line = {
    event: "created",
    assessment_id: assessmentId,
    session_id: sessionId,
    host,
    state: "observed",
    redaction,
    at: createdAt,
  };
  appendLine(projectRoot, assessmentId, line);
  return deepFreeze({ assessment_id: assessmentId, state: "observed", session_id: sessionId, host, redaction, created_at: createdAt, journal: journalPath(projectRoot, assessmentId) });
}

// Replay the journal: returns { assessment_id, state, transitions, skipped }.
// Malformed lines are skipped and counted (append-only journal stays intact).
function readAssessment(projectRoot, assessmentId) {
  asStr(assessmentId, "assessment_id", 128);
  const file = journalPath(projectRoot, assessmentId);
  if (!fs.existsSync(file)) {
    throw new AssessmentError("ERR_ASSESSMENT_NOT_FOUND", { assessment_id: assessmentId });
  }
  let state = null;
  let sessionId = null;
  let host = null;
  let redaction = null;
  let createdAt = null;
  const transitions = [];
  let skipped = 0;
  const raw = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of raw) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      skipped += 1;
      continue;
    }
    if (!entry || typeof entry !== "object") { skipped += 1; continue; }
    if (entry.event === "created") {
      if (state !== null) { skipped += 1; continue; }
      state = entry.state;
      sessionId = entry.session_id;
      host = entry.host;
      redaction = entry.redaction;
      createdAt = entry.at;
      continue;
    }
    if (entry.event === "transition") {
      const from = entry.from;
      const to = entry.to;
      if (!STATE_SET.has(from) || !STATE_SET.has(to)) { skipped += 1; continue; }
      if (state === null || state !== from) { skipped += 1; continue; }
      if (TERMINAL_SET.has(state)) { skipped += 1; continue; }
      state = to;
      transitions.push({ from, to, actor: entry.actor || null, evidence_ref: entry.evidence_ref || null, at: entry.at || null });
      continue;
    }
    skipped += 1;
  }
  if (state === null) {
    throw new AssessmentError("ERR_ASSESSMENT_EMPTY", { assessment_id: assessmentId });
  }
  return deepFreeze({
    assessment_id: assessmentId,
    session_id: sessionId,
    host,
    redaction,
    created_at: createdAt,
    state,
    transitions,
    skipped,
    journal: file,
  });
}

function transitionAssessment(projectRoot, opts) {
  const options = opts || {};
  const assessmentId = asStr(options.assessment_id, "assessment_id", 128);
  const to = asStr(options.to, "to", 32);
  const actor = asStr(options.actor, "actor", 64);
  const evidenceRef = options.evidence_ref === undefined ? "" : asStr(options.evidence_ref, "evidence_ref", 256);
  if (!STATE_SET.has(to)) {
    throw new AssessmentError("ERR_ASSESSMENT_STATE_UNKNOWN", { to });
  }
  const current = readAssessment(projectRoot, assessmentId);
  if (TERMINAL_SET.has(current.state)) {
    throw new AssessmentError("ERR_ASSESSMENT_TRANSITION_INVALID", {
      from: current.state,
      to,
      reason: "terminal state preserved",
    });
  }
  const key = current.state + ":" + to;
  if (!LEGAL_TRANSITIONS[key]) {
    throw new AssessmentError("ERR_ASSESSMENT_TRANSITION_INVALID", { from: current.state, to });
  }
  const at = new Date().toISOString();
  const line = {
    event: "transition",
    assessment_id: assessmentId,
    from: current.state,
    to,
    actor,
    evidence_ref: evidenceRef,
    at,
  };
  appendLine(projectRoot, assessmentId, line);
  return deepFreeze({ assessment_id: assessmentId, from: current.state, to, state: to, actor, evidence_ref: evidenceRef, at, journal: journalPath(projectRoot, assessmentId) });
}

module.exports = {
  AssessmentError,
  ASSESSMENT_STATES,
  ASSESSMENT_TERMINAL_STATES,
  LEGAL_TRANSITIONS,
  createAssessment,
  readAssessment,
  transitionAssessment,
  journalPath,
};
