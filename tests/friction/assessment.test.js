"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAssessment, readAssessment, transitionAssessment, AssessmentError, ASSESSMENT_TERMINAL_STATES, LEGAL_TRANSITIONS, journalPath } = require("../../lib/friction/assessment.js");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fr-assess-"));
}

test("legal chain observed -> assessed -> suggested -> user_approved", () => {
  const root = mkTmp();
  const a = createAssessment(root, { sessionId: "S-1", host: "dsh" });
  assert.equal(a.state, "observed");
  assert.ok(a.assessment_id.startsWith("FA-"));
  assert.ok(fs.existsSync(journalPath(root, a.assessment_id)));
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "assessed", actor: "cortex-friction-implementer", evidence_ref: "run:R-1/event:1" });
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "suggested", actor: "cortex-friction-implementer", evidence_ref: "run:R-1/event:2" });
  const done = transitionAssessment(root, { assessment_id: a.assessment_id, to: "user_approved", actor: "user", evidence_ref: "run:R-1/event:3" });
  assert.equal(done.state, "user_approved");
  const replay = readAssessment(root, a.assessment_id);
  assert.equal(replay.state, "user_approved");
  assert.equal(replay.transitions.length, 3);
});

test("terminal state rejects further transition", () => {
  const root = mkTmp();
  const a = createAssessment(root, { sessionId: "S-1", host: "dsh" });
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "assessed", actor: "impl", evidence_ref: "e0" });
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "suggested", actor: "impl", evidence_ref: "e0b" });
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "dismissed", actor: "user", evidence_ref: "e1" });
  assert.throws(() => transitionAssessment(root, { assessment_id: a.assessment_id, to: "suggested", actor: "user", evidence_ref: "e2" }),
    (e) => e instanceof AssessmentError && e.code === "ERR_ASSESSMENT_TRANSITION_INVALID");
  const replay = readAssessment(root, a.assessment_id);
  assert.equal(replay.state, "dismissed");
});

test("illegal transition throws ERR_ASSESSMENT_TRANSITION_INVALID", () => {
  const root = mkTmp();
  const a = createAssessment(root, { sessionId: "S-1", host: "dsh" });
  assert.throws(() => transitionAssessment(root, { assessment_id: a.assessment_id, to: "suggested", actor: "x" }),
    (e) => e.code === "ERR_ASSESSMENT_TRANSITION_INVALID");
  assert.throws(() => transitionAssessment(root, { assessment_id: a.assessment_id, to: "bogus", actor: "x" }),
    (e) => e.code === "ERR_ASSESSMENT_STATE_UNKNOWN");
});

test("expired allowed from observed, assessed and suggested", () => {
  const root = mkTmp();
  const a = createAssessment(root, { sessionId: "S-1", host: "dsh" });
  assert.equal(transitionAssessment(root, { assessment_id: a.assessment_id, to: "expired", actor: "system" }).state, "expired");
  const b = createAssessment(root, { sessionId: "S-2", host: "dsh" });
  transitionAssessment(root, { assessment_id: b.assessment_id, to: "assessed", actor: "impl" });
  assert.equal(transitionAssessment(root, { assessment_id: b.assessment_id, to: "expired", actor: "system" }).state, "expired");
  const c = createAssessment(root, { sessionId: "S-3", host: "dsh" });
  transitionAssessment(root, { assessment_id: c.assessment_id, to: "assessed", actor: "impl" });
  transitionAssessment(root, { assessment_id: c.assessment_id, to: "suggested", actor: "impl" });
  assert.equal(transitionAssessment(root, { assessment_id: c.assessment_id, to: "expired", actor: "system" }).state, "expired");
});

test("journal is append-only: two transitions = two lines, file not rewritten", () => {
  const root = mkTmp();
  const a = createAssessment(root, { sessionId: "S-1", host: "dsh" });
  const before = fs.readFileSync(journalPath(root, a.assessment_id), "utf8");
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "assessed", actor: "impl", evidence_ref: "e1" });
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "suggested", actor: "impl", evidence_ref: "e2" });
  const after = fs.readFileSync(journalPath(root, a.assessment_id), "utf8");
  assert.ok(after.startsWith(before.trim() + "\n"));
  const lines = after.trim().split("\n");
  assert.equal(lines.length, 3); // created + 2 transitions
});

test("readAssessment replays state and counts malformed lines", () => {
  const root = mkTmp();
  const a = createAssessment(root, { sessionId: "S-1", host: "dsh" });
  transitionAssessment(root, { assessment_id: a.assessment_id, to: "assessed", actor: "impl" });
  const file = journalPath(root, a.assessment_id);
  fs.appendFileSync(file, "{not json}\n", "utf8");
  const replay = readAssessment(root, a.assessment_id);
  assert.equal(replay.state, "assessed");
  assert.equal(replay.skipped, 1);
});

test("redaction: transition never carries free-form text (schema has no such fields)", () => {
  const root = mkTmp();
  const a = createAssessment(root, { sessionId: "S-1", host: "dsh" });
  const res = transitionAssessment(root, { assessment_id: a.assessment_id, to: "assessed", actor: "impl", evidence_ref: "e1" });
  const raw = fs.readFileSync(journalPath(root, a.assessment_id), "utf8");
  assert.ok(!raw.includes("prompt"));
  assert.ok(!raw.includes("password"));
  assert.ok(!raw.includes("secret"));
  assert.equal(res.evidence_ref, "e1");
});

test("ASSESSMENT_TERMINAL_STATES preserved", () => {
  assert.deepEqual([...ASSESSMENT_TERMINAL_STATES].sort(), ["dismissed", "expired", "user_approved"]);
  assert.ok(LEGAL_TRANSITIONS["observed:expired"]);
  assert.ok(LEGAL_TRANSITIONS["assessed:expired"]);
  assert.ok(LEGAL_TRANSITIONS["suggested:expired"]);
  assert.ok(LEGAL_TRANSITIONS["suggested:user_approved"]);
  assert.ok(LEGAL_TRANSITIONS["suggested:dismissed"]);
});
