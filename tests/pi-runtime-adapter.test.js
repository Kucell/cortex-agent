"use strict";

// ─── Pi Read-only Boundary Adapter tests (MS-004 / P-003) ──────────────────
//
// The Pi adapter is optional and absent-safe: importing it must never throw,
// Pi not being installed must produce an `unsupported` capability descriptor
// (not an exception), and mapping Pi-shaped events must emit a frozen
// boundary event that the frozen envelope validator accepts.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PI_ADAPTER_ID,
  PI_VENDOR,
  detectPi,
  mapMany,
  mapPiEventToBoundaryEvent,
} = require("../lib/runtime-adapters/pi-adapter");
const boundaryEvent = require("../lib/runtime-adapters/boundary-event");
const capabilityContract = require("../lib/runtime-adapters/capability-contract");

function baseEvent(overrides) {
  return Object.assign(
    {
      kind: "session",
      event: "start",
      ts: "2026-07-28T00:00:00.000Z",
      sessionId: "pi-session-1",
      seq: 0,
      correlation: {},
    },
    overrides || {}
  );
}

test("importing the Pi adapter does not throw and exports a stable surface", () => {
  assert.equal(PI_ADAPTER_ID, "pi");
  assert.equal(PI_VENDOR, "earendil-works");
  assert.equal(typeof detectPi, "function");
  assert.equal(typeof mapPiEventToBoundaryEvent, "function");
  assert.equal(typeof mapMany, "function");
});

test("detectPi reports absent as a frozen unsupported descriptor without throwing", () => {
  const probe = detectPi({ binary: "definitely-not-a-real-binary-xyz", timeoutMs: 250 });
  assert.equal(probe.available, false);
  assert.equal(probe.descriptor.host.adapter_id, "pi");
  assert.equal(probe.descriptor.host.version, "absent");
  for (const name of capabilityContract.CAPABILITY_NAMES) {
    assert.equal(probe.descriptor.capabilities[name].level, "unsupported");
  }
});

test("detectPi falls back to PATH lookup when no binary override is provided", () => {
  delete process.env.PI_BINARY;
  const probe = detectPi({ timeoutMs: 100 });
  assert.equal(probe.available, false);
  assert.ok(["not_on_path", "probe_failed", "spawn_failed", "unparseable_version", "no_binary"].includes(probe.reason));
});

test("mapPiEventToBoundaryEvent maps a session start into a frozen RBE envelope", () => {
  const event = mapPiEventToBoundaryEvent(baseEvent({ kind: "session", event: "start" }));
  assert.equal(event.schema_version, "1.0");
  assert.equal(event.type, "session.start");
  assert.equal(event.host.adapter_id, "pi");
  assert.equal(event.host.session_ref, "pi-session-1");
  assert.equal(event.at, "2026-07-28T00:00:00.000Z");
  assert.equal(event.event_id.startsWith(boundaryEvent.RUNTIME_BOUNDARY_EVENT_ID_PREFIX), true);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(event.evidence_refs.length, 0);
});

test("mapPiEventToBoundaryEvent maps turn and message lifecycle events", () => {
  const turnStart = mapPiEventToBoundaryEvent(baseEvent({ kind: "turn", event: "start", seq: 1 }));
  assert.equal(turnStart.type, "turn.start");
  const turnEnd = mapPiEventToBoundaryEvent(baseEvent({ kind: "turn", event: "end", seq: 2 }));
  assert.equal(turnEnd.type, "turn.end");
  const messageEnd = mapPiEventToBoundaryEvent(baseEvent({ kind: "message", event: "end", seq: 3 }));
  assert.equal(messageEnd.type, "message.end");
});

test("mapPiEventToBoundaryEvent maps tool events with resource, capability, and decision", () => {
  const before = mapPiEventToBoundaryEvent(baseEvent({
    kind: "tool",
    event: "before",
    seq: 4,
    toolName: "bash",
    resourceDigest: "sha256:9c1b1d5f6c2f4c7d8e9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
    capability: "tool.before.block",
    decision: {
      result: "allowed",
      authorization_ref: "OP-1:WAIT-1",
      reason: "explicit policy allows tool",
    },
    correlation: { task_id: "T-1", run_id: "R-1", session_id: "S-1" },
  }));
  assert.equal(before.type, "tool.before");
  assert.equal(before.resource.kind, "tool");
  assert.equal(before.resource.name, "bash");
  assert.equal(before.resource.target_digest.startsWith("sha256:"), true);
  assert.equal(before.capability, "tool.before.block");
  assert.equal(before.decision.result, "allowed");
  assert.equal(before.decision.authorization_ref, "OP-1:WAIT-1");
  assert.equal(before.correlation.task_id, "T-1");
  assert.equal(before.correlation.run_id, "R-1");
  assert.equal(before.correlation.session_id, "S-1");

  const after = mapPiEventToBoundaryEvent(baseEvent({
    kind: "tool",
    event: "after",
    seq: 5,
    toolName: "bash",
    capability: "tool.before.observe",
    decision: { result: "allowed", reason: "ok" },
  }));
  assert.equal(after.type, "tool.after");
  assert.equal(after.decision.result, "allowed");
});

test("mapPiEventToBoundaryEvent defaults tool decision to unavailable when omitted", () => {
  const event = mapPiEventToBoundaryEvent(baseEvent({
    kind: "tool",
    event: "before",
    seq: 6,
    toolName: "write",
    capability: "tool.before.observe",
  }));
  assert.equal(event.decision.result, "unavailable");
});

test("mapPiEventToBoundaryEvent emits deterministic event_id for identical inputs", () => {
  const a = mapPiEventToBoundaryEvent(baseEvent({ kind: "session", event: "start", seq: 7 }));
  const b = mapPiEventToBoundaryEvent(baseEvent({ kind: "session", event: "start", seq: 7 }));
  assert.equal(a.event_id, b.event_id);
});

test("mapPiEventToBoundaryEvent never persists prompts, tool args, or secrets", () => {
  const event = mapPiEventToBoundaryEvent(baseEvent({
    kind: "message",
    event: "end",
    seq: 8,
    toolName: "bash",
    prompt: "SECRET-PROMPT-9f3c1e",
    args: "rm -rf /",
    correlation: { task_id: "T-9", run_id: "R-9" },
  }));
  assert.equal(JSON.stringify(event).includes("SECRET-PROMPT"), false);
  assert.equal(JSON.stringify(event).includes("rm -rf"), false);
});

test("mapPiEventToBoundaryEvent rejects unknown Pi event shapes with a typed error", () => {
  assert.throws(
    () => mapPiEventToBoundaryEvent({}),
    (err) => err.code === "ERR_KIND_REQUIRED"
  );
  assert.throws(
    () => mapPiEventToBoundaryEvent({ kind: "session", event: "explode", ts: "2026-07-28T00:00:00.000Z" }),
    (err) => err.code === "ERR_EVENT_TYPE_MAPPING"
  );
  assert.throws(
    () => mapPiEventToBoundaryEvent(baseEvent({ ts: "not-iso" })),
    (err) => err.code === "ERR_TIMESTAMP_INVALID"
  );
});

test("mapMany maps an empty array to an empty array and keeps order for the rest", () => {
  assert.deepEqual(mapMany([]), []);
  const events = [
    baseEvent({ kind: "session", event: "start", seq: 0 }),
    baseEvent({ kind: "turn", event: "start", seq: 1 }),
    baseEvent({ kind: "turn", event: "end", seq: 2 }),
    baseEvent({ kind: "session", event: "end", seq: 3 }),
  ];
  const mapped = mapMany(events);
  assert.deepEqual(mapped.map((e) => e.type), [
    "session.start",
    "turn.start",
    "turn.end",
    "session.end",
  ]);
  for (const event of mapped) assert.equal(Object.isFrozen(event), true);
});

test("Pi adapter remains absent-safe when Pi is not installed (default probe)", () => {
  // We do not require Pi to be installed for this suite. The probe must
  // always succeed with `available: false` and an `unsupported` descriptor.
  delete process.env.PI_BINARY;
  const probe = detectPi({ timeoutMs: 200 });
  assert.equal(probe.available, false);
  assert.equal(probe.descriptor.host.adapter_id, "pi");
});

test("Pi adapter does not throw when probed concurrently", async () => {
  delete process.env.PI_BINARY;
  const probes = await Promise.all(
    Array.from({ length: 8 }, () => Promise.resolve(detectPi({ timeoutMs: 100 })))
  );
  assert.equal(probes.length, 8);
  for (const probe of probes) assert.equal(probe.available, false);
});