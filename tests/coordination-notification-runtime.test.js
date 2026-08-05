"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createEvent, STATES } = require("../lib/coordination/contract");
const { Journal } = require("../lib/coordination/journal");
const { ConsumerCursorStore } = require("../lib/coordination/consumer-cursor");
const { deliveryKey } = require("../lib/coordination/notification-policy");
const { NotificationPump } = require("../lib/coordination/notification-pump");
const {
  NotificationRuntime,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
} = require("../lib/coordination/notification-runtime");
const {
  InstanceLock,
  StatusStore,
  NotificationSupervisor,
  assertRuntimeScoped,
} = require("../lib/coordination/notification-supervisor");

const dirs = new Set();

// Every fixture lives under a real `.agent-runtime` segment so the scope guard
// is exercised the same way it will be in a project checkout.
function freshRuntimeDir(leaf = "coordination") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-notify-rt-"));
  dirs.add(base);
  const dir = path.join(base, ".agent-runtime", leaf);
  fs.mkdirSync(dir, { recursive: true });
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
    notification: { policy: "coordinator_notify", dedupeKey: "ready", ackRequired: true },
    ...overrides,
  });
}

function openFixture(events, options = {}) {
  const root = freshRuntimeDir(options.leaf);
  const journalDir = path.join(root, "journal");
  const journal = Journal.open(journalDir, { lock: false, fsync: false });
  for (const event of events) journal.append(event);
  const cursor = new ConsumerCursorStore(
    path.join(root, "consumers"),
    options.consumerId || "codex-coordinator",
    options.clock ? { clock: options.clock } : {}
  );
  return { root, journalDir, journal, cursor };
}

function makePump(fixture, adapter, options = {}) {
  return new NotificationPump({
    journal: fixture.journal,
    cursor: fixture.cursor,
    adapter,
    ...options,
  });
}

// ─── Pending-first ordering ────────────────────────────────────────────────

test("pump drains due pending deliveries before scanning newer journal events", async () => {
  let now = Date.parse("2026-07-28T00:00:00.000Z");
  const clock = () => now;
  const first = makeEvent({ eventId: "CE-old", sequence: 1 });
  const fixture = openFixture([first], { consumerId: "consumer-a", clock });
  const order = [];
  const retry = { initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 5 };

  const pump = makePump(
    fixture,
    { deliver: async ({ event }) => { order.push(event.eventId); return { acknowledged: false }; } },
    { clock, retry }
  );

  await pump.runOnce();
  assert.deepEqual(order, ["CE-old"], "first cycle delivers the only event");

  // A newer event arrives while CE-old is still pending retry.
  fixture.journal.append(makeEvent({ eventId: "CE-new", sequence: 2 }));
  now += 10; // CE-old retry is now due

  order.length = 0;
  const report = await pump.runOnce();
  assert.deepEqual(
    order,
    ["CE-old", "CE-new"],
    "pending retry is presented before the newer journal event"
  );
  assert.equal(report.delivered, 2);
  fixture.journal.close();
});

test("pending-first does not double-count a delivery already handled this cycle", async () => {
  let now = Date.parse("2026-07-28T00:00:00.000Z");
  const clock = () => now;
  const fixture = openFixture([makeEvent()], { consumerId: "consumer-a", clock });
  let calls = 0;
  const pump = makePump(
    fixture,
    { deliver: async () => { calls += 1; return { acknowledged: false }; } },
    { clock, retry: { initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 5 } }
  );

  await pump.runOnce();
  now += 10;
  const report = await pump.runOnce();

  assert.equal(calls, 2, "one delivery per cycle, not one per phase");
  assert.deepEqual(report, { scanned: 1, delivered: 1, acknowledged: 0, deferred: 0, failed: 0 });
  fixture.journal.close();
});

test("pending entry whose event vanished is deferred rather than crashing the cycle", async () => {
  const now = Date.parse("2026-07-28T00:00:00.000Z");
  const clock = () => now;
  const fixture = openFixture([], { consumerId: "consumer-a", clock });
  const key = deliveryKey("CE-missing", "consumer-a", coordinator);
  fixture.cursor.recordPending(key, {
    eventId: "CE-missing",
    target: "coordinator:coordinator",
    attempts: 1,
    exhausted: false,
    nextAttemptAt: new Date(now).toISOString(),
    lastError: null,
  });

  const pump = makePump(
    fixture,
    { deliver: async () => { throw new Error("must not be called"); } },
    { clock }
  );
  const report = await pump.runOnce();
  assert.equal(report.deferred, 1);
  assert.ok(fixture.cursor.read().pending[key], "orphan pending is retained, not silently dropped");
  fixture.journal.close();
});

// ─── Runtime: run once ─────────────────────────────────────────────────────

test("runtime runOnce delegates to the pump and records health without watching", async () => {
  const fixture = openFixture([makeEvent()], { consumerId: "consumer-a" });
  const runtime = new NotificationRuntime({
    pump: makePump(fixture, { deliver: async () => ({ acknowledged: true }) }),
    journalDir: fixture.journalDir,
    statusStore: new StatusStore(path.join(fixture.root, "notifications"), "consumer-a"),
  });

  const report = await runtime.runOnce();
  assert.equal(report.acknowledged, 1);

  const status = runtime.status();
  assert.equal(status.state, "idle");
  assert.equal(status.cycles, 1);
  assert.deepEqual(status.lastReport, report);
  assert.equal(status.lastError, null);
  assert.equal(status.health, "healthy");
  assert.deepEqual(status.degradedReasons, []);
  fixture.journal.close();
});

// ─── Runtime: fs.watch wakeup ──────────────────────────────────────────────

test("watch wakes immediately on a journal change instead of waiting out the backoff", async () => {
  const fixture = openFixture([], { consumerId: "consumer-a" });
  const seen = [];
  const runtime = new NotificationRuntime({
    pump: makePump(fixture, {
      deliver: async ({ event }) => { seen.push(event.eventId); return { acknowledged: true }; },
    }),
    journalDir: fixture.journalDir,
    // A very long fallback proves the wake-up came from fs.watch, not the timer.
    minIntervalMs: 60_000,
    maxIntervalMs: 60_000,
    statusStore: new StatusStore(path.join(fixture.root, "notifications"), "consumer-a"),
  });

  const watching = runtime.watch();
  await runtime.waitForIdle();

  const writer = Journal.open(fixture.journalDir, { lock: false, fsync: false });
  writer.append(makeEvent({ eventId: "CE-live", sequence: 1 }));
  writer.close();

  await runtime.waitForCycle(2, 5000);
  await runtime.stop();
  await watching;

  assert.deepEqual(seen, ["CE-live"], "event appended while watching is delivered promptly");
  fixture.journal.close();
});

test("watch still makes progress when fs.watch never fires (backoff fallback)", async () => {
  const fixture = openFixture([], { consumerId: "consumer-a" });
  const runtime = new NotificationRuntime({
    pump: makePump(fixture, { deliver: async () => ({ acknowledged: true }) }),
    journalDir: fixture.journalDir,
    minIntervalMs: 5,
    maxIntervalMs: 20,
    // Deliberately inert watcher: only the internal backoff can drive cycles.
    watchFactory: () => ({ close() {} }),
  });

  const watching = runtime.watch();
  await runtime.waitForCycle(3, 5000);
  await runtime.stop();
  await watching;

  assert.ok(runtime.status().cycles >= 3, "backoff timer keeps the loop alive without fs events");
});

test("backoff grows while idle and resets after useful work", async () => {
  const fixture = openFixture([], { consumerId: "consumer-a" });
  let deliverNext = false;
  const runtime = new NotificationRuntime({
    pump: makePump(fixture, { deliver: async () => ({ acknowledged: true }) }),
    journalDir: fixture.journalDir,
    minIntervalMs: 5,
    maxIntervalMs: 40,
    watchFactory: () => ({ close() {} }),
  });

  const observed = [];
  runtime.on("cycle", ({ backoffMs }) => {
    observed.push(backoffMs);
    if (observed.length === 3 && !deliverNext) {
      deliverNext = true;
      const writer = Journal.open(fixture.journalDir, { lock: false, fsync: false });
      writer.append(makeEvent({ eventId: "CE-work", sequence: 1 }));
      writer.close();
    }
  });

  const watching = runtime.watch();
  await runtime.waitForCycle(5, 5000);
  await runtime.stop();
  await watching;

  assert.ok(observed[1] > observed[0], "idle cycles back off");
  assert.ok(observed.some((ms) => ms === 5), "a productive cycle resets to the minimum interval");
  assert.ok(observed.every((ms) => ms <= 40), "backoff is capped");
  fixture.journal.close();
});

test("runtime exposes documented interval defaults", () => {
  assert.ok(DEFAULT_MIN_INTERVAL_MS > 0);
  assert.ok(DEFAULT_MAX_INTERVAL_MS >= DEFAULT_MIN_INTERVAL_MS);
});

// ─── Runtime: graceful stop ────────────────────────────────────────────────

test("stop drains the in-flight delivery and is idempotent", async () => {
  const fixture = openFixture([makeEvent()], { consumerId: "consumer-a" });
  let finished = false;
  let started = null;
  const startedPromise = new Promise((resolve) => { started = resolve; });

  const runtime = new NotificationRuntime({
    pump: makePump(fixture, {
      deliver: async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 60));
        finished = true;
        return { acknowledged: true };
      },
    }),
    journalDir: fixture.journalDir,
    minIntervalMs: 5,
    maxIntervalMs: 10,
  });

  const watching = runtime.watch();
  await startedPromise;

  await runtime.stop();
  assert.equal(finished, true, "stop waits for the in-flight delivery to settle");

  await runtime.stop(); // idempotent
  await watching;
  assert.equal(runtime.status().state, "stopped");
  fixture.journal.close();
});

test("stop before watch and double watch are both rejected cleanly", async () => {
  const fixture = openFixture([], { consumerId: "consumer-a" });
  const runtime = new NotificationRuntime({
    pump: makePump(fixture, { deliver: async () => ({ acknowledged: true }) }),
    journalDir: fixture.journalDir,
    minIntervalMs: 5,
    maxIntervalMs: 10,
    watchFactory: () => ({ close() {} }),
  });

  await runtime.stop(); // no-op before start
  const watching = runtime.watch();
  await assert.rejects(() => runtime.watch(), { code: "ERR_NOTIFICATION_RUNTIME_ACTIVE" });
  await runtime.stop();
  await watching;
  fixture.journal.close();
});

test("a delivery that throws does not kill the watch loop", async () => {
  const fixture = openFixture([makeEvent()], { consumerId: "consumer-a" });
  const runtime = new NotificationRuntime({
    pump: makePump(
      fixture,
      { deliver: async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); } },
      { retry: { initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 5 } }
    ),
    journalDir: fixture.journalDir,
    minIntervalMs: 5,
    maxIntervalMs: 10,
    watchFactory: () => ({ close() {} }),
  });

  const watching = runtime.watch();
  await runtime.waitForCycle(3, 5000);
  await runtime.stop();
  await watching;

  assert.ok(runtime.status().cycles >= 3, "loop survives adapter failures");
  assert.equal(runtime.status().health, "degraded");
  assert.deepEqual(runtime.status().degradedReasons, ["ECONNREFUSED"]);
  fixture.journal.close();
});

// ─── Instance lock: one consumer, one runtime ──────────────────────────────

test("a second runtime for the same consumer is refused while the first holds the lock", () => {
  const dir = freshRuntimeDir();
  const first = new InstanceLock(dir, "consumer-a");
  assert.equal(first.acquire().acquired, true);

  const second = new InstanceLock(dir, "consumer-a");
  assert.throws(() => second.acquire(), { code: "ERR_NOTIFICATION_INSTANCE_LOCKED" });

  first.release();
  assert.equal(new InstanceLock(dir, "consumer-a").acquire().acquired, true);
});

test("distinct consumers hold independent locks", () => {
  const dir = freshRuntimeDir();
  assert.equal(new InstanceLock(dir, "consumer-a").acquire().acquired, true);
  assert.equal(new InstanceLock(dir, "consumer-b").acquire().acquired, true);
});

test("lock file name hashes the consumer id and resists traversal", () => {
  const dir = freshRuntimeDir();
  const lock = new InstanceLock(dir, "../../etc/passwd");
  assert.equal(path.dirname(path.resolve(lock.file)), path.resolve(dir));
  assert.match(path.basename(lock.file), /^instance-[0-9a-f]{64}\.lock$/);
});

// ─── Crash recovery ────────────────────────────────────────────────────────

test("a lock orphaned by a dead process is reclaimed on restart", () => {
  const dir = freshRuntimeDir();
  const lock = new InstanceLock(dir, "consumer-a");
  fs.writeFileSync(
    lock.file,
    JSON.stringify({
      consumerId: "consumer-a",
      token: "stale-token",
      pid: 999_999_999, // above any real pid: process.kill reports ESRCH
      acquiredAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
    })
  );

  const result = lock.acquire();
  assert.equal(result.acquired, true);
  assert.equal(result.reclaimed, true);
  assert.equal(JSON.parse(fs.readFileSync(lock.file, "utf8")).pid, process.pid);
});

test("a live owner is never evicted even after the TTL lapses", () => {
  const dir = freshRuntimeDir();
  const holder = new InstanceLock(dir, "consumer-a", { ttlMs: 1 });
  holder.acquire();

  const contender = new InstanceLock(dir, "consumer-a", { ttlMs: 1, clock: () => Date.now() + 60_000 });
  assert.throws(() => contender.acquire(), (error) => {
    assert.equal(error.code, "ERR_NOTIFICATION_INSTANCE_LOCKED");
    assert.equal(error.details.reason, "owner_process_alive");
    return true;
  });
});

test("a corrupt lock file is reclaimed rather than wedging the runtime forever", () => {
  const dir = freshRuntimeDir();
  const lock = new InstanceLock(dir, "consumer-a");
  fs.writeFileSync(lock.file, "{ not json");
  assert.equal(lock.acquire().acquired, true);
});

test("release only removes a lock this instance still owns", () => {
  const dir = freshRuntimeDir();
  const lock = new InstanceLock(dir, "consumer-a");
  lock.acquire();
  fs.writeFileSync(
    lock.file,
    JSON.stringify({ consumerId: "consumer-a", token: "someone-else", pid: process.pid })
  );
  lock.release();
  assert.equal(fs.existsSync(lock.file), true, "another owner's lock is left intact");
});

// ─── Status / health lives only under .agent-runtime ───────────────────────

test("status state is confined to .agent-runtime", () => {
  assert.throws(() => assertRuntimeScoped("/tmp/project/.agent/coordination"), {
    code: "ERR_NOTIFICATION_STATE_SCOPE",
  });
  assert.throws(() => new StatusStore("/tmp/project/.agent/notifications", "consumer-a"), {
    code: "ERR_NOTIFICATION_STATE_SCOPE",
  });
  const dir = freshRuntimeDir();
  assert.equal(assertRuntimeScoped(dir), path.resolve(dir));
});

test("status is written atomically and survives a reopen", () => {
  const dir = freshRuntimeDir();
  const store = new StatusStore(dir, "consumer-a");
  store.write({ state: "running", cycles: 3, pid: process.pid });

  const reread = new StatusStore(dir, "consumer-a").read();
  assert.equal(reread.state, "running");
  assert.equal(reread.cycles, 3);
  assert.equal(reread.consumerId, "consumer-a");
  assert.ok(reread.updatedAt);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
});

test("a missing or corrupt status file reads as unknown instead of throwing", () => {
  const dir = freshRuntimeDir();
  const store = new StatusStore(dir, "consumer-a");
  assert.equal(store.read().state, "unknown");
  fs.writeFileSync(store.file, "{ broken");
  assert.equal(store.read().state, "unknown");
});

// ─── Supervisor ────────────────────────────────────────────────────────────

test("supervisor holds the instance lock for the lifetime of the watch", async () => {
  const fixture = openFixture([], { consumerId: "consumer-a" });
  const notifyDir = path.join(fixture.root, "notifications");
  const runtime = new NotificationRuntime({
    pump: makePump(fixture, { deliver: async () => ({ acknowledged: true }) }),
    journalDir: fixture.journalDir,
    minIntervalMs: 5,
    maxIntervalMs: 10,
    watchFactory: () => ({ close() {} }),
  });
  const supervisor = new NotificationSupervisor({
    runtime,
    runtimeDir: notifyDir,
    consumerId: "consumer-a",
    installSignalHandlers: false,
  });

  const running = supervisor.start();
  await runtime.waitForCycle(1, 5000);

  assert.throws(() => new InstanceLock(notifyDir, "consumer-a").acquire(), {
    code: "ERR_NOTIFICATION_INSTANCE_LOCKED",
  });
  assert.equal(supervisor.status().state, "running");

  await supervisor.stop();
  await running;

  assert.equal(supervisor.status().state, "stopped");
  assert.equal(new InstanceLock(notifyDir, "consumer-a").acquire().acquired, true);
  fixture.journal.close();
});

test("supervisor releases the lock and records status when a cycle throws fatally", async () => {
  const fixture = openFixture([], { consumerId: "consumer-a" });
  const notifyDir = path.join(fixture.root, "notifications");
  const runtime = new NotificationRuntime({
    pump: {
      runOnce: async () => { throw Object.assign(new Error("journal gone"), { code: "ERR_JOURNAL" }); },
      consumerId: "consumer-a",
    },
    journalDir: fixture.journalDir,
    minIntervalMs: 5,
    maxIntervalMs: 10,
    watchFactory: () => ({ close() {} }),
    stopOnError: true,
  });
  const supervisor = new NotificationSupervisor({
    runtime,
    runtimeDir: notifyDir,
    consumerId: "consumer-a",
    installSignalHandlers: false,
  });

  await assert.rejects(() => supervisor.start(), { code: "ERR_JOURNAL" });

  const status = supervisor.status();
  assert.equal(status.state, "failed");
  assert.equal(status.lastError.code, "ERR_JOURNAL");
  assert.equal(
    new InstanceLock(notifyDir, "consumer-a").acquire().acquired,
    true,
    "a fatal failure must not leak the instance lock"
  );
  fixture.journal.close();
});

// ─── Non-negotiables: no auto-ACK, no completion inference ─────────────────

test("runtime never auto-acknowledges an ack-required delivery", async () => {
  const fixture = openFixture([makeEvent()], { consumerId: "consumer-a" });
  const pump = makePump(fixture, { deliver: async () => ({}) }, {
    retry: { initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 5 },
  });
  const runtime = new NotificationRuntime({ pump, journalDir: fixture.journalDir });

  await runtime.runOnce();

  const key = deliveryKey("CE-1", "consumer-a", coordinator);
  const state = fixture.cursor.read();
  assert.equal(state.acknowledged[key], undefined, "delivery alone must not count as an ACK");
  assert.ok(state.pending[key], "it stays pending until the consumer acknowledges explicitly");

  assert.equal(pump.acknowledge("CE-1", coordinator).result, true);
  assert.ok(fixture.cursor.read().acknowledged[key]);
  fixture.journal.close();
});

test("running the pump does not infer task completion or mutate journal state", async () => {
  const event = makeEvent();
  const fixture = openFixture([event], { consumerId: "consumer-a" });
  const before = fixture.journal.readAll();
  const runtime = new NotificationRuntime({
    pump: makePump(fixture, { deliver: async () => ({ acknowledged: true }) }),
    journalDir: fixture.journalDir,
  });

  await runtime.runOnce();

  const after = fixture.journal.readAll();
  assert.deepEqual(after, before, "the journal is read-only to the notification runtime");
  assert.equal(fixture.journal.getEvent("CE-1").currentState, STATES.READY_FOR_REVIEW);
  assert.equal(after.some((candidate) => candidate.eventType === "task.completed"), false);
  fixture.journal.close();
});
