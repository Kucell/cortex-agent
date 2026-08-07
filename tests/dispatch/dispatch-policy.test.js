"use strict";

// ─── Dispatch Policy tests (MS-012 / P-004 / VC-012) ────────────────────────
//
// VC-012-01: Reliability, cost, and latency inputs include source and
//            measurement quality; unknown values remain neutral.
// VC-012-02: Controlled automation remains disabled by default and does not
//            turn policy score into authorization.
// VC-012-03: `node --test tests/dispatch-policy.test.js && architecture-guard`.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluate,
  validateMetric,
  isRecommendation,
  ALLOWED_AUTOMATION_LEVELS,
  DispatchPolicyError,
} = require("../../lib/runtime-adapters/dispatch-policy");

const NOW = "2026-07-28T12:00:00.000Z";

function requirement() {
  return {
    schema_version: "1.0",
    requirement_id: "REQ-1",
    task_id: "T-1",
    created_at: "2026-07-28T11:00:00.000Z",
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: { approved_decision_id: "D-1", require_active_lease: false },
    preferred: {},
    ttl_at: "2026-07-28T13:00:00.000Z",
  };
}

function snapshot(overrides) {
  return Object.assign({
    schema_version: "1.0",
    snapshot_id: "SNAP-A",
    host_profile_ref: "H-A",
    taken_at: "2026-07-28T11:55:00.000Z",
    capabilities: { "session.boundary": "native", "tool.before.block": "native", "tool.update": "adapter" },
    governance: { approved: true, decision_id: "D-1" },
    lease: { active: true, holder: "owner-A" },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  }, overrides || {});
}

test("VC-012-01 reliability, cost, and latency inputs must declare source and quality", () => {
  assert.throws(() => validateMetric({ value: 0.9, source: "vibes", quality: "high" }, "m"), (err) => err.code === "ERR_METRIC_SOURCE_INVALID");
  assert.throws(() => validateMetric({ value: 0.9, source: "explicit-workflow", quality: "great" }, "m"), (err) => err.code === "ERR_METRIC_QUALITY_INVALID");
  assert.throws(() => validateMetric({ value: "ok", source: "explicit-workflow", quality: "high" }, "m"), (err) => err.code === "ERR_METRIC_VALUE_INVALID");
  assert.doesNotThrow(() => validateMetric({ value: 0.9, source: "explicit-workflow", quality: "high" }, "m"));
  assert.doesNotThrow(() => validateMetric({ value: null, source: "unavailable", quality: "unavailable" }, "m"));
});

test("VC-012-01 unknown metric values stay neutral in the policy score", () => {
  const unknown = snapshot({
    reliability: { value: null, source: "unavailable", quality: "unavailable" },
    cost: { value: null, source: "unavailable", quality: "unavailable" },
    latency: { value: null, source: "unavailable", quality: "unavailable" },
  });
  const observed = snapshot({ snapshot_id: "SNAP-B", host_profile_ref: "H-B" });
  const result = evaluate(requirement(), [unknown, observed], { now: NOW, enabled: true });
  const unknownCandidate = result.candidates.find((c) => c.host_profile_ref === "H-A");
  const observedCandidate = result.candidates.find((c) => c.host_profile_ref === "H-B");
  assert.ok(unknownCandidate.policy_score < observedCandidate.policy_score);
  assert.equal(unknownCandidate.metrics.reliability.source, "unavailable");
  assert.equal(unknownCandidate.metrics.reliability.quality, "unavailable");
});

test("VC-012-02 controlled automation is disabled by default", () => {
  const result = evaluate(requirement(), [snapshot()], { now: NOW });
  assert.equal(result.enabled, false);
  assert.equal(result.automation_level, "disabled");
  assert.equal(result.automation_effective, "disabled");
  for (const candidate of result.candidates) {
    assert.equal(candidate.recommendation, "advisory_only_automation_disabled");
  }
});

test("VC-012-02 enabling automation still does not authorize anything", () => {
  const result = evaluate(requirement(), [snapshot()], { now: NOW, enabled: true, automationLevel: "advisory" });
  assert.equal(result.enabled, true);
  assert.equal(result.automation_effective, "advisory");
  assert.equal(result.authorization_decision.authorized, false);
  assert.ok(result.authorization_decision.reason.includes("advisory"));
  assert.ok(isRecommendation(result));
});

test("VC-012-02 policy score can never skip the hard filter", () => {
  const snap = snapshot({
    capabilities: { "session.boundary": "native", "tool.before.block": "unsupported", "tool.update": "adapter" },
    reliability: { value: 0.999, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.001, source: "explicit-workflow", quality: "high" },
    latency: { value: 1, source: "explicit-workflow", quality: "high" },
  });
  const result = evaluate(requirement(), [snap], { now: NOW, enabled: true });
  assert.equal(result.candidates[0].hard_pass, false);
  assert.equal(result.recommended, null);
  assert.equal(result.authorization_decision.authorized, false);
});

test("VC-012-02 restricted automation level still requires enabled=true", () => {
  assert.throws(
    () => evaluate(requirement(), [snapshot()], { now: NOW, automationLevel: "restricted" }),
    (err) => err.code === "ERR_AUTOMATION_REQUIRES_ENABLED"
  );
});

test("VC-012-02 unknown automation levels are rejected", () => {
  assert.throws(
    () => evaluate(requirement(), [snapshot()], { now: NOW, automationLevel: "mayhem" }),
    (err) => err.code === "ERR_AUTOMATION_LEVEL_UNKNOWN"
  );
});

test("VC-012-03 evaluation exposes an auditable plan_id and evaluation_id", () => {
  const result = evaluate(requirement(), [snapshot()], { now: NOW, enabled: true });
  assert.ok(result.evaluation_id.startsWith("EVAL-P-REQ-1-"));
  assert.equal(result.plan_id, result.evaluation_id.slice("EVAL-".length));
});

test("VC-012-03 evaluation requires options.now for deterministic timing", () => {
  assert.throws(() => evaluate(requirement(), [snapshot()], { enabled: true }), (err) => err.code === "ERR_OPTIONS_NOW_REQUIRED");
});

test("VC-012-03 policy score ranks candidates deterministically and breaks ties by host_profile_ref", () => {
  const a = snapshot({ snapshot_id: "SNAP-A", host_profile_ref: "H-A" });
  const b = snapshot({ snapshot_id: "SNAP-B", host_profile_ref: "H-B" });
  const r1 = evaluate(requirement(), [a, b], { now: NOW, enabled: true });
  const r2 = evaluate(requirement(), [b, a], { now: NOW, enabled: true });
  assert.equal(r1.candidates[0].host_profile_ref, "H-A");
  assert.equal(r2.candidates[0].host_profile_ref, "H-A");
});

test("VC-012-03 the public automation level surface is closed-enum", () => {
  assert.deepEqual([...ALLOWED_AUTOMATION_LEVELS], ["disabled", "advisory", "restricted", "full"]);
});

test("VC-012-03 evaluation is immutable", () => {
  const result = evaluate(requirement(), [snapshot()], { now: NOW, enabled: true });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(Object.isFrozen(result.authorization_decision), true);
});