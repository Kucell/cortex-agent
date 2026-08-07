"use strict";

// Tests for M-004 MS-001 VC-002: 8 core event JSON Schema draft-07 + extension.
//
// Strategy:
//   - Verify all 10 schema files exist and are syntactically valid JSON.
//   - Verify event-types.js registry contains exactly 8 core events.
//   - For each event type: validate a correct payload (pass) and mutated
//     payloads (fail) covering required-field absence, type mismatch, enum
//     violation, and range bounds.
//   - Verify the envelope schema enforces event_id pattern, bus_id pattern,
//     event_name enum, and additionalProperties:false.
//   - Verify custom:* extension events are accepted with any payload.
//   - Verify ack-required set, isKnownEvent, generateEventId, buildEvent.
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-002
//   - docs/architecture/framework-event-bus-design.md §3.2

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const et = require("../../lib/event-bus/event-types");

const repoRoot = path.resolve(__dirname, "..", "..");
const schemasDir = path.join(repoRoot, "lib", "event-bus", "schemas");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid producer. */
function producer() {
  return { producer_id: "sub-exp-001", producer_kind: "sub_agent", session_id: "S-1" };
}

/** A minimal valid correlation. */
function correlation() {
  return { mission_id: "M-004", subagent_id: "sub-exp-001", parent_run_id: "R-001" };
}

/** Build a full valid envelope for a given event_name + payload. */
function makeEvent(eventName, payload) {
  return {
    event_id: et.generateEventId(),
    event_name: eventName,
    event_version: "1.0",
    bus_id: "macbook-pro-1:m-004",
    occurred_at: "2026-08-04T10:00:00.000Z",
    producer: producer(),
    correlation: correlation(),
    payload: payload,
  };
}

// ===========================================================================
// 1. Schema file existence + validity
// ===========================================================================

test("VC-002: all 10 schema files exist and are valid JSON", () => {
  const expected = [
    "envelope", "extension",
    "subagent_spawned", "subagent_progress", "subagent_completed",
    "subagent_failed", "subagent_cancelled", "handoff_ready",
    "decision_resolved", "waitpoint_released",
  ];
  for (const name of expected) {
    const file = path.join(schemasDir, `${name}.schema.json`);
    assert.ok(fs.existsSync(file), `Missing schema: ${name}.schema.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(parsed.$schema, "http://json-schema.org/draft-07/schema#",
      `${name} schema must be draft-07`);
    assert.ok(parsed.title, `${name} schema must have a title`);
  }
});

test("VC-002: listSchemas returns all 10 names", () => {
  const names = et.listSchemas();
  assert.strictEqual(names.length, 10);
  assert.ok(names.includes("envelope"));
  assert.ok(names.includes("extension"));
  for (const core of et.CORE_EVENT_NAMES) {
    assert.ok(names.includes(core), `listSchemas missing ${core}`);
  }
});

// ===========================================================================
// 2. Core event registry
// ===========================================================================

test("VC-002: exactly 8 core event names registered", () => {
  assert.strictEqual(et.CORE_EVENT_NAMES.length, 8);
  const expected = [
    "subagent_spawned", "subagent_progress", "subagent_completed",
    "subagent_failed", "subagent_cancelled", "handoff_ready",
    "decision_resolved", "waitpoint_released",
  ];
  assert.deepStrictEqual([...et.CORE_EVENT_NAMES].sort(), expected.sort());
});

test("VC-002: isKnownEvent accepts core + custom, rejects unknown", () => {
  assert.ok(et.isKnownEvent("subagent_completed"));
  assert.ok(et.isKnownEvent("custom:build_completed"));
  assert.ok(!et.isKnownEvent("unknown_event"));
  assert.ok(!et.isKnownEvent(""));
});

// ===========================================================================
// 3. Envelope validation
// ===========================================================================

test("VC-002: valid envelope passes", () => {
  const event = makeEvent("subagent_spawned", {
    subagent_role: "explore",
    task_description: "find usages",
  });
  const result = et.validateEvent(event);
  assert.ok(result.valid, `Expected valid: ${JSON.stringify(result.errors)}`);
});

test("VC-002: envelope rejects missing required fields", () => {
  const event = makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y" });
  delete event.event_id;
  const result = et.validateEvent(event);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("event_id")));
});

test("VC-002: envelope rejects bad event_id pattern", () => {
  const event = makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y" });
  event.event_id = "not-a-valid-id";
  const result = et.validateEvent(event);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("pattern") || e.includes("event_id")));
});

test("VC-002: envelope rejects bad bus_id pattern", () => {
  const event = makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y" });
  event.bus_id = "INVALID Bus ID";
  const result = et.validateEvent(event);
  assert.ok(!result.valid);
});

test("VC-002: envelope rejects unknown top-level property (additionalProperties:false)", () => {
  const event = makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y" });
  event.extra_field = "nope";
  const result = et.validateEvent(event);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("extra_field")));
});

test("VC-002: envelope rejects bad producer_kind enum", () => {
  const event = makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y" });
  event.producer.producer_kind = "hacker";
  const result = et.validateEvent(event);
  assert.ok(!result.valid);
});

test("VC-002: envelope accepts null session_id and causation_id", () => {
  const event = makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y" });
  event.producer.session_id = null;
  event.correlation.causation_id = null;
  const result = et.validateEvent(event);
  assert.ok(result.valid, `Errors: ${JSON.stringify(result.errors)}`);
});

// ===========================================================================
// 4. Per-event payload validation (pass cases)
// ===========================================================================

test("VC-002: subagent_spawned payload valid", () => {
  const r = et.validatePayload("subagent_spawned", {
    subagent_role: "explore", task_description: "find usages",
    tools_granted: ["read", "grep"], model: "MiniMax-M3", expected_duration_minutes: 15,
  });
  assert.ok(r.valid, JSON.stringify(r.errors));
});

test("VC-002: subagent_progress payload valid + range bounds", () => {
  assert.ok(et.validatePayload("subagent_progress", { percent: 0 }).valid);
  assert.ok(et.validatePayload("subagent_progress", { percent: 100 }).valid);
  assert.ok(et.validatePayload("subagent_progress", { percent: 50, current_step: "analyzing", tool_calls_count: 3 }).valid);
  // out of range
  assert.ok(!et.validatePayload("subagent_progress", { percent: 101 }).valid);
  assert.ok(!et.validatePayload("subagent_progress", { percent: -1 }).valid);
});

test("VC-002: subagent_completed payload valid + ack required", () => {
  const r = et.validatePayload("subagent_completed", {
    status: "success", output_summary: "found 5 usages",
    output_artifact_refs: ["runs/r1.json"], duration_actual_seconds: 42.5,
  });
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.ok(et.requiresAck("subagent_completed"));
  // partial status also valid
  assert.ok(et.validatePayload("subagent_completed", { status: "partial", output_summary: "partial" }).valid);
  // bad status enum
  assert.ok(!et.validatePayload("subagent_completed", { status: "error", output_summary: "x" }).valid);
});

test("VC-002: subagent_failed payload valid + ack required", () => {
  const r = et.validatePayload("subagent_failed", {
    status: "failed", error_code: "timeout", error_message: "exceeded 60s",
    retry_count: 2,
  });
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.ok(et.requiresAck("subagent_failed"));
  // missing required error_code
  assert.ok(!et.validatePayload("subagent_failed", { status: "failed", error_message: "x" }).valid);
});

test("VC-002: subagent_cancelled payload valid + no ack", () => {
  const r = et.validatePayload("subagent_cancelled", {
    reason: "user request", cancelled_by: "user",
  });
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.ok(!et.requiresAck("subagent_cancelled"));
  assert.ok(!et.validatePayload("subagent_cancelled", { cancelled_by: "user" }).valid); // missing reason
});

test("VC-002: handoff_ready payload valid", () => {
  const r = et.validatePayload("handoff_ready", {
    handoff_id: "H-001", handoff_path: ".agent/handoffs/h1.json",
    from_subagent_id: "sub-1", to_subagent_id: "sub-2",
    handoff_kind: "cross_session",
  });
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.ok(!et.validatePayload("handoff_ready", { handoff_id: "H-001" }).valid); // missing required
});

test("VC-002: decision_resolved payload valid", () => {
  const r = et.validatePayload("decision_resolved", {
    decision_id: "D-001", resolution: "approved", resolved_by: "eric",
  });
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.ok(!et.validatePayload("decision_resolved", { decision_id: "D-001", resolution: "maybe" }).valid);
});

test("VC-002: waitpoint_released payload valid", () => {
  const r = et.validatePayload("waitpoint_released", {
    waitpoint_id: "WP-001", release_reason: "approved",
    downstream_actions: ["resume-run"],
  });
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.ok(!et.validatePayload("waitpoint_released", { release_reason: "x" }).valid); // missing waitpoint_id
});

// ===========================================================================
// 5. Extension namespace (custom:*)
// ===========================================================================

test("VC-002: custom:* extension events accepted with any payload", () => {
  const r = et.validatePayload("custom:build_completed", { build_id: "b1", status: "green" });
  assert.ok(r.valid, JSON.stringify(r.errors));
  // empty payload also valid for extension
  assert.ok(et.validatePayload("custom:lint_passed", {}).valid);
  // isKnownEvent
  assert.ok(et.isKnownEvent("custom:anything"));
});

test("VC-002: custom:* event in full envelope passes", () => {
  const event = makeEvent("custom:deploy_done", { env: "staging" });
  const r = et.validateEvent(event);
  assert.ok(r.valid, JSON.stringify(r.errors));
});

// ===========================================================================
// 6. Event ID generation + buildEvent
// ===========================================================================

test("VC-002: generateEventId produces eb-evt-<uuid> format", () => {
  const id = et.generateEventId();
  assert.ok(id.startsWith("eb-evt-"), `Bad prefix: ${id}`);
  const uuid = id.slice("eb-evt-".length);
  // UUID v4 format: 8-4-4-4-12 hex
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("VC-002: generateEventId produces unique values", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(et.generateEventId());
  assert.strictEqual(ids.size, 1000);
});

test("VC-002: buildEvent creates valid envelope", () => {
  const event = et.buildEvent(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "done" } },
    {
      producer: { producer_id: "sub-1", producer_kind: "sub_agent", session_id: "S-1" },
      busId: "macbook-pro-1:m-004",
      missionId: "M-004",
      subagentId: "sub-1",
      parentRunId: "R-001",
    },
  );
  const r = et.validateEvent(event);
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.strictEqual(event.event_name, "subagent_completed");
  assert.strictEqual(event.event_version, "1.0");
  assert.strictEqual(event.correlation.mission_id, "M-004");
});

test("VC-002: buildEvent rejects unknown event_name", () => {
  assert.throws(() => {
    et.buildEvent({ event_name: "bogus", payload: {} }, {
      producer: { producer_id: "x", producer_kind: "cli" },
      busId: "host:global",
    });
  }, /Unknown event_name/);
});

test("VC-002: buildEvent defaults correlation to global/host", () => {
  const event = et.buildEvent(
    { event_name: "subagent_progress", payload: { percent: 10 } },
    {
      producer: { producer_id: "cli-1", producer_kind: "cli" },
      busId: "host:global",
    },
  );
  assert.strictEqual(event.correlation.mission_id, "global");
  assert.strictEqual(event.correlation.subagent_id, "host");
  assert.strictEqual(event.producer.session_id, null);
});

// ===========================================================================
// 7. ACK-required set completeness
// ===========================================================================

test("VC-002: only subagent_completed and subagent_failed require ack", () => {
  assert.strictEqual(et.ACK_REQUIRED_EVENTS.size, 2);
  for (const name of et.CORE_EVENT_NAMES) {
    const expected = name === "subagent_completed" || name === "subagent_failed";
    assert.strictEqual(et.requiresAck(name), expected, `ack mismatch for ${name}`);
  }
});
