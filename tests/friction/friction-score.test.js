"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scoreSignals, scoreSession, normalizeHostMatrix, FrictionScoreError, FRICTION_SIGNAL_NAMES } = require("../../lib/friction/score.js");
const { recordFrictionEvent, validateFrictionEvent } = require("../../lib/friction/signal.js");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fr-score-"));
}
function ev(type, observability, count, sessionId) {
  return validateFrictionEvent({
    schema_version: "1",
    session_id: sessionId || "S-1",
    host: "dsh",
    type,
    observability,
    count: count === undefined ? 1 : count,
    occurred_at: "2026-09-11T00:00:00.000Z",
    evidence_ref: "run:R-1/event:1",
    redaction: "aggregate_only",
  });
}

test("scoreSignals with empty events: coverage all absent, score 0, recommendation none", () => {
  const a = scoreSignals([], undefined);
  assert.equal(a.score, 0);
  assert.equal(a.recommendation, "none");
  assert.equal(a.coverage.absent.length, 6);
  assert.equal(a.coverage.observed.length, 0);
  assert.equal(a.total, 0);
  assert.ok(Object.isFrozen(a));
});

test("scoreSignals with only not_supported/not_observed coverage: score 0, recommendation none, coverage explicit", () => {
  const matrix = { tool_denied: "not_supported", tool_failed: "not_observed", user_interrupted: "not_observed" };
  const a = scoreSignals([], matrix);
  assert.equal(a.score, 0);
  assert.equal(a.recommendation, "none");
  assert.deepEqual(a.coverage.not_supported, ["tool_denied"]);
  assert.deepEqual(a.coverage.not_observed, ["tool_failed", "user_interrupted"]);
  // never implies zero friction: coverage is explicit about what was not claimable
  assert.ok(a.coverage.not_supported.length > 0);
});

test("scoreSignals with observed+derived events: score > 0 and recommendation reflects it", () => {
  const matrix = { tool_failed: "derived", tool_retried: "derived", lifecycle_stop: "derived" };
  const a = scoreSignals([ev("tool_failed", "derived", 2), ev("tool_retried", "derived", 1)], matrix);
  assert.equal(a.score, 3);
  assert.equal(a.recommendation, "suggest");
  assert.equal(a.total, 3);
  assert.deepEqual(a.coverage.derived, ["tool_failed", "tool_retried", "lifecycle_stop"]);
});

test("scoreSignals: events without matrix support yield consider, not suggest", () => {
  // events observed but matrix says nothing about them -> absent coverage
  const a = scoreSignals([ev("tool_failed", "observed", 1)], undefined);
  assert.equal(a.score, 1);
  assert.equal(a.recommendation, "consider");
  assert.equal(a.coverage.absent.length, 6);
});

test("normalizeHostMatrix accepts descriptor friction_signals object shape", () => {
  const m = normalizeHostMatrix({ signals: { tool_failed: "derived" } });
  assert.equal(m.tool_failed, "derived");
  const m2 = normalizeHostMatrix({ tool_failed: "observed" });
  assert.equal(m2.tool_failed, "observed");
});

test("unknown event shape throws FrictionScoreError", () => {
  assert.throws(() => scoreSignals([{ nope: true }]), (e) => e instanceof FrictionScoreError && e.code === "ERR_EVENT_INVALID");
});

test("unknown host matrix signal throws", () => {
  assert.throws(() => normalizeHostMatrix({ bogus: "observed" }), (e) => e.code === "ERR_SIGNAL_UNKNOWN");
});

test("unknown observability throws", () => {
  assert.throws(() => normalizeHostMatrix({ tool_failed: "maybe" }), (e) => e.code === "ERR_OBSERVABILITY_UNKNOWN");
});

test("scoreSession filters by session_id from a real signals.jsonl", () => {
  const root = mkTmp();
  recordFrictionEvent(root, validateFrictionEvent({ schema_version: "1", session_id: "S-a", host: "dsh", type: "tool_failed", observability: "derived", count: 1, occurred_at: "2026-09-11T00:00:00.000Z", evidence_ref: "r", redaction: "aggregate_only" }));
  recordFrictionEvent(root, validateFrictionEvent({ schema_version: "1", session_id: "S-b", host: "dsh", type: "tool_retried", observability: "derived", count: 3, occurred_at: "2026-09-11T00:00:00.000Z", evidence_ref: "r", redaction: "aggregate_only" }));
  const a = scoreSession(root, { sessionId: "S-b", hostMatrix: { tool_retried: "derived" } });
  assert.equal(a.session_id, "S-b");
  assert.equal(a.score, 3);
  assert.equal(a.total, 3);
  assert.equal(a.signals.tool_failed.count, 0);
});

test("FRICTION_SIGNAL_NAMES is the frozen 6-signal vocabulary", () => {
  assert.equal(FRICTION_SIGNAL_NAMES.length, 6);
  assert.deepEqual([...FRICTION_SIGNAL_NAMES].sort(), ["lifecycle_stop", "tool_denied", "tool_failed", "tool_retried", "user_correction", "user_interrupted"]);
});
