"use strict";

// ─── Execution Surface Matcher tests (MS-007 / P-004 / VC-007) ──────────────
//
// Covers VC-007-01 (hard filters cannot be overridden by optional scoring)
// and VC-007-02 (requirement, runtime snapshot, and dispatch plan are
// versioned, bounded, revision-linked, and deterministic).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  matchExecutionSurface,
  validateRequirement,
  validateSnapshot,
  ExecutionSurfaceError,
} = require("../../lib/runtime-adapters/execution-surface-matcher");

const NOW = "2026-07-28T12:00:00.000Z";

function baseRequirement(overrides) {
  return Object.assign({
    schema_version: "1.0",
    requirement_id: "REQ-1",
    task_id: "T-1",
    created_at: "2026-07-28T11:00:00.000Z",
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: { approved_decision_id: "D-1", require_active_lease: false },
    preferred: {},
    ttl_at: "2026-07-28T13:00:00.000Z",
  }, overrides || {});
}

function baseSnapshot(overrides) {
  return Object.assign({
    schema_version: "1.0",
    snapshot_id: "SNAP-A",
    host_profile_ref: "H-A",
    taken_at: "2026-07-28T11:55:00.000Z",
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
      "tool.update": "adapter",
    },
    governance: { approved: true, decision_id: "D-1" },
    lease: { active: true, holder: "owner-A" },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  }, overrides || {});
}

test("VC-007-02 requirement, snapshot, and plan are versioned, bounded, and revision-linked", () => {
  const req = validateRequirement(baseRequirement());
  const snap = validateSnapshot(baseSnapshot());
  const plan = matchExecutionSurface(req, [snap], { now: NOW });
  assert.equal(plan.schema_version, "1.0");
  assert.ok(plan.plan_id.startsWith("P-REQ-1-"));
  assert.equal(plan.requirement_id, "REQ-1");
  assert.equal(plan.snapshot_revision.length, 32);
  assert.ok(plan.candidates.length === 1);
});

test("VC-007-01 hard filter fails when a required capability is missing", () => {
  const snap = baseSnapshot();
  delete snap.capabilities["tool.before.block"];
  const plan = matchExecutionSurface(baseRequirement(), [snap], { now: NOW });
  assert.equal(plan.candidates[0].hard_pass, false);
  assert.ok(plan.candidates[0].rejected_reasons.some((r) => r.startsWith("missing_capability:tool.before.block")));
  assert.equal(plan.selection, null);
});

test("VC-007-01 hard filter fails when capability level is below minimum", () => {
  const snap = baseSnapshot({ capabilities: { "session.boundary": "native", "tool.before.block": "adapter", "tool.update": "adapter" } });
  const plan = matchExecutionSurface(baseRequirement(), [snap], { now: NOW });
  assert.equal(plan.candidates[0].hard_pass, false);
  assert.ok(plan.candidates[0].rejected_reasons.some((r) => r.startsWith("insufficient_capability_level")));
});

test("VC-007-01 hard filter fails when governance decision id mismatches", () => {
  const snap = baseSnapshot({ governance: { approved: true, decision_id: "D-OTHER" } });
  const plan = matchExecutionSurface(baseRequirement(), [snap], { now: NOW });
  assert.equal(plan.candidates[0].hard_pass, false);
  assert.ok(plan.candidates[0].rejected_reasons.some((r) => r.startsWith("governance_decision_mismatch")));
});

test("VC-007-01 hard filter fails when snapshot has expired", () => {
  const req = baseRequirement({ ttl_at: "2026-07-28T11:00:00.000Z" });
  const snap = baseSnapshot({ taken_at: "2026-07-28T06:00:00.000Z" });
  const plan = matchExecutionSurface(req, [snap], { now: NOW });
  assert.equal(plan.candidates[0].hard_pass, false);
  assert.deepEqual(plan.candidates[0].rejected_reasons, ["snapshot_expired"]);
});

test("VC-007-01 hard filter fails when an active lease is required but missing", () => {
  const req = baseRequirement({ governance: { approved_decision_id: "D-1", require_active_lease: true } });
  const snap = baseSnapshot({ lease: { active: false, holder: null } });
  const plan = matchExecutionSurface(req, [snap], { now: NOW });
  assert.equal(plan.candidates[0].hard_pass, false);
  assert.deepEqual(plan.candidates[0].rejected_reasons, ["lease_inactive"]);
});

test("VC-007-01 soft scoring cannot override a hard filter", () => {
  const snap = baseSnapshot({
    reliability: { value: 0.999, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.001, source: "explicit-workflow", quality: "high" },
    latency: { value: 1, source: "explicit-workflow", quality: "high" },
    capabilities: { "session.boundary": "native", "tool.before.block": "unsupported" },
  });
  const plan = matchExecutionSurface(baseRequirement(), [snap], { now: NOW });
  assert.equal(plan.candidates[0].hard_pass, false);
  assert.equal(plan.candidates[0].score, 0);
  assert.equal(plan.selection, null);
});

test("VC-007-02 matcher is deterministic for identical inputs", () => {
  const planA = matchExecutionSurface(baseRequirement(), [baseSnapshot()], { now: NOW });
  const planB = matchExecutionSurface(baseRequirement(), [baseSnapshot()], { now: NOW });
  assert.deepEqual(planA, planB);
  assert.equal(planA.snapshot_revision, planB.snapshot_revision);
});

test("VC-007-02 matcher ranks hard-passing candidates by score then host_profile_ref", () => {
  const good = baseSnapshot({ snapshot_id: "SNAP-A", host_profile_ref: "H-A" });
  const better = baseSnapshot({
    snapshot_id: "SNAP-B",
    host_profile_ref: "H-B",
    reliability: { value: 0.99, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.1, source: "explicit-workflow", quality: "high" },
    latency: { value: 80, source: "explicit-workflow", quality: "high" },
  });
  const failed = baseSnapshot({
    snapshot_id: "SNAP-C",
    host_profile_ref: "H-C",
    capabilities: { "session.boundary": "native", "tool.before.block": "unsupported", "tool.update": "adapter" },
  });
  const plan = matchExecutionSurface(baseRequirement(), [good, better, failed], { now: NOW });
  assert.equal(plan.selection, "H-B");
  assert.equal(plan.candidates[0].host_profile_ref, "H-B");
  assert.equal(plan.candidates[1].host_profile_ref, "H-A");
  assert.equal(plan.candidates[2].host_profile_ref, "H-C");
});

test("VC-007-02 candidate ordering breaks ties deterministically by host_profile_ref", () => {
  const a = baseSnapshot({ snapshot_id: "SNAP-A", host_profile_ref: "H-A" });
  const b = baseSnapshot({ snapshot_id: "SNAP-B", host_profile_ref: "H-B" });
  // identical metrics → identical score → ordering by host_profile_ref asc
  const plan1 = matchExecutionSurface(baseRequirement(), [a, b], { now: NOW });
  const plan2 = matchExecutionSurface(baseRequirement(), [b, a], { now: NOW });
  assert.equal(plan1.candidates[0].host_profile_ref, "H-A");
  assert.equal(plan2.candidates[0].host_profile_ref, "H-A");
});

test("VC-007-02 unknown advisory metrics remain neutral and never outrank observed metrics", () => {
  const unknown = baseSnapshot({
    snapshot_id: "SNAP-U",
    host_profile_ref: "H-U",
    reliability: { value: null, source: "unavailable", quality: "unavailable" },
    cost: { value: null, source: "unavailable", quality: "unavailable" },
    latency: { value: null, source: "unavailable", quality: "unavailable" },
  });
  const observed = baseSnapshot({ snapshot_id: "SNAP-O", host_profile_ref: "H-O" });
  const plan = matchExecutionSurface(baseRequirement(), [unknown, observed], { now: NOW });
  assert.equal(plan.candidates[0].host_profile_ref, "H-O");
  assert.ok(plan.candidates.find((c) => c.host_profile_ref === "H-U").score < plan.candidates.find((c) => c.host_profile_ref === "H-O").score);
});

test("VC-007-02 plan explains why a candidate was rejected in reasoning", () => {
  const snap = baseSnapshot({
    capabilities: { "session.boundary": "native", "tool.before.block": "unsupported", "tool.update": "adapter" },
  });
  const plan = matchExecutionSurface(baseRequirement(), [snap], { now: NOW });
  assert.ok(plan.reasoning.includes("No candidate"));
  assert.ok(plan.reasoning.includes("hard filters"));
});

test("VC-007-02 validator rejects unknown capabilities and malformed records", () => {
  assert.throws(() => validateRequirement(baseRequirement({ required_capabilities: ["made.up"] })), (err) => err.code === "ERR_CAPABILITY_UNKNOWN");
  assert.throws(() => validateSnapshot(baseSnapshot({ capabilities: { "session.boundary": "made" } })), (err) => err.code === "ERR_CAPABILITY_LEVEL_UNKNOWN");
  assert.throws(() => validateSnapshot(baseSnapshot({ reliability: { value: "ok" } })), (err) => err.code === "ERR_FIELD_INVALID");
  assert.throws(() => matchExecutionSurface({}, [baseSnapshot()]), (err) => err.code === "ERR_REQUIREMENT_INVALID");
});

test("VC-007-02 duplicate required capabilities are deduplicated without changing order", () => {
  const req = validateRequirement(baseRequirement({
    required_capabilities: ["session.boundary", "session.boundary", "tool.before.block"],
  }));
  assert.deepEqual([...req.required_capabilities], ["session.boundary", "tool.before.block"]);
});

test("VC-007-02 plan_id is unique per requirement × snapshot revision", () => {
  const snap = baseSnapshot();
  const plan1 = matchExecutionSurface(baseRequirement(), [snap], { now: NOW });
  // Change TTL → revision must change → plan_id must change
  const plan2 = matchExecutionSurface(baseRequirement({ ttl_at: "2026-07-28T14:00:00.000Z" }), [snap], { now: NOW });
  assert.notEqual(plan1.plan_id, plan2.plan_id);
});