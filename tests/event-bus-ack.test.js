"use strict";

// Tests for M-004 MS-001 VC-003/VC-010: ack mechanism.
//
// Strategy:
//   - ack success writes ack record
//   - ack timeout triggers retry
//   - 3 failures -> escalate
//   - ack rejected status
//   - ack persistence across restart
//   - ack required only for subagent_completed + subagent_failed
//   - non-ack events auto-ack
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-003, VC-010
//   - docs/architecture/framework-event-bus-design.md §5.5

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEventBus } = require("../lib/event-bus/event-bus");

let _c = 0;
function tmpDir() {
  const d = path.join(os.tmpdir(), "eb-ack-" + process.pid + "-" + (++_c));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function makeBus(dir, opts) {
  return createEventBus({ busId: "test-host:m-004", dataDir: dir, fsync: false, ...(opts||{}) });
}
function ctx() {
  return { producer: { producer_id: "sub-1", producer_kind: "sub_agent" },
    missionId: "M-004", subagentId: "sub-1", parentRunId: "R-001" };
}

// 1. ack success
test("VC-003: ack success writes ack record with status", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe({ event_names: ["subagent_completed"] }, () => ({ ack: true }));
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  const hist = bus.history(subId);
  assert.strictEqual(hist.acks.length, 1);
  assert.strictEqual(hist.acks[0].status, "success");
  bus.close();
});

test("VC-003: ack with explicit status via bus.ack()", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  const subId = bus.subscribe({ event_names: ["subagent_completed"] }, () => ({ ack: true }));
  const r = bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  bus.ack(subId, r.event_id, "rejected");
  const hist = bus.history(subId);
  assert.ok(hist.acks.some((a) => a.status === "rejected"));
  bus.close();
});

// 2. ack required events
test("VC-010: subagent_completed requires ack", () => {
  const bus = makeBus(tmpDir());
  let called = false;
  const subId = bus.subscribe(
    { event_names: ["subagent_completed"] },
    () => { called = true; return { ack: true }; },
    { retryCount: 1 }
  );
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  assert.ok(called, "Handler should be called for ack-required event");
  const hist = bus.history(subId);
  assert.ok(hist.acks.some((a) => a.status === "success"));
  bus.close();
});

test("VC-010: subagent_failed requires ack", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe(
    { event_names: ["subagent_failed"] },
    () => ({ ack: true }),
    { retryCount: 1 }
  );
  bus.publish({ event_name: "subagent_failed", payload: { status: "failed", error_code: "e", error_message: "m" } }, ctx());
  const hist = bus.history(subId);
  assert.ok(hist.acks.some((a) => a.status === "success"));
  bus.close();
});

// 3. Non-ack events auto-ack
test("VC-003: non-ack-required event auto-acks on delivery", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe({ event_names: ["subagent_spawned"] }, () => ({ ack: true }));
  bus.publish({ event_name: "subagent_spawned", payload: { subagent_role: "x", task_description: "y" } }, ctx());
  const hist = bus.history(subId);
  assert.ok(hist.acks.length >= 1, "Non-ack event should still get ack record");
  bus.close();
});

// 4. Retry on handler failure
test("VC-010: handler failure triggers retry up to retryCount", () => {
  const bus = makeBus(tmpDir());
  let attempts = 0;
  const subId = bus.subscribe(
    { event_names: ["subagent_completed"] },
    () => {
      attempts++;
      if (attempts < 2) throw new Error("fail");
      return { ack: true };
    },
    { retryCount: 3 }
  );
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  // Wait for retries (10ms each)
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.ok(attempts >= 2, "Should have retried at least once");
      const hist = bus.history(subId);
      assert.ok(hist.acks.some((a) => a.status === "success"), "Should eventually succeed");
      bus.close();
      resolve();
    }, 100);
  });
});

// 5. Escalate after max retries
test("VC-010: 3 failures -> escalate status", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe(
    { event_names: ["subagent_completed"] },
    () => { throw new Error("always fail"); },
    { retryCount: 2 }
  );
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  return new Promise((resolve) => {
    setTimeout(() => {
      const hist = bus.history(subId);
      const escalated = hist.acks.filter((a) => a.status === "escalated");
      assert.ok(escalated.length >= 1, "Should have escalated after max retries");
      bus.close();
      resolve();
    }, 150);
  });
});

// 6. Handler returns ack:false -> escalate for ack-required events
test("VC-010: handler ack:false on ack-required -> escalate", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe(
    { event_names: ["subagent_completed"] },
    () => ({ ack: false }),
    { retryCount: 1 }
  );
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  return new Promise((resolve) => {
    setTimeout(() => {
      const hist = bus.history(subId);
      assert.ok(hist.acks.some((a) => a.status === "escalated"), "Should escalate on ack:false");
      bus.close();
      resolve();
    }, 100);
  });
});

// 7. Async handler
test("VC-003: async handler returns ack via Promise", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe(
    { event_names: ["subagent_completed"] },
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ack: true };
    },
    { retryCount: 1 }
  );
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  return new Promise((resolve) => {
    setTimeout(() => {
      const hist = bus.history(subId);
      assert.ok(hist.acks.some((a) => a.status === "success"), "Async handler should ack");
      bus.close();
      resolve();
    }, 50);
  });
});

// 8. ack record persistence
test("VC-003: ack records persist to acks/<sub>.acks.jsonl", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  const subId = bus.subscribe({ event_names: ["subagent_completed"] }, () => ({ ack: true }));
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  bus.close();
  const ackPath = path.join(dir, "acks", subId + ".acks.jsonl");
  assert.ok(fs.existsSync(ackPath), "Ack file should exist");
  const acks = fs.readFileSync(ackPath, "utf8").split("\n").filter((l) => l.trim());
  assert.ok(acks.length >= 1);
  const ack = JSON.parse(acks[0]);
  assert.ok(ack.event_id);
  assert.ok(ack.status);
  assert.ok(ack.acked_at);
});

// 9. history stats
test("VC-003: history stats count acked/retried/escalated", () => {
  const bus = makeBus(tmpDir());
  const subId = bus.subscribe(
    { event_names: ["subagent_completed"] },
    () => ({ ack: true }),
    { retryCount: 3 }
  );
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "a" } }, ctx());
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "b" } }, ctx());
  const hist = bus.history(subId);
  assert.strictEqual(hist.stats.acked, 2);
  assert.strictEqual(hist.stats.retried, 0);
  assert.strictEqual(hist.stats.escalated, 0);
  bus.close();
});

// 10. ctx passed to handler
test("VC-003: handler receives ctx with subscription_id + mission_id", () => {
  const bus = makeBus(tmpDir());
  let receivedCtx = null;
  bus.subscribe({ event_names: ["subagent_completed"] }, (event, c) => {
    receivedCtx = c;
    return { ack: true };
  });
  bus.publish({ event_name: "subagent_completed", payload: { status: "success", output_summary: "d" } }, ctx());
  assert.ok(receivedCtx);
  assert.ok(receivedCtx.subscription_id);
  assert.strictEqual(receivedCtx.mission_id, "M-004");
  bus.close();
});
