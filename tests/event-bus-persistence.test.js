"use strict";

// Tests for M-004 MS-001 VC-004: events.jsonl persistence - rotate + flock.
//
// Strategy:
//   - Append events, verify events.jsonl content + fsync durability.
//   - Trigger 10 MB cap rotation with a small test cap -> verify gzipped
//     archive created, events.jsonl truncated, meta updated.
//   - Trigger 100 MB total cap -> verify oldest archive pruned (>= 1 kept).
//   - Restart recovery: close + reopen persistence, verify meta + dedupe LRU
//     rebuilt from events.jsonl tail.
//   - meta.json consistency: fields present and correct after operations.
//   - flock: concurrent append via lock file (single-writer safety).
//   - subs.json: read / write / upsert / update offset / remove.
//   - ack persistence: write + read acks.
//   - readEvents filtering: by event_name, since, until, correlation, limit.
//   - readEventsFromOffset: byte-offset-based fan-out read.
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-004
//   - docs/architecture/framework-event-bus-design.md §5

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPersistence } = require("../lib/event-bus/persistence");
const { createFsWatcher } = require("../lib/event-bus/fs-watcher");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _tmpCounter = 0;

function tmpDir() {
  const dir = path.join(os.tmpdir(), `eb-test-${process.pid}-${++_tmpCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(name, payload, idx) {
  return {
    event_id: `eb-evt-${String(idx).padStart(8, "0")}-0000-0000-0000-000000000000`,
    event_name: name,
    event_version: "1.0",
    bus_id: "test-host:m-004",
    occurred_at: new Date(Date.now() + idx).toISOString(),
    producer: { producer_id: "sub-1", producer_kind: "sub_agent", session_id: "S-1" },
    correlation: { mission_id: "M-004", subagent_id: "sub-1", parent_run_id: "R-001" },
    payload: payload || { status: "success", output_summary: "done " + idx },
  };
}

function makeBus(dir, opts) {
  const p = createPersistence({ dataDir: dir, fsync: false, ...opts });
  p.init();
  return p;
}

// ===========================================================================
// 1. Append + read events
// ===========================================================================

test("VC-004: append writes to events.jsonl and readEvents returns them", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);

  bus.append(makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y" }, 1));
  bus.append(makeEvent("subagent_completed", { status: "success", output_summary: "done" }, 2));
  bus.close();

  const content = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  assert.strictEqual(lines.length, 2);

  const bus2 = makeBus(dir);
  const { events, total } = bus2.readEvents();
  assert.strictEqual(total, 2);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].event_name, "subagent_spawned");
  assert.strictEqual(events[1].event_name, "subagent_completed");
  bus2.close();
});

test("VC-004: readEvents filters by event_name", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.append(makeEvent("subagent_spawned", {}, 1));
  bus.append(makeEvent("subagent_completed", {}, 2));
  bus.append(makeEvent("subagent_completed", {}, 3));

  const { events, total } = bus.readEvents({ event_name: "subagent_completed" });
  assert.strictEqual(events.length, 2);
  assert.strictEqual(total, 3);
  bus.close();
});

test("VC-004: readEvents filters by correlation", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.append(makeEvent("subagent_spawned", {}, 1));
  bus.close();

  const bus2 = makeBus(dir);
  const { events } = bus2.readEvents({
    correlation: { mission_id: "M-004" },
  });
  assert.strictEqual(events.length, 1);

  const { events: empty } = bus2.readEvents({
    correlation: { mission_id: "M-999" },
  });
  assert.strictEqual(empty.length, 0);
  bus2.close();
});

test("VC-004: readEvents respects limit", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  for (let i = 0; i < 10; i++) bus.append(makeEvent("subagent_progress", { percent: i * 10 }, i));
  const { events } = bus.readEvents({ limit: 3 });
  assert.strictEqual(events.length, 3);
  bus.close();
});

// ===========================================================================
// 2. Rotation (10 MB cap -> gzipped archive)
// ===========================================================================

test("VC-004: events.jsonl rotates to gzipped archive when cap exceeded", () => {
  const dir = tmpDir();
  // Use tiny cap (512 bytes) to trigger rotation quickly
  const bus = makeBus(dir, { archiveCapBytes: 512 });

  // Each event line is ~300 bytes, so 2 events should exceed 512
  bus.append(makeEvent("subagent_spawned", { subagent_role: "explore", task_description: "a".repeat(200) }, 1));
  bus.append(makeEvent("subagent_completed", { status: "success", output_summary: "b".repeat(200) }, 2));

  bus.close();

  // Archive should exist
  const archives = fs.readdirSync(path.join(dir, "archive")).filter((f) => f.endsWith(".jsonl.gz"));
  assert.ok(archives.length >= 1, "Expected at least 1 archive");

  // Archive should be valid gzip
  const archivePath = path.join(dir, "archive", archives[0]);
  const zlib = require("node:zlib");
  const content = zlib.gunzipSync(fs.readFileSync(archivePath));
  const lines = content.toString().split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 1, "Archive should contain events");

  // events.jsonl should be truncated (small or empty)
  const newSize = fs.statSync(path.join(dir, "events.jsonl")).size;
  assert.ok(newSize < 512, `events.jsonl should be small after rotate, got ${newSize}`);
});

test("VC-004: meta.json updated after rotation with archive_count", () => {
  const dir = tmpDir();
  const bus = makeBus(dir, { archiveCapBytes: 256 });
  bus.append(makeEvent("subagent_spawned", { subagent_role: "x", task_description: "y".repeat(100) }, 1));
  bus.append(makeEvent("subagent_completed", { status: "success", output_summary: "z".repeat(100) }, 2));
  bus.close();

  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  assert.ok(meta.archive_count >= 1, "archive_count should be >= 1");
  assert.ok(meta.last_rotate_at, "last_rotate_at should be set");
  assert.ok(meta.last_rotate_size, "last_rotate_size should be set");
});

// ===========================================================================
// 3. Total cap pruning (100 MB -> delete oldest, keep >= 1)
// ===========================================================================

test("VC-004: total cap prunes oldest archive (keeps at least 1)", () => {
  const dir = tmpDir();
  // Small caps: 256 bytes per file, 512 bytes total
  const bus = makeBus(dir, { archiveCapBytes: 256, totalCapBytes: 512 });

  // Write enough events to create multiple archives
  for (let i = 0; i < 20; i++) {
    bus.append(makeEvent("subagent_progress", { percent: i, current_step: "x".repeat(80) }, i));
  }
  bus.close();

  const archives = fs.readdirSync(path.join(dir, "archive")).filter((f) => f.endsWith(".jsonl.gz"));
  // Total size should be under cap (but at least 1 archive kept)
  assert.ok(archives.length >= 1, "Should keep at least 1 archive");

  const info = bus.getArchiveInfo ? bus.getArchiveInfo() : null;
  // Re-open to check
  const bus2 = makeBus(dir, { archiveCapBytes: 256, totalCapBytes: 512 });
  const archiveInfo = bus2.getArchiveInfo();
  assert.ok(archiveInfo.totalSize <= 512 + 256, "Total size should be approximately under cap");
  bus2.close();
});

// ===========================================================================
// 4. Restart recovery (dedupe LRU rebuild)
// ===========================================================================

test("VC-004: restart rebuilds dedupe LRU from events.jsonl tail", () => {
  const dir = tmpDir();
  const bus = makeBus(dir, { dedupeLruSize: 100 });
  for (let i = 0; i < 10; i++) {
    bus.append(makeEvent("subagent_progress", { percent: i * 10 }, i));
  }
  bus.close();

  // Restart
  const bus2 = makeBus(dir, { dedupeLruSize: 100 });
  assert.strictEqual(bus2.getDedupeSize(), 10, "Dedupe LRU should have 10 entries after rebuild");

  // All previously seen IDs should be duplicates
  for (let i = 0; i < 10; i++) {
    const id = `eb-evt-${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;
    assert.ok(bus2.isDuplicate(id), `Event ${i} should be duplicate after restart`);
  }
  bus2.close();
});

test("VC-004: dedupe LRU evicts oldest entries when at capacity", () => {
  const dir = tmpDir();
  const bus = makeBus(dir, { dedupeLruSize: 5 });
  for (let i = 0; i < 10; i++) {
    bus.append(makeEvent("subagent_progress", { percent: i * 10 }, i));
  }
  assert.strictEqual(bus.getDedupeSize(), 5, "LRU should be at capacity 5");

  // First 5 should be evicted
  const id0 = `eb-evt-00000000-0000-0000-0000-000000000000`;
  assert.ok(!bus2_exists(bus, id0), "Oldest should be evicted");
  // Last 5 should be present
  const id9 = `eb-evt-00000009-0000-0000-0000-000000000000`;
  assert.ok(bus.isDuplicate(id9), "Newest should be in LRU");
  bus.close();
});

function bus2_exists(bus, id) {
  return bus.isDuplicate(id);
}

// ===========================================================================
// 5. meta.json consistency
// ===========================================================================

test("VC-004: meta.json has required fields on init", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  const meta = bus.getMeta();
  assert.ok(meta.bus_id, "meta.bus_id");
  assert.ok(meta.created_at, "meta.created_at");
  assert.strictEqual(meta.schema_version, 1);
  assert.strictEqual(meta.event_count, 0);
  bus.close();
});

test("VC-004: meta.json event_count increments on append", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.append(makeEvent("subagent_spawned", {}, 1));
  bus.append(makeEvent("subagent_completed", {}, 2));
  assert.strictEqual(bus.getMeta().event_count, 2);
  assert.ok(bus.getMeta().last_event_id, "last_event_id should be set");
  bus.close();
});

test("VC-004: meta.json persists across restart", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.append(makeEvent("subagent_completed", {}, 1));
  const beforeId = bus.getMeta().last_event_id;
  bus.close();

  const bus2 = makeBus(dir);
  assert.strictEqual(bus2.getMeta().last_event_id, beforeId);
  assert.strictEqual(bus2.getMeta().event_count, 1);
  bus2.close();
});

// ===========================================================================
// 6. flock (single-writer safety)
// ===========================================================================

test("VC-004: flock prevents concurrent writes from another process", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);

  // Manually acquire lock
  bus.acquireLock();

  // A second persistence instance should fail to acquire
  const bus2 = createPersistence({ dataDir: dir, fsync: false });
  bus2.init();
  assert.throws(() => {
    bus2.acquireLock();
  }, /lock held/);

  bus.releaseLock();
  // Now bus2 can acquire
  bus2.acquireLock();
  bus2.releaseLock();
  bus.close();
  bus2.close();
});

test("VC-004: stale lock is reclaimed when process is dead", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);

  // Write a stale lock file with a dead PID
  const lockPath = path.join(dir, "locks", "write.lock");
  fs.writeFileSync(lockPath, "99999999"); // very likely dead PID

  // Should be able to acquire (reclaim stale)
  bus.acquireLock();
  bus.releaseLock();
  bus.close();
});

test("VC-004: withLock auto-acquires and releases", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);

  const result = bus.withLock(() => {
    return bus.append(makeEvent("subagent_completed", {}, 1));
  });
  assert.ok(result.ok);
  assert.strictEqual(result.event_id, bus.getMeta().last_event_id);

  // Lock should be released after withLock
  const bus2 = createPersistence({ dataDir: dir, fsync: false });
  bus2.init();
  bus2.acquireLock(); // should not throw
  bus2.releaseLock();
  bus.close();
  bus2.close();
});

// ===========================================================================
// 7. subs.json (subscription registry)
// ===========================================================================

test("VC-004: subs.json read/write/upsert/updateOffset/remove", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);

  // Empty initially
  let subs = bus.readSubs();
  assert.strictEqual(subs.subscriptions.length, 0);

  // Add
  bus.upsertSub({
    subscription_id: "sub-1",
    filter: { event_names: ["subagent_completed"] },
    handler: "parent-resume",
    ack_timeout_ms: 30000,
    retry_count: 3,
    last_read_offset: 0,
    created_at: "2026-08-04T10:00:00Z",
  });
  subs = bus.readSubs();
  assert.strictEqual(subs.subscriptions.length, 1);
  assert.strictEqual(subs.subscriptions[0].subscription_id, "sub-1");

  // Update offset
  bus.updateSubOffset("sub-1", 4096);
  subs = bus.readSubs();
  assert.strictEqual(subs.subscriptions[0].last_read_offset, 4096);

  // Upsert (update existing)
  bus.upsertSub({ subscription_id: "sub-1", handler: "coordination-sync" });
  subs = bus.readSubs();
  assert.strictEqual(subs.subscriptions[0].handler, "coordination-sync");
  assert.strictEqual(subs.subscriptions.length, 1);

  // Remove
  bus.removeSub("sub-1");
  subs = bus.readSubs();
  assert.strictEqual(subs.subscriptions.length, 0);
  bus.close();
});

// ===========================================================================
// 8. Ack persistence
// ===========================================================================

test("VC-004: ack write + read persistence", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);

  bus.writeAck("sub-1", {
    event_id: "eb-evt-00000001-0000-0000-0000-000000000000",
    status: "success",
    acked_at: "2026-08-04T10:01:00Z",
  });
  bus.writeAck("sub-1", {
    event_id: "eb-evt-00000002-0000-0000-0000-000000000000",
    status: "rejected",
    acked_at: "2026-08-04T10:02:00Z",
  });

  const acks = bus.readAcks("sub-1");
  assert.strictEqual(acks.length, 2);
  assert.strictEqual(acks[0].status, "success");
  assert.strictEqual(acks[1].status, "rejected");
  bus.close();
});

// ===========================================================================
// 9. readEventsFromOffset (fan-out delivery)
// ===========================================================================

test("VC-004: readEventsFromOffset returns only new events", () => {
  const dir = tmpDir();
  const bus = makeBus(dir);
  bus.append(makeEvent("subagent_spawned", {}, 1));
  const offsetAfter1 = bus.getEventsSize();
  bus.append(makeEvent("subagent_completed", {}, 2));
  bus.append(makeEvent("subagent_failed", {}, 3));

  const newEvents = bus.readEventsFromOffset(offsetAfter1);
  assert.strictEqual(newEvents.length, 2);
  assert.strictEqual(newEvents[0].event_name, "subagent_completed");
  assert.strictEqual(newEvents[1].event_name, "subagent_failed");
  bus.close();
});

// ===========================================================================
// 10. Archive info
// ===========================================================================

test("VC-004: getArchiveInfo returns archives + total size", () => {
  const dir = tmpDir();
  const bus = makeBus(dir, { archiveCapBytes: 256 });
  for (let i = 0; i < 5; i++) {
    bus.append(makeEvent("subagent_progress", { percent: i, current_step: "x".repeat(80) }, i));
  }
  const info = bus.getArchiveInfo();
  assert.ok(info.archives.length >= 1, "Should have archives");
  assert.ok(info.totalSize > 0, "Total size > 0");
  bus.close();
});
// ===========================================================================
// 11. fs-watcher basic behavior
// ===========================================================================

test("VC-004: fs-watcher starts with fs.watch (non-polling initially)", () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "watch-init.jsonl");
  fs.writeFileSync(filePath, "");

  const watcher = createFsWatcher({
    filePath,
    onChange: () => {},
    debounceMs: 10,
  });
  watcher.start();
  assert.ok(!watcher.isPolling(), "Should start with fs.watch, not polling");
  watcher.close();
});

test("VC-004: fs-watcher triggers onChange via polling fallback", async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "watch-poll.jsonl");
  fs.writeFileSync(filePath, "");

  let triggered = false;
  const watcher = createFsWatcher({
    filePath,
    onChange: () => { triggered = true; },
    debounceMs: 10,
    pollFallbackMs: 50,
  });
  watcher.start();
  // Force polling mode (simulates fs.watch failure)
  watcher._fallbackToPolling();

  // Append to file
  fs.appendFileSync(filePath, '{"test":true}\n');

  // Wait for polling interval + debounce
  await new Promise((resolve) => setTimeout(resolve, 300));

  watcher.close();
  assert.ok(triggered, "onChange should have been triggered via polling");
});

test("VC-004: fs-watcher falls back to polling on error for nonexistent file", () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "does-not-exist.jsonl");

  const watcher = createFsWatcher({
    filePath,
    onChange: () => {},
    pollFallbackMs: 100,
  });
  // start() tries fs.watch on nonexistent file -> should fall back
  watcher.start();
  assert.ok(watcher.isPolling(), "Should fall back to polling for nonexistent file");
  watcher.close();
});

test("VC-004: fs-watcher close stops callbacks", async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "watch-close.jsonl");
  fs.writeFileSync(filePath, "");

  let count = 0;
  const watcher = createFsWatcher({
    filePath,
    onChange: () => { count++; },
    debounceMs: 10,
    pollFallbackMs: 50,
  });
  watcher.start();
  watcher._fallbackToPolling();
  watcher.close();

  fs.appendFileSync(filePath, '{"test":true}\n');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(count, 0, "No callbacks after close");
});
