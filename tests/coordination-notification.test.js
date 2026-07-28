"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createEvent, STATES } = require("../lib/coordination/contract");
const { Journal } = require("../lib/coordination/journal");
const {
  ConsumerCursorStore,
  cursorFileName,
} = require("../lib/coordination/consumer-cursor");
const {
  computeBackoff,
  deliveryKey,
  evaluateNotification,
} = require("../lib/coordination/notification-policy");
const { NotificationPump } = require("../lib/coordination/notification-pump");

const dirs = new Set();

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-notification-"));
  dirs.add(dir);
  return dir;
}

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const coordinator = { actorId: "coordinator", kind: "coordinator" };

function makeEvent(overrides = {}) {
  return createEvent({
    eventId: "CE-1",
    projectId: "project",
    taskId: "TASK-1",
    correlationId: "CORR-1",
    producer: { actorId: "agent-a", kind: "agent" },
    targets: [coordinator],
    eventType: "task.ready_for_review",
    previousState: STATES.TESTING,
    currentState: STATES.READY_FOR_REVIEW,
    timestamp: "2026-07-28T00:00:00.000Z",
    sequence: 1,
    evidence: [{ kind: "artifact", ref: "ARTIFACT-1" }],
    notification: {
      policy: "coordinator_notify",
      dedupeKey: "ready",
      ackRequired: true,
    },
    ...overrides,
  });
}

function openFixture(events) {
  const root = freshDir();
  const journal = Journal.open(path.join(root, "journal"), { lock: false, fsync: false });
  for (const event of events) journal.append(event);
  const cursor = new ConsumerCursorStore(path.join(root, "consumers"), "codex-coordinator");
  return { root, journal, cursor };
}

test("policy keeps journal_only quiet and makes critical delivery ACK-required", () => {
  const quiet = evaluateNotification(makeEvent({
    eventType: "task.heartbeat",
    previousState: STATES.EXECUTING,
    currentState: STATES.EXECUTING,
    notification: { policy: "journal_only", dedupeKey: "heartbeat", ackRequired: false },
  }));
  assert.equal(quiet.deliver, false);
  assert.equal(quiet.ackRequired, false);

  const critical = evaluateNotification(makeEvent({
    notification: { policy: "coordinator_notify", dedupeKey: "ready", ackRequired: false },
  }));
  assert.equal(critical.deliver, true);
  assert.equal(critical.ackRequired, true);
});

test("policy rejects unknown values and backoff is exponential with a cap", () => {
  assert.throws(
    () => evaluateNotification(makeEvent({ notification: { policy: "page_everyone" } })),
    { code: "ERR_NOTIFICATION_POLICY" }
  );
  assert.equal(computeBackoff(1, { initialDelayMs: 100, maxDelayMs: 250, maxAttempts: 4 }), 100);
  assert.equal(computeBackoff(2, { initialDelayMs: 100, maxDelayMs: 250, maxAttempts: 4 }), 200);
  assert.equal(computeBackoff(3, { initialDelayMs: 100, maxDelayMs: 250, maxAttempts: 4 }), 250);
});

test("delivery identity includes event, consumer and target", () => {
  const base = deliveryKey("CE-1", "consumer-a", coordinator);
  assert.equal(base, deliveryKey("CE-1", "consumer-a", coordinator));
  assert.notEqual(base, deliveryKey("CE-2", "consumer-a", coordinator));
  assert.notEqual(base, deliveryKey("CE-1", "consumer-b", coordinator));
  assert.notEqual(base, deliveryKey("CE-1", "consumer-a", { actorId: "user", kind: "user" }));
});

test("cursor file name does not expose consumer identity or allow traversal", () => {
  const name = cursorFileName("codex/coordinator@example");
  assert.match(name, /^consumer-[0-9a-f]{64}\.json$/);
  assert.equal(name.includes("codex"), false);
});

test("cursor ACK is durable and idempotent", () => {
  const dir = freshDir();
  let now = Date.parse("2026-07-28T00:00:00.000Z");
  const clock = () => now;
  const first = new ConsumerCursorStore(dir, "consumer-a", { clock });
  const key = deliveryKey("CE-1", "consumer-a", coordinator);
  first.recordPending(key, {
    eventId: "CE-1",
    target: "coordinator:coordinator",
    attempts: 1,
    exhausted: false,
    nextAttemptAt: new Date(now).toISOString(),
    lastError: null,
  });
  assert.equal(first.acknowledge(key, { eventId: "CE-1", target: "coordinator:coordinator" }).result, true);
  now += 1000;
  assert.equal(first.acknowledge(key, { eventId: "CE-1", target: "coordinator:coordinator" }).result, false);

  const reopened = new ConsumerCursorStore(dir, "consumer-a", { clock });
  const state = reopened.read();
  assert.ok(state.acknowledged[key]);
  assert.equal(state.pending[key], undefined);
});

test("cursor rejects corrupt durable state rather than resetting ACKs", () => {
  const dir = freshDir();
  const cursor = new ConsumerCursorStore(dir, "consumer-a");
  fs.writeFileSync(cursor.file, '{"version":1,"consumerId":"wrong"}\n');
  assert.throws(() => cursor.read(), { code: "ERR_CURSOR_CORRUPT" });
  assert.throws(() => new ConsumerCursorStore(dir, "consumer-a"), { code: "ERR_CURSOR_CORRUPT" });
});

test("pump ignores journal-only events and delivers a targeted critical event", async () => {
  const quiet = makeEvent({
    eventId: "CE-quiet",
    eventType: "task.heartbeat",
    previousState: STATES.EXECUTING,
    currentState: STATES.EXECUTING,
    sequence: 1,
    notification: { policy: "journal_only", dedupeKey: "heartbeat", ackRequired: false },
  });
  const ready = makeEvent({ eventId: "CE-ready", sequence: 2 });
  const { journal, cursor } = openFixture([quiet, ready]);
  const calls = [];
  const pump = new NotificationPump({
    journal,
    cursor,
    target: coordinator,
    adapter: { deliver: async (delivery) => { calls.push(delivery); return { acknowledged: true }; } },
  });

  const report = await pump.runOnce();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event.eventId, "CE-ready");
  assert.deepEqual(report, { scanned: 2, delivered: 0, acknowledged: 1, deferred: 0, failed: 0 });
  assert.equal(cursor.read().highWater, 2);
  journal.close();
});

test("unacknowledged critical delivery is retried after exponential backoff", async () => {
  let now = Date.parse("2026-07-28T00:00:00.000Z");
  const event = makeEvent();
  const { journal, root } = openFixture([event]);
  const cursor = new ConsumerCursorStore(path.join(root, "retry-consumers"), "consumer-a", { clock: () => now });
  let calls = 0;
  const pump = new NotificationPump({
    journal,
    cursor,
    clock: () => now,
    retry: { initialDelayMs: 100, maxDelayMs: 1000, maxAttempts: 3 },
    adapter: { deliver: async () => { calls += 1; return { acknowledged: false }; } },
  });

  assert.equal((await pump.runOnce()).delivered, 1);
  assert.equal(calls, 1);
  assert.equal((await pump.runOnce()).deferred, 1);
  assert.equal(calls, 1);
  now += 100;
  assert.equal((await pump.runOnce()).delivered, 1);
  assert.equal(calls, 2);
  const key = deliveryKey(event.eventId, "consumer-a", coordinator);
  assert.equal(cursor.read().pending[key].attempts, 2);
  journal.close();
});

test("adapter failures stop busy-looping at max attempts and remain pending", async () => {
  let now = Date.parse("2026-07-28T00:00:00.000Z");
  const event = makeEvent();
  const { journal, root } = openFixture([event]);
  const cursor = new ConsumerCursorStore(path.join(root, "failure-consumers"), "consumer-a", { clock: () => now });
  const pump = new NotificationPump({
    journal,
    cursor,
    clock: () => now,
    retry: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
    adapter: { deliver: async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); } },
  });

  assert.equal((await pump.runOnce()).failed, 1);
  now += 10;
  assert.equal((await pump.runOnce()).failed, 1);
  now += 1000;
  assert.equal((await pump.runOnce()).deferred, 1);
  const key = deliveryKey(event.eventId, "consumer-a", coordinator);
  assert.deepEqual(
    { attempts: cursor.read().pending[key].attempts, exhausted: cursor.read().pending[key].exhausted },
    { attempts: 2, exhausted: true }
  );
  journal.close();
});

test("a restarted pump re-presents exhausted pending delivery", async () => {
  let now = Date.parse("2026-07-28T00:00:00.000Z");
  const event = makeEvent();
  const { journal, root } = openFixture([event]);
  const cursor = new ConsumerCursorStore(path.join(root, "restart-consumers"), "consumer-a", { clock: () => now });
  const failing = new NotificationPump({
    journal,
    cursor,
    clock: () => now,
    retry: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
    adapter: { deliver: async () => { throw new Error("offline"); } },
  });
  await failing.runOnce();

  let recovered = 0;
  const restarted = new NotificationPump({
    journal,
    cursor,
    clock: () => now,
    retry: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
    adapter: { deliver: async () => { recovered += 1; return { acknowledged: true }; } },
  });
  assert.equal((await restarted.runOnce()).acknowledged, 1);
  assert.equal(recovered, 1);
  journal.close();
});

test("explicit ACK has no task-state side effect and prevents redelivery", async () => {
  const event = makeEvent();
  const { journal, cursor } = openFixture([event]);
  let calls = 0;
  const pump = new NotificationPump({
    journal,
    cursor,
    adapter: { deliver: async () => { calls += 1; return { acknowledged: false }; } },
  });
  await pump.runOnce();
  assert.equal(pump.acknowledge(event.eventId, coordinator).result, true);
  assert.equal(pump.acknowledge(event.eventId, coordinator).result, false);
  await pump.runOnce();
  assert.equal(calls, 1);
  assert.equal(journal.getEvent(event.eventId).currentState, STATES.READY_FOR_REVIEW);
  journal.close();
});
