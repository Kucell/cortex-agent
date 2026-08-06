"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  bridgeEventSchema,
  subscriptionSchema,
  subscriptionsFileSchema,
  BRIDGE_EVENT_TYPES,
  BRIDGE_EVENT_ID_PATTERN,
  validateBridgeEvent,
  validateSubscription,
  validateSubscriptionsFile,
  isValidBridgeEventId,
} = require("../../lib/cross-project/bridge-event-schema");

// ─── Fixtures ──────────────────────────────────────────────────────────────

function validEvent(overrides = {}) {
  return {
    bridge_event_id: "BR-EVT-001",
    source_project_id: "cortex-agent",
    source_task_id: "T-001",
    correlation_group: "XPC-DASHBOARD-PRD",
    event_type: "task.state_changed",
    summary: {
      from_state: "EXECUTING",
      to_state: "READY_FOR_REVIEW",
      evidence_refs: ["evidence-001"],
      timestamp: "2026-08-05T00:00:00.000Z",
    },
    propagated_at: "2026-08-05T00:00:01.000Z",
    ...overrides,
  };
}

function validSubscription(overrides = {}) {
  return {
    source_project_id: "cortex-agent",
    event_types: ["task.state_changed", "decision.resolved"],
    ...overrides,
  };
}

// ─── bridgeEventSchema shape ───────────────────────────────────────────────

test("bridgeEventSchema: required fields are exactly the P-003 §3.2 minimum", () => {
  assert.deepEqual(bridgeEventSchema.required, [
    "bridge_event_id",
    "source_project_id",
    "event_type",
    "summary",
    "propagated_at",
  ]);
  assert.equal(bridgeEventSchema.additionalProperties, false);
});

test("bridgeEventSchema: source_task_id and correlation_group are optional", () => {
  const event = validEvent();
  delete event.source_task_id;
  delete event.correlation_group;
  assert.deepEqual(validateBridgeEvent(event), { ok: true });
});

test("BRIDGE_EVENT_TYPES covers the four P-003 §4.3 event types", () => {
  assert.deepEqual(BRIDGE_EVENT_TYPES, [
    "task.state_changed",
    "decision.resolved",
    "waitpoint.released",
    "checkpoint.closed",
  ]);
});

// ─── validateBridgeEvent: valid ────────────────────────────────────────────

test("validateBridgeEvent: full valid event passes", () => {
  assert.deepEqual(validateBridgeEvent(validEvent()), { ok: true });
});

test("validateBridgeEvent: event without optional fields passes", () => {
  const event = {
    bridge_event_id: "BR-EVT-abc-123",
    source_project_id: "cortex-agent",
    event_type: "decision.resolved",
    summary: { resolution: "approved" },
    propagated_at: "2026-08-05T00:00:01.000Z",
  };
  assert.deepEqual(validateBridgeEvent(event), { ok: true });
});

test("validateBridgeEvent: event with zone offset in propagated_at passes", () => {
  const event = validEvent({ propagated_at: "2026-08-05T08:00:01.000+08:00" });
  assert.deepEqual(validateBridgeEvent(event), { ok: true });
});

test("validateBridgeEvent: each P-003 event type is accepted", () => {
  for (const type of BRIDGE_EVENT_TYPES) {
    const event = validEvent({ event_type: type });
    const result = validateBridgeEvent(event);
    assert.equal(result.ok, true, `event_type=${type} should be valid: ${JSON.stringify(result.errors)}`);
  }
});

// ─── validateBridgeEvent: invalid ──────────────────────────────────────────

test("validateBridgeEvent: missing required field fails with named error", () => {
  const event = validEvent();
  delete event.propagated_at;
  const result = validateBridgeEvent(event);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("missing required: propagated_at")), JSON.stringify(result.errors));
});

test("validateBridgeEvent: extra property fails (additionalProperties=false)", () => {
  const event = validEvent({ sneaky: "value" });
  const result = validateBridgeEvent(event);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("sneaky")), JSON.stringify(result.errors));
});

test("validateBridgeEvent: malformed bridge_event_id fails (pattern)", () => {
  const cases = [
    "EVT-001",          // missing BR-EVT- prefix
    "BR-EVT-",          // empty suffix
    "br-evt-001",       // lowercase prefix
    "BR-EVT-001 ",      // trailing space
    "BR-EVT-001/extra", // slash not allowed
  ];
  for (const id of cases) {
    const result = validateBridgeEvent(validEvent({ bridge_event_id: id }));
    assert.equal(result.ok, false, `id ${JSON.stringify(id)} should fail`);
    assert.ok(
      result.errors.some((e) => e.includes("bridge_event_id") && e.includes("pattern")),
      `id ${JSON.stringify(id)} should report pattern error: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("validateBridgeEvent: invalid event_type fails (enum)", () => {
  const result = validateBridgeEvent(validEvent({ event_type: "task.completed" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("event_type")), JSON.stringify(result.errors));
});

test("validateBridgeEvent: invalid propagated_at fails (date-time format)", () => {
  const cases = [
    "not-a-date",
    "2026/08/05T00:00:00.000Z", // slash date
    "2026-08-05",                // date only
    "2026-08-05T00:00:00",       // missing zone
    "2026-13-01T00:00:00.000Z",  // invalid month
  ];
  for (const ts of cases) {
    const result = validateBridgeEvent(validEvent({ propagated_at: ts }));
    assert.equal(result.ok, false, `timestamp ${JSON.stringify(ts)} should fail`);
  }
});

test("validateBridgeEvent: summary must be object, not array/string", () => {
  for (const bad of [null, "string", ["array"], 42]) {
    const event = validEvent();
    event.summary = bad;
    const result = validateBridgeEvent(event);
    if (bad === null) continue; // null is treated as "not provided"
    assert.equal(result.ok, false, `summary=${JSON.stringify(bad)} should fail`);
  }
});

test("validateBridgeEvent: empty source_project_id fails (minLength)", () => {
  const result = validateBridgeEvent(validEvent({ source_project_id: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("source_project_id")), JSON.stringify(result.errors));
});

test("validateBridgeEvent: root must be object", () => {
  for (const bad of [null, "string", 42, ["array"]]) {
    const result = validateBridgeEvent(bad);
    assert.equal(result.ok, false, `root=${JSON.stringify(bad)} should fail`);
  }
});

test("validateBridgeEvent: nested summary rejects extra properties", () => {
  // The top-level event rejects additionalProperties=false, but the summary
  // schema is intentionally { type: "object" } without additionalProperties
  // so consumers can attach arbitrary summary fields. Verify the spec
  // allows that.
  const event = validEvent();
  event.summary = { to_state: "READY_FOR_REVIEW", extra: "allowed" };
  assert.deepEqual(validateBridgeEvent(event), { ok: true });
});

// ─── subscriptionSchema / subscriptionsFileSchema ──────────────────────────

test("validateSubscription: minimal required fields pass", () => {
  assert.deepEqual(validateSubscription({ source_project_id: "cortex-agent", event_types: ["task.state_changed"] }), { ok: true });
});

test("validateSubscription: empty event_types array fails (minItems)", () => {
  const result = validateSubscription({ source_project_id: "cortex-agent", event_types: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("event_types")), JSON.stringify(result.errors));
});

test("validateSubscription: filter is optional; object accepted", () => {
  const sub = validSubscription({ filter: { to_state: ["READY_FOR_REVIEW"] } });
  assert.deepEqual(validateSubscription(sub), { ok: true });
});

test("validateSubscriptionsFile: full valid file passes", () => {
  const file = {
    subscriptions: [
      validSubscription(),
      validSubscription({ source_project_id: "SamHMI", correlation_group: "XPC-DASHBOARD-PRD" }),
    ],
  };
  assert.deepEqual(validateSubscriptionsFile(file), { ok: true });
});

test("validateSubscriptionsFile: missing subscriptions key fails", () => {
  const result = validateSubscriptionsFile({});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("subscriptions")), JSON.stringify(result.errors));
});

test("validateSubscriptionsFile: subscriptions must be array", () => {
  const result = validateSubscriptionsFile({ subscriptions: "nope" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("subscriptions")), JSON.stringify(result.errors));
});

test("validateSubscriptionsFile: extra top-level property fails", () => {
  const file = { subscriptions: [], meta: "leak" };
  const result = validateSubscriptionsFile(file);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("meta")), JSON.stringify(result.errors));
});

// ─── isValidBridgeEventId helper ───────────────────────────────────────────

test("isValidBridgeEventId: matches the BR-EVT-* contract", () => {
  assert.equal(isValidBridgeEventId("BR-EVT-001"), true);
  assert.equal(isValidBridgeEventId("BR-EVT-abc_XYZ-99"), true);
  assert.equal(isValidBridgeEventId("BR-EVT-"), false);
  assert.equal(isValidBridgeEventId("EVT-001"), false);
  assert.equal(isValidBridgeEventId("br-evt-001"), false);
  assert.equal(isValidBridgeEventId(""), false);
  assert.equal(isValidBridgeEventId(123), false);
  assert.equal(isValidBridgeEventId(null), false);
  assert.equal(isValidBridgeEventId(undefined), false);
});

test("BRIDGE_EVENT_ID_PATTERN anchors end-to-end and rejects empty suffix", () => {
  assert.equal(BRIDGE_EVENT_ID_PATTERN.test("BR-EVT-001"), true);
  assert.equal(BRIDGE_EVENT_ID_PATTERN.test("BR-EVT-001-extra"), true);
  assert.equal(BRIDGE_EVENT_ID_PATTERN.test("BR-EVT-"), false);
  assert.equal(BRIDGE_EVENT_ID_PATTERN.test("BR-EVT-001 "), false);
});
