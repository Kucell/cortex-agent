"use strict";

// ─── Cursor Read-only Boundary Adapter tests (MS-011 / P-003) ──────────────
//
// VC-011-01: Cursor and Pi adapters are optional, version-aware, fail-visible,
// and do not become authorization owners.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CURSOR_ADAPTER_ID,
  CURSOR_VENDOR,
  detectCursor,
  mapCursorEventToBoundaryEvent,
  mapMany,
} = require("../../lib/runtime-adapters/cursor-adapter");
const boundaryEvent = require("../../lib/runtime-adapters/boundary-event");
const capabilityContract = require("../../lib/runtime-adapters/capability-contract");
const piAdapter = require("../../lib/runtime-adapters/pi-adapter");

function baseEvent(overrides) {
  return Object.assign({
    kind: "session",
    event: "start",
    ts: "2026-07-28T00:00:00.000Z",
    sessionId: "cursor-session-1",
    seq: 0,
    correlation: {},
  }, overrides || {});
}

test("importing the Cursor adapter does not throw and exports a stable surface", () => {
  assert.equal(CURSOR_ADAPTER_ID, "cursor");
  assert.equal(CURSOR_VENDOR, "cursor-sh");
  assert.equal(typeof detectCursor, "function");
  assert.equal(typeof mapCursorEventToBoundaryEvent, "function");
  assert.equal(typeof mapMany, "function");
});

test("detectCursor reports absent as a frozen unsupported descriptor without throwing", () => {
  const probe = detectCursor({ binary: "definitely-not-a-real-binary-xyz", timeoutMs: 250 });
  assert.equal(probe.available, false);
  assert.equal(probe.descriptor.host.adapter_id, "cursor");
  assert.equal(probe.descriptor.host.version, "absent");
  for (const name of capabilityContract.CAPABILITY_NAMES) {
    assert.equal(probe.descriptor.capabilities[name].level, "unsupported");
  }
});

test("mapCursorEventToBoundaryEvent maps a session start into a frozen RBE envelope", () => {
  const event = mapCursorEventToBoundaryEvent(baseEvent({ kind: "session", event: "start" }));
  assert.equal(event.schema_version, "1.0");
  assert.equal(event.type, "session.start");
  assert.equal(event.host.adapter_id, "cursor");
  assert.equal(event.host.session_ref, "cursor-session-1");
  assert.equal(Object.isFrozen(event), true);
});

test("mapCursorEventToBoundaryEvent maps turn, message, and tool events", () => {
  assert.equal(mapCursorEventToBoundaryEvent(baseEvent({ kind: "turn", event: "start", seq: 1 })).type, "turn.start");
  assert.equal(mapCursorEventToBoundaryEvent(baseEvent({ kind: "message", event: "end", seq: 2 })).type, "message.end");
  const tool = mapCursorEventToBoundaryEvent(baseEvent({
    kind: "tool",
    event: "before",
    seq: 3,
    toolName: "edit",
    capability: "tool.before.block",
    decision: { result: "denied", reason: "policy blocks edits during planning" },
  }));
  assert.equal(tool.type, "tool.before");
  assert.equal(tool.resource.name, "edit");
  assert.equal(tool.capability, "tool.before.block");
  assert.equal(tool.decision.result, "denied");
});

test("mapCursorEventToBoundaryEvent rejects unknown event shapes with a typed error", () => {
  assert.throws(() => mapCursorEventToBoundaryEvent({}), (err) => err.code === "ERR_KIND_REQUIRED");
  assert.throws(
    () => mapCursorEventToBoundaryEvent({ kind: "session", event: "explode", ts: "2026-07-28T00:00:00.000Z" }),
    (err) => err.code === "ERR_EVENT_TYPE_MAPPING"
  );
});

test("mapCursorEventToBoundaryEvent never persists prompts, tool args, or secrets", () => {
  const event = mapCursorEventToBoundaryEvent(baseEvent({
    kind: "tool",
    event: "after",
    seq: 5,
    toolName: "bash",
    prompt: "SECRET-CURSOR-PROMPT-1a2b3c",
    args: "rm -rf /etc",
    correlation: { task_id: "T-7" },
  }));
  assert.equal(JSON.stringify(event).includes("SECRET-CURSOR-PROMPT"), false);
  assert.equal(JSON.stringify(event).includes("rm -rf"), false);
});

test("Cursor adapter does not acquire authority over Decision/Waitpoint/Operation", () => {
  // The adapter exposes no API to resolve a Decision, release a Waitpoint,
  // or advance an Operation. It is a pure mapper.
  const exportedKeys = Object.keys(require("../../lib/runtime-adapters/cursor-adapter"));
  for (const forbidden of ["resolveDecision", "releaseWaitpoint", "closeOperation", "approveAnything"]) {
    assert.equal(exportedKeys.includes(forbidden), false, `Cursor adapter must not export ${forbidden}`);
  }
});

test("Pi adapter does not acquire authority over Decision/Waitpoint/Operation", () => {
  const exportedKeys = Object.keys(piAdapter);
  for (const forbidden of ["resolveDecision", "releaseWaitpoint", "closeOperation", "approveAnything"]) {
    assert.equal(exportedKeys.includes(forbidden), false, `Pi adapter must not export ${forbidden}`);
  }
});

test("Cursor adapter is version-aware and absent-safe", () => {
  delete process.env.CURSOR_BINARY;
  const probe = detectCursor({ timeoutMs: 100 });
  assert.equal(probe.available, false);
  assert.equal(probe.descriptor.host.adapter_id, "cursor");
});

test("mapMany maps an empty array and preserves order for the rest", () => {
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

test("Cursor and Pi adapters share the same envelope validator", () => {
  const cursorEvent = mapCursorEventToBoundaryEvent(baseEvent({ kind: "session", event: "start" }));
  const piEvent = piAdapter.mapPiEventToBoundaryEvent({
    kind: "session",
    event: "start",
    ts: "2026-07-28T00:00:00.000Z",
    sessionId: "pi-session-1",
    seq: 0,
    correlation: {},
  });
  assert.equal(cursorEvent.schema_version, piEvent.schema_version);
  assert.equal(cursorEvent.type, piEvent.type);
  assert.equal(cursorEvent.host.adapter_id, "cursor");
  assert.equal(piEvent.host.adapter_id, "pi");
});