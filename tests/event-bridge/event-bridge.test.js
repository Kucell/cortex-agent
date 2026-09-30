"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  normalizeFrameworkEvent,
} = require(path.join(ROOT, "lib", "event-bridge", "framework-event-bus.js"));
const {
  normalizeCoordinationEvent,
} = require(path.join(ROOT, "lib", "event-bridge", "coordination.js"));
const {
  normalizeRuntimeBoundaryEvent,
} = require(path.join(ROOT, "lib", "event-bridge", "runtime-boundary.js"));

function frameworkEvent() {
  return {
    event_id: "eb-evt-00000001-0000-0000-0000-000000000000",
    event_name: "subagent_completed",
    event_version: "1.0",
    bus_id: "test-host:m-040",
    occurred_at: "2026-09-29T04:30:00.000Z",
    producer: {
      producer_id: "sub-1",
      producer_kind: "sub_agent",
      session_id: "S-1",
    },
    correlation: {
      mission_id: "M-040",
      subagent_id: "sub-1",
      parent_run_id: "R-1",
      causation_id: null,
    },
    payload: {
      status: "success",
      output_summary: "done",
    },
  };
}

test("Framework Event Bus projects into CortexEvent without inventing sequence", () => {
  const value = normalizeFrameworkEvent(frameworkEvent(), {
    project_ref: "project:cortex-agent",
  });
  assert.equal(value.event_id.startsWith("framework:"), true);
  assert.equal(value.type, "agent.subagent.completed");
  assert.equal(value.sequence, null);
  assert.equal(value.correlation.run_ref, "run:R-1");
  assert.equal(value.redacted, false);
});

test("Framework sequence is only present when an explicit source-local ordinal is supplied", () => {
  const value = normalizeFrameworkEvent(frameworkEvent(), {
    sequence: 9,
    stream_id: "framework:test-host:m-040",
  });
  assert.deepEqual(value.sequence, {
    stream_id: "framework:test-host:m-040",
    value: 9,
  });
});

function coordinationEvent() {
  return {
    schemaVersion: "1.0",
    eventId: "CE-20260929-001",
    projectId: "cortex-agent",
    taskId: "T-1",
    parentTaskId: null,
    correlationId: "corr-1",
    producer: {
      actorId: "agent-1",
      kind: "agent",
      sessionId: "S-1",
    },
    targets: [],
    eventType: "task.created",
    previousState: null,
    currentState: "CREATED",
    timestamp: "2026-09-29T04:30:00.000Z",
    sequence: 1,
    repository: { repositoryId: "cortex-agent" },
    fileOwnership: [],
    progress: null,
    message: null,
    evidence: [],
    requestedAction: null,
    expiresAt: null,
    notification: { policy: "journal_only", dedupeKey: "task.created" },
    operationId: null,
    operationAttempt: null,
  };
}

test("Coordination journal preserves its strict source-local sequence in CortexEvent", () => {
  const value = normalizeCoordinationEvent(coordinationEvent(), {
    mission_id: "M-040",
  });
  assert.equal(value.type, "coordination.task.created");
  assert.deepEqual(value.sequence, {
    stream_id: "coordination:T-1:agent-1",
    value: 1,
  });
  assert.equal(value.source.project_ref, "project:cortex-agent");
  assert.equal(value.correlation.session_ref, "session:S-1");
  assert.equal(value.redacted, true);
});

function runtimeEvent() {
  return {
    schema_version: "1.0",
    event_id: "RBE-1",
    type: "tool.before",
    at: "2026-09-29T04:30:00.000Z",
    host: {
      adapter_id: "codex",
      session_ref: "host-session-1",
    },
    correlation: {
      task_id: "T-1",
      run_id: "R-1",
      session_id: "S-1",
      operation_id: "OP-1",
      trace_id: "TRACE-1",
    },
    resource: {
      kind: "tool",
      name: "dispatch.execute",
    },
    capability: "tool.before.block",
    decision: {
      result: "allowed",
      authorization_ref: "D-1",
    },
    evidence_refs: ["decision:D-1"],
  };
}

test("Runtime Boundary projection keeps adapter identity below RuntimeRef and does not invent physical HostRef", () => {
  const value = normalizeRuntimeBoundaryEvent(runtimeEvent());
  assert.equal(value.type, "runtime.tool.before");
  assert.equal(value.source.runtime_ref, "runtime:native:codex");
  assert.equal(value.source.host_ref, null);
  assert.equal(value.correlation.run_ref, "run:R-1");
  assert.equal(value.redacted, true);
});

test("Runtime Boundary may attach an explicit physical HostRef without changing adapter identity", () => {
  const value = normalizeRuntimeBoundaryEvent(runtimeEvent(), {
    host_ref: "host:mac-mini",
    runtime_ref: "runtime:paseo:mac-mini",
  });
  assert.equal(value.source.host_ref, "host:mac-mini");
  assert.equal(value.source.runtime_ref, "runtime:paseo:mac-mini");
  assert.equal(value.source.producer_id, "codex");
});
