"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const protocol = require(path.join(ROOT, "packages", "protocol", "src"));

function event(overrides = {}) {
  return {
    event_id: "coordination:CE-1",
    type: "coordination.task.progress",
    occurred_at: "2026-09-29T04:30:00.000Z",
    source: {
      kind: "coordination",
      source_event_id: "CE-1",
      producer_id: "agent-1",
      producer_kind: "agent",
      project_ref: "project:cortex-agent",
    },
    correlation: {
      task_id: "T-1",
      run_ref: "run:R-1",
    },
    sequence: {
      stream_id: "coordination:T-1:agent-1",
      value: 1,
    },
    payload: { state: "EXECUTING" },
    evidence_refs: [],
    redacted: true,
    ...overrides,
  };
}

test("CortexEvent v1 is a closed portable envelope", () => {
  const value = protocol.normalizeCortexEvent(event());
  assert.equal(value.schema_version, "1");
  assert.equal(value.source.project_ref, "project:cortex-agent");
  assert.equal(value.correlation.run_ref, "run:R-1");
  assert.equal(value.sequence.value, 1);
  assert.equal(Object.isFrozen(value), true);
});

test("CortexEvent rejects invalid canonical refs and unknown fields", () => {
  assert.throws(
    () => protocol.normalizeCortexEvent(event({
      source: {
        kind: "coordination",
        source_event_id: "CE-1",
        project_ref: "runtime:not-a-project",
      },
    })),
    (error) => error.code === "ERR_CORTEX_EVENT_REF",
  );
  assert.throws(
    () => protocol.normalizeCortexEvent(event({ vendor_magic: true })),
    (error) => error.code === "ERR_CORTEX_EVENT_FIELD_UNKNOWN",
  );
});

test("timeline dedupes by event identity and detects source-local sequence gaps", () => {
  const first = event();
  const duplicate = event();
  const third = event({
    event_id: "coordination:CE-3",
    source: { ...event().source, source_event_id: "CE-3" },
    sequence: {
      stream_id: "coordination:T-1:agent-1",
      value: 3,
    },
  });
  const analysis = protocol.analyzeCortexTimeline([first, duplicate, third]);
  assert.equal(analysis.events.length, 2);
  assert.deepEqual(analysis.duplicate_event_ids, ["coordination:CE-1"]);
  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.gaps[0].expected, 2);
  assert.equal(analysis.gaps[0].actual, 3);
  assert.equal(analysis.reconciliation_required, true);
});

test("first event in a partial stream establishes baseline unless initial sequence is supplied", () => {
  const third = event({
    event_id: "coordination:CE-3",
    source: { ...event().source, source_event_id: "CE-3" },
    sequence: { stream_id: "coordination:T-1:agent-1", value: 3 },
  });
  assert.equal(protocol.analyzeCortexTimeline([third]).gaps.length, 0);
  const withCursor = protocol.analyzeCortexTimeline([third], {
    initial_sequences: { "coordination:T-1:agent-1": 1 },
  });
  assert.equal(withCursor.gaps.length, 1);
  assert.equal(withCursor.gaps[0].expected, 2);
});

test("timeline cursor position is opaque and not confused with event sequence", () => {
  const cursor = protocol.normalizeTimelineCursor({
    stream_id: "event-bus:test",
    position: "byte:4096",
    event_id: "framework:eb-evt-1",
  });
  assert.equal(cursor.position, "byte:4096");
  assert.equal(Object.prototype.hasOwnProperty.call(cursor, "sequence"), false);
});
