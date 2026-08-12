"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const bridgeGate = require("../../lib/automation/proposal-to-bridge-gate");

test("deriveBridgeSyncGate returns null when no peers declared", () => {
  assert.equal(bridgeGate.deriveBridgeSyncGate({ title: "x" }), null);
});

test("deriveBridgeSyncGate handles list of plain strings", () => {
  const gate = bridgeGate.deriveBridgeSyncGate({ cross_project_peers: ["alpha", "beta"] });
  assert.equal(gate.type, "bridge_sync");
  assert.deepEqual(gate.sources, ["alpha", "beta"]);
  assert.deepEqual(gate.event_types, []);
  assert.equal(gate.expected_min_events, 0);
});

test("deriveBridgeSyncGate expands rich peer objects", () => {
  const gate = bridgeGate.deriveBridgeSyncGate({
    cross_project_peers: [
      { project_id: "alpha", correlation_group: "g-a", event_types: ["task.state_changed"] },
      { project_id: "beta", correlation_group: "g-b", event_types: ["decision.resolved", "task.state_changed"] },
    ],
  });
  assert.deepEqual(gate.sources, ["alpha", "beta"]);
  assert.deepEqual(gate.correlation_groups, ["g-a", "g-b"]);
  assert.deepEqual(gate.event_types.sort(), ["decision.resolved", "task.state_changed"]);
});

test("deriveBridgeSyncGate accumulates expected_min_events", () => {
  const gate = bridgeGate.deriveBridgeSyncGate({
    peers: [
      { project_id: "alpha", expected_min_events: 3 },
      { project_id: "beta", expected_min_events: 7 },
      { project_id: "gamma", expected_min_events: 1 },
    ],
  });
  assert.equal(gate.expected_min_events, 11);
});

test("deriveBridgeSyncGate returns null for empty peer list", () => {
  assert.equal(bridgeGate.deriveBridgeSyncGate({ peers: [] }), null);
});
