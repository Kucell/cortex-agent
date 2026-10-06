"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  reconcile,
  canResume,
  DISPOSITIONS,
  OBSERVATION_STATUSES,
  projectReconciliationSummary,
} = require("../../lib/reconciliation");

function base(overrides = {}) {
  return {
    governance_snapshot: {
      expected_revision: "G-1",
      actual_revision: "G-1",
    },
    workspace: {
      head_revision: "P-1",
    },
    product: {
      head_revision: "P-1",
    },
    change_request: {
      revision: "P-1",
    },
    governance: {
      actor_id: "agent-a",
      decisions: [],
      waitpoints: [],
      locks: [],
    },
    observations: [
      {
        id: "checks",
        source: "provider",
        status: "observed",
        required: false,
        value: [
          { id: "ci", name: "ci", status: "completed", conclusion: "success" },
        ],
      },
    ],
    ...overrides,
  };
}

test("contract freezes disposition and observation vocabularies", () => {
  assert.deepEqual(DISPOSITIONS, [
    "READY",
    "BLOCKED",
    "RECONCILIATION_REQUIRED",
    "DEGRADED",
  ]);
  assert.deepEqual(OBSERVATION_STATUSES, [
    "observed",
    "unavailable",
    "unknown",
  ]);
});

test("fully aligned facts produce READY and allow resume", () => {
  const result = reconcile(base());
  assert.equal(result.disposition, "READY");
  assert.equal(result.drift.length, 0);
  assert.equal(result.gates.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(canResume(result), true);
});

test("stale governance snapshot is drift, not a governance gate", () => {
  const result = reconcile(base({
    governance_snapshot: {
      expected_revision: "G-1",
      actual_revision: "G-2",
    },
  }));
  assert.equal(result.disposition, "RECONCILIATION_REQUIRED");
  assert.equal(result.drift[0].id, "governance:revision");
  assert.equal(result.gates.length, 0);
  assert.equal(canResume(result), false);
});

test("workspace product head mismatch requires reconciliation", () => {
  const result = reconcile(base({
    product: { head_revision: "P-2" },
  }));
  assert.equal(result.disposition, "RECONCILIATION_REQUIRED");
  assert.ok(result.drift.some((item) => item.id === "workspace:head"));
});

test("pending waitpoint blocks resume and is not reported as drift", () => {
  const result = reconcile(base({
    governance: {
      actor_id: "agent-a",
      decisions: [],
      waitpoints: [{ waitpoint_id: "WP-1", status: "active" }],
      locks: [],
    },
  }));
  assert.equal(result.disposition, "BLOCKED");
  assert.equal(result.drift.length, 0);
  assert.equal(result.gates[0].type, "waitpoint");
  assert.equal(canResume(result), false);
});

test("lock held by another actor blocks while own lock does not", () => {
  const blocked = reconcile(base({
    governance: {
      actor_id: "agent-a",
      decisions: [],
      waitpoints: [],
      locks: [{ scope: "task:T-1", held_by: "agent-b" }],
    },
  }));
  assert.equal(blocked.disposition, "BLOCKED");

  const own = reconcile(base({
    governance: {
      actor_id: "agent-a",
      decisions: [],
      waitpoints: [],
      locks: [{ scope: "task:T-1", held_by: "agent-a" }],
    },
  }));
  assert.equal(own.disposition, "READY");
});

test("optional unavailable provider capability degrades but still permits controlled resume", () => {
  const result = reconcile(base({
    observations: [{
      id: "checks",
      source: "provider",
      status: "unavailable",
      required: false,
      reason: "provider_capability_missing",
    }],
  }));
  assert.equal(result.disposition, "DEGRADED");
  assert.equal(result.gates.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(canResume(result), true);
});

test("required unavailable provider capability blocks resume", () => {
  const result = reconcile(base({
    observations: [{
      id: "checks",
      source: "provider",
      status: "unavailable",
      required: true,
      reason: "provider_capability_missing",
    }],
  }));
  assert.equal(result.disposition, "BLOCKED");
  assert.equal(result.gates[0].type, "observation");
});

test("failed observed CI check blocks resume", () => {
  const result = reconcile(base({
    observations: [{
      id: "checks",
      source: "provider",
      status: "observed",
      required: false,
      value: [{ id: "ci", name: "ci", status: "completed", conclusion: "failure" }],
    }],
  }));
  assert.equal(result.disposition, "BLOCKED");
  assert.ok(result.gates.some((item) => item.type === "check"));
});

test("BLOCKED has precedence over revision drift", () => {
  const result = reconcile(base({
    product: { head_revision: "P-2" },
    governance: {
      actor_id: "agent-a",
      decisions: [{ decision_id: "D-1", status: "pending" }],
      waitpoints: [],
      locks: [],
    },
  }));
  assert.equal(result.disposition, "BLOCKED");
  assert.ok(result.drift.length > 0);
  assert.ok(result.gates.length > 0);
});

test("change-request revision drift is separate from governance revision namespace", () => {
  const result = reconcile(base({
    change_request: { revision: "P-2" },
  }));
  assert.equal(result.disposition, "RECONCILIATION_REQUIRED");
  const item = result.drift.find((entry) => entry.id === "change-request:revision");
  assert.equal(item.expected, "P-1");
  assert.equal(item.actual, "P-2");
  assert.equal(item.source, "change-request");
});


test("summary projection is consumer-safe and does not recompute reconciliation", () => {
  const result = reconcile(base({
    product: { head_revision: "P-2" },
  }));
  const summary = projectReconciliationSummary(result);
  assert.deepEqual(summary, {
    disposition: "RECONCILIATION_REQUIRED",
    can_resume: false,
    drift_count: 1,
    gate_count: 0,
    warning_count: 0,
    observation_count: 1,
    blocking_reasons: ["workspace:head"],
  });
});
