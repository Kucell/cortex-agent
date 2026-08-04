"use strict";

// Tests for M-004 MS-001 VC-003: subscribe API.
//
// Strategy:
//   - Filter matching (event_names, namespace, correlation)
//   - Handler invocation on publish
//   - Ack written on delivery
//   - Wildcard event_names matching (subagent_*)
//   - Multiple subscribers
//   - Unsubscribe
//   - list / history API
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-003
//   - docs/architecture/framework-event-bus-design.md §4.1

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("os");
const path = require("node:path");
const test = require("node:test");

const { createEventBus } = require("../lib/event-bus/event-bus");

let _c = 0;
function tmpDir() {
  const d = path.join(os.tmpdir(), "eb-sub-" + process.pid + "-" + (++_c));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function makeBus(dir) {
  return createEventBus({ busId: "test-host:m-004", dataDir: dir, fsync: false });
}
function ctx() {
  return { producer: { producer_id: "sub-1", producer_kind: "sub_agent" },
    missionId: "M-004", subagentId: "sub-1", parentRunId: "R-001" };
}

// 1. Basic subscribe + handler call
test("VC-003: subscribe returns subscription_id", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe({ event_names: ["subagent_completed"] }, () => ({ ack: true }));
  assert.ok(subId.startsWith("sub-"));
  bus.close();
});

test("VC-003: handler receives matching event on publish", () => {
  const bus = makeBus(tmpDir());
  let received = null;
  bus.subscribe({ event_names: ["subagent_completed"] }, (event) => {
    received = event;
    return { ack: true };
  });
  bus.publish(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "done" } },
    ctx()
  );
  assert.ok(received, "Handler should have received event");
  assert.strictEqual(received.event_name, "subagent_completed");
  bus.close();
});

// 2. Filter matching
test("VC-003: handler not called for non-matching event_name", () => {
  const bus = makeBus(tmpDir());
  let called = false;
  bus.subscribe({ event_names: ["subagent_failed"] }, () => { called = true; return { ack: true }; });
  bus.publish(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "done" } },
    ctx()
  );
  assert.ok(!called, "Handler should NOT be called for non-matching event");
  bus.close();
});

test("VC-003: wildcard event_names match (subagent_*)", () => {
  const bus = makeBus(tmpDir());
  let count = 0;
  bus.subscribe({ event_names: ["subagent_*"] }, () => { count++; return { ack: true }; });
  bus.publish({ event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } }, ctx());
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  bus.publish({ event_name: "subagent_progress", payload: { percent: 50 } }, ctx());
  bus.publish({ event_name: "decision_resolved", payload: { decision_id: "d1", resolution: "approved" } }, ctx());
  assert.strictEqual(count, 3, "Should match 3 subagent_* events");
  bus.close();
});

test("VC-003: multiple event_names in filter", () => {
  const bus = makeBus(tmpDir());
  let count = 0;
  bus.subscribe({ event_names: ["subagent_completed", "subagent_failed"] }, () => { count++; return { ack: true }; });
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  bus.publish({ event_name: "subagent_failed", payload: { status: "failed", error_code: "e", error_message: "m" } }, ctx());
  bus.publish({ event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } }, ctx());
  assert.strictEqual(count, 2);
  bus.close();
});

test("VC-003: correlation filter matches mission_id", () => {
  const bus = makeBus(tmpDir());
  let received = [];
  bus.subscribe(
    { event_names: ["subagent_completed"], correlation: { mission_id: "M-004" } },
    (e) => { received.push(e); return { ack: true }; }
  );
  bus.publish(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "a" } },
    { producer: { producer_id: "s", producer_kind: "sub_agent" }, missionId: "M-004", subagentId: "s", parentRunId: "r" }
  );
  bus.publish(
    { event_name: "subagent_completed", payload: { status: "success", output_summary: "b" } },
    { producer: { producer_id: "s", producer_kind: "sub_agent" }, missionId: "M-099", subagentId: "s", parentRunId: "r" }
  );
  assert.strictEqual(received.length, 1, "Should only match M-004");
  bus.close();
});

test("VC-003: correlation filter matches subagent_id", () => {
  const bus = makeBus(tmpDir());
  let count = 0;
  bus.subscribe(
    { correlation: { subagent_id: "sub-exp-001" } },
    () => { count++; return { ack: true }; }
  );
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "a" } },
    { producer: { producer_id: "s", producer_kind: "sub_agent" }, missionId: "M", subagentId: "sub-exp-001", parentRunId: "r" });
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "b" } },
    { producer: { producer_id: "s", producer_kind: "sub_agent" }, missionId: "M", subagentId: "sub-exp-002", parentRunId: "r" });
  assert.strictEqual(count, 1);
  bus.close();
});

// 3. Multiple subscribers
test("VC-003: multiple subscribers each receive matching events", () => {
  const bus = makeBus(tmpDir());
  let countA = 0, countB = 0;
  bus.subscribe({ event_names: ["subagent_completed"] }, () => { countA++; return { ack: true }; });
  bus.subscribe({ event_names: ["subagent_failed"] }, () => { countB++; return { ack: true }; });
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  bus.publish({ event_name: "subagent_failed", payload: { status: "failed", error_code: "e", error_message: "m" } }, ctx());
  assert.strictEqual(countA, 1);
  assert.strictEqual(countB, 1);
  bus.close();
});

// 4. Unsubscribe
test("VC-003: unsubscribe stops handler calls", () => {
  const bus = makeBus(tmpDir());
  let count = 0;
  const subId = bus.subscribe({ event_names: ["subagent_completed"] }, () => { count++; return { ack: true }; });
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "a" } }, ctx());
  assert.strictEqual(count, 1);
  bus.unsubscribe(subId);
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "b" } }, ctx());
  assert.strictEqual(count, 1, "No more calls after unsubscribe");
  bus.close();
});

// 5. List API
test("VC-003: list returns all events with total count", () => {
  const bus = makeBus(tmpDir());
  bus.publish({ event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } }, ctx());
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  const { events, total } = bus.list();
  assert.strictEqual(total, 2);
  assert.strictEqual(events.length, 2);
  bus.close();
});

test("VC-003: list filters by event_name", () => {
  const bus = makeBus(tmpDir());
  bus.publish({ event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } }, ctx());
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "e" } }, ctx());
  const { events, total } = bus.list({ event_name: "subagent_completed" });
  assert.strictEqual(events.length, 2);
  assert.strictEqual(total, 3);
  bus.close();
});

test("VC-003: list respects limit + next_offset", () => {
  const bus = makeBus(tmpDir());
  for (let i = 0; i < 10; i++) {
    bus.publish({ event_name: "subagent_progress", payload: { percent: i * 10 } }, ctx());
  }
  const r1 = bus.list({ limit: 3, offset: 0 });
  assert.strictEqual(r1.events.length, 3);
  assert.ok(r1.next_offset > 0);
  const r2 = bus.list({ limit: 3, offset: r1.next_offset });
  assert.strictEqual(r2.events.length, 3);
  bus.close();
});

// 6. History API
test("VC-003: history returns acks + events + stats", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe({ event_names: ["subagent_completed"] }, () => ({ ack: true }));
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  const hist = bus.history(subId);
  assert.ok(hist.acks.length >= 1);
  assert.ok(hist.events.length >= 1);
  assert.strictEqual(hist.stats.acked, hist.acks.length);
  bus.close();
});

// 7. No filter = receive all
test("VC-003: subscribe with no filter receives all events", () => {
  const bus = makeBus(tmpDir());
  let count = 0;
  bus.subscribe({}, () => { count++; return { ack: true }; });
  bus.publish({ event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } }, ctx());
  bus.publish({ event_name: "decision_resolved", payload: { decision_id: "d1", resolution: "approved" } }, ctx());
  assert.strictEqual(count, 2);
  bus.close();
});

// 8. Sub persists across restart (handler lost, sub record kept)
test("VC-003: subscription record persists in subs.json", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  const subId = bus.subscribe({ event_names: ["subagent_completed"] }, () => ({ ack: true }));
  bus.close();
  const subs = JSON.parse(fs.readFileSync(path.join(dir, "subs.json"), "utf8"));
  assert.strictEqual(subs.subscriptions.length, 1);
  assert.strictEqual(subs.subscriptions[0].subscription_id, subId);
});
