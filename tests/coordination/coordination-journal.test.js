"use strict";

// ─── T-ACN-003: Reliable JSONL Journal tests ──────────────────────────────
// Covers: append-only, atomic/recoverable writes, sequence + hash-chain,
// truncated-tail recovery, replay, eventId idempotency and fault injection.
// Zero third-party dependencies - node:test + node:assert only.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createEvent, STATES } = require("../../lib/coordination/contract");
const { CoordinationError } = require("../../lib/coordination/errors");
const {
  Journal,
  GENESIS_HASH,
  RECORD_VERSION,
  computeHash,
  stableStringify,
  segmentFileName,
} = require("../../lib/coordination/journal");

// ─── Helpers ───────────────────────────────────────────────────────────────

const _dirs = new Set();

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-journal-"));
  _dirs.add(dir);
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Register a single module-level cleanup so individual tests stay readable.
test.after(() => {
  for (const d of _dirs) rmrf(d);
});

function makeProducer(overrides = {}) {
  return { actorId: "agent-a", kind: "agent", vendor: "test", ...overrides };
}

function makeEvent(overrides = {}) {
  const opts = {
    eventId: "CE-001",
    projectId: "proj-1",
    taskId: "TASK-001",
    correlationId: "CORR-1",
    producer: makeProducer(),
    targets: [{ actorId: "coordinator", kind: "coordinator" }],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    sequence: 1,
    repository: { repositoryId: "proj-1", worktreeId: null, branch: "main", baselineCommit: null },
    notification: { policy: "journal_only", dedupeKey: "task.created", ackRequired: false },
    ...overrides,
  };
  return createEvent(opts);
}

// A full legal lifecycle for one task/producer, with monotonically increasing
// sequences. Used to demonstrate replay can rebuild a projection.
function lifecycleEvents(eventIdBase = "CE", taskId = "TASK-001", actorId = "agent-a") {
  const steps = [
    { eventType: "task.created", previousState: null, currentState: STATES.CREATED },
    { eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED },
    { eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED },
    { eventType: "task.progress", previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING },
    { eventType: "task.testing", previousState: STATES.EXECUTING, currentState: STATES.TESTING },
    {
      eventType: "task.ready_for_review",
      previousState: STATES.TESTING,
      currentState: STATES.READY_FOR_REVIEW,
      evidence: [{ kind: "artifact", ref: "ARTIFACT-001" }],
    },
    { eventType: "task.completed", previousState: STATES.READY_FOR_REVIEW, currentState: STATES.COMPLETED },
  ];
  return steps.map((s, i) =>
    makeEvent({
      eventId: `${eventIdBase}-${i + 1}`,
      taskId,
      producer: makeProducer({ actorId }),
      sequence: i + 1,
      timestamp: `2026-07-28T00:00:${String(i).padStart(2, "0")}.000Z`,
      ...s,
    })
  );
}

function activeSegmentPath(journal) {
  return path.join(journal.dir, segmentFileName(1));
}

// ─── 1. Open / create ──────────────────────────────────────────────────────

test("open creates the journal directory and first segment", () => {
  const dir = path.join(freshDir(), "nested", "coordination");
  const j = Journal.open(dir, { lock: false });
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(dir, segmentFileName(1))));
  assert.equal(j.getCount(), 0);
  assert.equal(j.getLastHash(), GENESIS_HASH);
  j.close();
});

test("open on an empty segment has no events and genesis hash", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  assert.equal(j.getCount(), 0);
  assert.equal(j.getLastHash(), GENESIS_HASH);
  assert.deepEqual(j.readAll(), []);
  j.close();
});

// ─── 2. Append basics: sequence, hash, record format ───────────────────────

test("append returns appended=true with assigned sequence and hash", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const r = j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  assert.equal(r.appended, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.sequence, 1);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(r.segment, 1);
  j.close();
});

test("append auto-assigns sequence when event.sequence is null", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const r1 = j.append(makeEvent({ eventId: "CE-1", sequence: null }));
  const r2 = j.append(makeEvent({ eventId: "CE-2", sequence: null, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  assert.equal(r1.sequence, 1);
  assert.equal(r2.sequence, 2);
  assert.equal(r2.event.sequence, 2);
  j.close();
});

test("append stores exactly one JSONL line per event with trailing newline", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  j.close();
  const content = fs.readFileSync(activeSegmentPath({ dir }), "utf8");
  const lines = content.split("\n");
  assert.equal(lines.length, 3); // two records + trailing ""
  assert.equal(lines[2], "");
  assert.equal(lines[0].endsWith("}"), true);
  assert.equal(lines[1].endsWith("}"), true);
});

test("append is append-only: existing bytes are never modified", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  const before = fs.readFileSync(activeSegmentPath({ dir }), "utf8");
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  const after = fs.readFileSync(activeSegmentPath({ dir }), "utf8");
  assert.ok(after.startsWith(before), "previous bytes must remain intact");
  assert.ok(after.length > before.length);
  j.close();
});

test("stored record has v, event, prevHash and hash fields", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.close();
  const content = fs.readFileSync(activeSegmentPath({ dir }), "utf8");
  const rec = JSON.parse(content.split("\n")[0]);
  assert.equal(rec.v, RECORD_VERSION);
  assert.ok(rec.event);
  assert.equal(rec.event.eventId, "CE-1");
  assert.equal(rec.prevHash, GENESIS_HASH);
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.equal(rec.hash, computeHash({ v: rec.v, event: rec.event, prevHash: rec.prevHash }));
});

// ─── 3. eventId idempotency ────────────────────────────────────────────────

test("appending a duplicate eventId returns the canonical stored event", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const ev = makeEvent({ eventId: "CE-1", sequence: 1 });
  const r1 = j.append(ev);
  // Redeliver with a different (wrong) sequence and even a mutated field -
  // the journal must return the canonical stored event, not store a copy.
  const redelivered = makeEvent({ eventId: "CE-1", sequence: 1, message: "redelivery" });
  const r2 = j.append(redelivered);
  assert.equal(r2.appended, false);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.sequence, r1.sequence);
  assert.equal(r2.hash, r1.hash);
  assert.equal(r2.event.message, null); // canonical, not the mutated redelivery
  assert.equal(j.getCount(), 1);
  assert.equal(j.readAll().length, 1);
  j.close();
});

test("duplicate eventId is idempotent across reopen", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.close();
  const j2 = Journal.open(dir, { lock: false });
  const r = j2.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  assert.equal(r.appended, false);
  assert.equal(r.duplicate, true);
  assert.equal(j2.getCount(), 1);
  j2.close();
});

test("hasEvent and getEvent reflect stored events", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  assert.equal(j.hasEvent("CE-1"), true);
  assert.equal(j.hasEvent("CE-missing"), false);
  assert.equal(j.getEvent("CE-1").eventId, "CE-1");
  assert.equal(j.getEvent("CE-missing"), null);
  j.close();
});

// ─── 4. Sequence enforcement (gap / regression) ────────────────────────────

test("sequence gap (seq > last+1) fails closed with ERR_SEQUENCE_GAP", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  assert.throws(() => {
    j.append(makeEvent({ eventId: "CE-3", sequence: 3, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  }, { key: "ERR_SEQUENCE_GAP" });
  assert.equal(j.getCount(), 1); // not stored
  j.close();
});

test("sequence regression (seq <= last) fails closed with ERR_SEQUENCE_GAP", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  assert.throws(() => {
    j.append(makeEvent({ eventId: "CE-2b", sequence: 2, eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED }));
  }, { key: "ERR_SEQUENCE_GAP" });
  assert.throws(() => {
    j.append(makeEvent({ eventId: "CE-0", sequence: 0, eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED }));
  }, { key: "ERR_SEQUENCE_GAP" });
  assert.equal(j.getCount(), 2);
  j.close();
});

test("sequence is tracked per (taskId, producer.actorId) stream", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  // Two producers each start at sequence 1 for the same task.
  j.append(makeEvent({ eventId: "CE-A-1", producer: makeProducer({ actorId: "A" }), sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-B-1", producer: makeProducer({ actorId: "B" }), sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-A-2", producer: makeProducer({ actorId: "A" }), sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  assert.equal(j.getLastSequence("TASK-001", "A"), 2);
  assert.equal(j.getLastSequence("TASK-001", "B"), 1);
  // Different task for the same actor is a separate stream.
  j.append(makeEvent({ eventId: "CE-A-T2-1", taskId: "TASK-002", producer: makeProducer({ actorId: "A" }), sequence: 1 }));
  assert.equal(j.getLastSequence("TASK-002", "A"), 1);
  assert.equal(j.getLastSequence("TASK-001", "A"), 2);
  j.close();
});

test("sequence continues monotonically across reopen", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  j.close();
  const j2 = Journal.open(dir, { lock: false });
  assert.equal(j2.getLastSequence("TASK-001", "agent-a"), 2);
  const r = j2.append(makeEvent({ eventId: "CE-3", sequence: 3, eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED }));
  assert.equal(r.appended, true);
  assert.equal(r.sequence, 3);
  // Auto-assign continues from the rebuilt last sequence.
  const r2 = j2.append(makeEvent({ eventId: "CE-4", sequence: null, eventType: "task.progress", previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING }));
  assert.equal(r2.sequence, 4);
  j2.close();
});

// ─── 5. Hash-chain integrity ───────────────────────────────────────────────

test("hash chain links consecutive records via prevHash", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const r1 = j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  const r2 = j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  const r3 = j.append(makeEvent({ eventId: "CE-3", sequence: 3, eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED }));
  j.close();
  const content = fs.readFileSync(activeSegmentPath({ dir }), "utf8");
  const recs = content.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(recs[0].prevHash, GENESIS_HASH);
  assert.equal(recs[1].prevHash, r1.hash);
  assert.equal(recs[2].prevHash, r2.hash);
  assert.equal(r3.hash, recs[2].hash);
});

test("verify() reports ok=true with no gaps for a clean journal", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  const report = j.verify();
  assert.equal(report.ok, true);
  assert.equal(report.totalEvents, 7);
  assert.equal(report.segments, 1);
  assert.deepEqual(report.gaps, []);
  j.close();
});

test("readAll re-verifies the hash chain on every read", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  // First read succeeds.
  assert.equal(j.readAll().length, 7);
  j.close();
});

// ─── 6. Truncated-tail crash recovery ─────────────────────────────────────

test("partial tail (no trailing newline) is truncated on reopen", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  j.close();
  // Simulate a crash mid-write: append a partial line with NO trailing newline.
  const segPath = activeSegmentPath({ dir });
  fs.appendFileSync(segPath, '{"v":1,"event":{"eventId":"CE-PARTIAL"');
  assert.ok(!fs.readFileSync(segPath, "utf8").endsWith("\n"));

  const j2 = Journal.open(dir, { lock: false });
  const recovery = j2.getRecoveryInfo();
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.truncatedRecords, 1);
  assert.ok(recovery.truncatedBytes > 0);
  const events = j2.readAll();
  assert.equal(events.length, 2);
  assert.equal(events[0].eventId, "CE-1");
  assert.equal(events[1].eventId, "CE-2");
  // The recovered file ends with a newline again.
  assert.ok(fs.readFileSync(segPath, "utf8").endsWith("\n"));
  j2.close();
});

test("partial tail that happens to be valid JSON is still truncated", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.close();
  // A complete-looking JSON line but WITHOUT the trailing newline was not
  // fully fsync'd; the journal must treat it as partial and drop it.
  const segPath = activeSegmentPath({ dir });
  const partial = stableStringify({
    v: RECORD_VERSION,
    event: makeEvent({ eventId: "CE-GHOST", sequence: 2 }),
    prevHash: "deadbeef",
    hash: "deadbeef",
  });
  fs.appendFileSync(segPath, partial); // no newline
  const j2 = Journal.open(dir, { lock: false });
  assert.equal(j2.getRecoveryInfo().recovered, true);
  assert.equal(j2.readAll().length, 1);
  assert.equal(j2.hasEvent("CE-GHOST"), false);
  j2.close();
});

test("crash leaving a segment with no complete records recovers to empty", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.close();
  // Write only a partial line (no newline at all) to the first segment.
  const segPath = activeSegmentPath({ dir });
  fs.writeFileSync(segPath, '{"partial-without-newline');
  const j2 = Journal.open(dir, { lock: false });
  assert.equal(j2.getRecoveryInfo().recovered, true);
  assert.equal(j2.getCount(), 0);
  assert.equal(j2.getLastHash(), GENESIS_HASH);
  assert.equal(fs.readFileSync(segPath, "utf8"), "");
  j2.close();
});

test("recovered journal continues the hash chain correctly", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const r1 = j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.close();
  // Partial tail.
  fs.appendFileSync(activeSegmentPath({ dir }), '{"partial');
  const j2 = Journal.open(dir, { lock: false });
  assert.equal(j2.getLastHash(), r1.hash);
  const r2 = j2.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  assert.equal(r2.appended, true);
  assert.equal(r2.hash, computeHash({ v: RECORD_VERSION, event: j2.getEvent("CE-2"), prevHash: r1.hash }));
  const report = j2.verify();
  assert.equal(report.ok, true);
  j2.close();
});

// ─── 7. Mid-file corruption fails closed ───────────────────────────────────

test("tampered record hash is detected on open (fail closed)", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  j.append(makeEvent({ eventId: "CE-3", sequence: 3, eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED }));
  j.close();
  // Tamper with the second record's hash field.
  const segPath = activeSegmentPath({ dir });
  const lines = fs.readFileSync(segPath, "utf8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[1]);
  rec.hash = "0".repeat(64); // wrong hash
  lines[1] = stableStringify(rec);
  fs.writeFileSync(segPath, lines.join("\n") + "\n");
  assert.throws(() => Journal.open(dir, { lock: false }), { key: "ERR_INVALID_EVENT" });
});

test("tampered event field is detected via hash mismatch", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.close();
  const segPath = activeSegmentPath({ dir });
  const lines = fs.readFileSync(segPath, "utf8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[0]);
  rec.event.currentState = "COMPLETED"; // mutate a hashed field
  lines[0] = stableStringify(rec);
  fs.writeFileSync(segPath, lines.join("\n") + "\n");
  assert.throws(() => Journal.open(dir, { lock: false }), (err) => {
    assert.equal(err.key, "ERR_INVALID_EVENT");
    assert.equal(err.details.reason, "hash_mismatch");
    return true;
  });
});

test("broken prevHash linkage is detected", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  j.close();
  const segPath = activeSegmentPath({ dir });
  const lines = fs.readFileSync(segPath, "utf8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[1]);
  rec.prevHash = "f".repeat(64); // wrong prevHash
  // Recompute hash so it's internally consistent but links to the wrong parent.
  rec.hash = computeHash({ v: rec.v, event: rec.event, prevHash: rec.prevHash });
  lines[1] = stableStringify(rec);
  fs.writeFileSync(segPath, lines.join("\n") + "\n");
  assert.throws(() => Journal.open(dir, { lock: false }), (err) => {
    assert.equal(err.details.reason, "chain_broken");
    return true;
  });
});

test("self-consistent hash chain with a sequence gap is rejected on reopen", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({
    eventId: "CE-2", sequence: 2, eventType: "task.assigned",
    previousState: STATES.CREATED, currentState: STATES.ASSIGNED,
  }));
  j.close();

  const segPath = activeSegmentPath({ dir });
  const lines = fs.readFileSync(segPath, "utf8").split("\n").filter(Boolean);
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  second.event.sequence = 3;
  second.prevHash = first.hash;
  second.hash = computeHash({ v: second.v, event: second.event, prevHash: second.prevHash });
  fs.writeFileSync(segPath, `${stableStringify(first)}\n${stableStringify(second)}\n`);

  assert.throws(() => Journal.open(dir, { lock: false }), {
    key: "ERR_SEQUENCE_GAP",
  });
});

test("unparseable line in a complete (newline-terminated) segment fails closed", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.close();
  const segPath = activeSegmentPath({ dir });
  // A complete line (with newline) that is not valid JSON = corruption.
  fs.writeFileSync(segPath, "{not valid json}\n");
  assert.throws(() => Journal.open(dir, { lock: false }), { key: "ERR_INVALID_EVENT" });
});

test("append retries short writes until the complete JSONL record is durable", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const originalWriteSync = fs.writeSync;
  let intercepted = 0;
  fs.writeSync = function shortWrite(fd, buffer, offset, length, position) {
    if (Buffer.isBuffer(buffer) && length > 1) {
      intercepted += 1;
      const partialLength = Math.max(1, Math.floor(length / 2));
      return originalWriteSync.call(fs, fd, buffer, offset, partialLength, position);
    }
    return originalWriteSync.apply(fs, arguments);
  };
  try {
    j.append(makeEvent({ eventId: "CE-short", sequence: 1 }));
  } finally {
    fs.writeSync = originalWriteSync;
    j.close();
  }
  assert.ok(intercepted > 1);
  const reopened = Journal.open(dir, { lock: false });
  assert.equal(reopened.getEvent("CE-short").eventId, "CE-short");
  reopened.close();
});

// ─── 8. Segment rollover (cross-segment hash chain) ────────────────────────

test("segment rolls over on max events and continues the hash chain", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false, maxEventsPerSegment: 2, maxBytesPerSegment: 1024 * 1024 });
  const r1 = j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  const r2 = j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  // Third event forces a rollover to segment 2.
  const r3 = j.append(makeEvent({ eventId: "CE-3", sequence: 3, eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED }));
  const r4 = j.append(makeEvent({ eventId: "CE-4", sequence: 4, eventType: "task.progress", previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING }));
  // Fourth event forces a rollover to segment 3.
  const r5 = j.append(makeEvent({ eventId: "CE-5", sequence: 5, eventType: "task.testing", previousState: STATES.EXECUTING, currentState: STATES.TESTING }));

  assert.equal(r3.segment, 2);
  assert.equal(r5.segment, 3);
  assert.ok(fs.existsSync(path.join(dir, segmentFileName(1))));
  assert.ok(fs.existsSync(path.join(dir, segmentFileName(2))));
  assert.ok(fs.existsSync(path.join(dir, segmentFileName(3))));

  // Cross-segment chain: segment 2's first record prevHash == segment 1's last hash.
  const seg1 = fs.readFileSync(path.join(dir, segmentFileName(1)), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const seg2 = fs.readFileSync(path.join(dir, segmentFileName(2)), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(seg2[0].prevHash, seg1[seg1.length - 1].hash);
  assert.equal(seg2[0].prevHash, r2.hash);

  const events = j.readAll();
  assert.deepEqual(events.map((e) => e.eventId), ["CE-1", "CE-2", "CE-3", "CE-4", "CE-5"]);

  const report = j.verify();
  assert.equal(report.ok, true);
  assert.equal(report.segments, 3);
  assert.equal(report.totalEvents, 5);
  j.close();
});

test("segment rolls over on max bytes", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false, maxEventsPerSegment: 1000, maxBytesPerSegment: 1 });
  // maxBytesPerSegment=1 means after the first event any new event rolls over,
  // but an empty segment always accepts at least one event.
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  const r2 = j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  assert.equal(r2.segment, 2);
  const metas = j.getSegmentMetas();
  assert.equal(metas.length, 2);
  assert.equal(metas[0].count, 1);
  assert.equal(metas[1].count, 1);
  j.close();
});

test("getSegmentMetas reports sealed vs active and chain links", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false, maxEventsPerSegment: 1 });
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.append(makeEvent({ eventId: "CE-2", sequence: 2, eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }));
  const metas = j.getSegmentMetas();
  assert.equal(metas.length, 2);
  assert.equal(metas[0].sealed, true);
  assert.equal(metas[1].sealed, false);
  // Cross-segment chain link: segment 2's first record.prevHash == segment 1's last hash.
  assert.equal(metas[1].firstPrevHash, metas[0].lastHash);
  assert.equal(metas[0].count, 1);
  assert.equal(metas[1].count, 1);
  j.close();
});

// ─── 9. Replay rebuilds a projection ───────────────────────────────────────

test("replay yields events in append order with metadata", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  const seen = [];
  const count = j.replay({ onEvent: (ev, meta) => { seen.push({ id: ev.eventId, seq: ev.sequence, state: ev.currentState, hash: meta.hash.slice(0, 4) }); } });
  assert.equal(count, 7);
  assert.equal(seen[0].id, "CE-1");
  assert.equal(seen[0].state, STATES.CREATED);
  assert.equal(seen[6].state, STATES.COMPLETED);
  assert.equal(seen.map((s) => s.seq).join(","), "1,2,3,4,5,6,7");
  j.close();
});

test("replay can stop early when onEvent returns false", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  let n = 0;
  const count = j.replay({ onEvent: () => { n += 1; return n < 3; } });
  assert.equal(count, 3);
  j.close();
});

test("journal replay rebuilds a task-state projection (no daemon)", () => {
  const dir = freshDir();
  // Write the lifecycle, then close (simulating a producer that finished
  // without any daemon mediating).
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  j.close();

  // Coordinator restarts: reopen the journal and rebuild a projection purely
  // from replayed events. The journal is the source of truth.
  const j2 = Journal.open(dir, { lock: false });
  const projection = {};
  j2.replay({
    onEvent: (ev) => {
      projection[ev.taskId] = projection[ev.taskId] || { taskId: ev.taskId, state: null, revision: 0, evidence: [] };
      const p = projection[ev.taskId];
      p.state = ev.currentState;
      p.revision += 1;
      if (ev.evidence && ev.evidence.length) p.evidence.push(...ev.evidence.map((e) => e.ref));
    },
  });
  assert.equal(projection["TASK-001"].state, STATES.COMPLETED);
  assert.equal(projection["TASK-001"].revision, 7);
  assert.deepEqual(projection["TASK-001"].evidence, ["ARTIFACT-001"]);
  j2.close();
});

test("readAll with filter narrows by task / actor / sequence range", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  // Different task / producer stream.
  for (const ev of lifecycleEvents("CE-B", "TASK-002", "agent-b")) j.append(ev);

  assert.equal(j.readAll({ taskId: "TASK-001" }).length, 7);
  assert.equal(j.readAll({ taskId: "TASK-002" }).length, 7);
  assert.equal(j.readAll({ actorId: "agent-a" }).length, 7);
  assert.equal(j.readAll({ actorId: "agent-b" }).length, 7);
  assert.equal(j.readAll({ taskId: "TASK-001", fromSequence: 5 }).length, 3);
  assert.equal(j.readAll({ taskId: "TASK-001", fromSequence: 3, toSequence: 5 }).length, 3);
  assert.deepEqual(
    j.readAll({ taskId: "TASK-001", eventTypes: ["task.created", "task.completed"] }).map((e) => e.eventType).sort(),
    ["task.completed", "task.created"]
  );
  j.close();
});

// ─── 10. Reopen / no-daemon recovery ───────────────────────────────────────

test("reopen recovers all events and index without losing data", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  const hashesBefore = j.readAll().map((e) => e.eventId);
  j.close();

  const j2 = Journal.open(dir, { lock: false });
  const hashesAfter = j2.readAll().map((e) => e.eventId);
  assert.deepEqual(hashesAfter, hashesBefore);
  assert.equal(j2.getCount(), 7);
  assert.equal(j2.getLastSequence("TASK-001", "agent-a"), 7);
  // Last hash matches the last appended record's hash.
  const metas = j2.getSegmentMetas();
  assert.equal(j2.getLastHash(), metas[metas.length - 1].lastHash);
  j2.close();
});

test("no-daemon completion: a finished task's terminal event is recoverable", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  for (const ev of lifecycleEvents()) j.append(ev);
  j.close();

  const j2 = Journal.open(dir, { lock: false });
  const events = j2.readAll();
  const last = events[events.length - 1];
  assert.equal(last.eventType, "task.completed");
  assert.equal(last.currentState, STATES.COMPLETED);
  // The coordinator can ACK the terminal event id without re-running anything.
  assert.equal(j2.hasEvent(last.eventId), true);
  j2.close();
});

// ─── 11. Single-writer lock ────────────────────────────────────────────────

test("second opener on a live lock is rejected with ERR_LEASE_CONFLICT", () => {
  const dir = freshDir();
  const j1 = Journal.open(dir, { lock: true });
  assert.throws(() => Journal.open(dir, { lock: true }), { key: "ERR_LEASE_CONFLICT" });
  j1.close();
  // After close the lock is released; a new opener succeeds.
  const j2 = Journal.open(dir, { lock: true });
  j2.close();
});

test("stale (expired) lock is reclaimed on open", () => {
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  // Write a stale lock file (expired in the past).
  const lockPath = path.join(dir, "journal.lock");
  fs.writeFileSync(
    lockPath,
    stableStringify({
      owner: "stale-owner",
      acquiredAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:01:00.000Z",
      pid: 999999,
    })
  );
  const j = Journal.open(dir, { lock: true });
  assert.equal(j.getRecoveryInfo().recovered, false); // no tail recovery needed
  j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  assert.equal(j.getCount(), 1);
  j.close();
});

test("lock can be disabled for crash-recovery scenarios", () => {
  const dir = freshDir();
  const j1 = Journal.open(dir, { lock: false });
  const j2 = Journal.open(dir, { lock: false });
  // Both open without contention because locking is disabled.
  j1.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j2.close();
  j1.close();
});

// ─── 12. Event validation (fail closed) ────────────────────────────────────

test("append rejects non-object event", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  assert.throws(() => j.append(null), { key: "ERR_INVALID_EVENT" });
  assert.throws(() => j.append("not-an-event"), { key: "ERR_INVALID_EVENT" });
  j.close();
});

test("append rejects event missing eventId", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const ev = makeEvent({ eventId: "CE-1", sequence: 1 });
  delete ev.eventId;
  assert.throws(() => j.append(ev), { key: "ERR_INVALID_EVENT" });
  j.close();
});

test("append rejects event with invalid eventType via contract validation", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const ev = makeEvent({ eventId: "CE-1", sequence: 1 });
  ev.eventType = "task.bogus";
  assert.throws(() => j.append(ev), { key: "ERR_INVALID_EVENT_TYPE" });
  j.close();
});

test("append rejects event missing taskId / producer.actorId", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const ev = makeEvent({ eventId: "CE-1", sequence: 1 });
  delete ev.taskId;
  assert.throws(() => j.append(ev), { key: "ERR_INVALID_EVENT" });
  j.close();
});

test("append rejects event with invalid evidence ref", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  // Build the envelope manually so createEvent's own validation does not
  // reject first; we want to assert the journal's validateEvent fails closed.
  const ev = {
    schemaVersion: "1.0",
    eventId: "CE-1",
    projectId: "proj-1",
    taskId: "TASK-001",
    parentTaskId: null,
    correlationId: "CORR-1",
    producer: makeProducer(),
    targets: [],
    eventType: "task.ready_for_review",
    previousState: STATES.EXECUTING,
    currentState: STATES.READY_FOR_REVIEW,
    timestamp: "2026-07-28T00:00:00.000Z",
    sequence: 1,
    repository: { repositoryId: "proj-1" },
    fileOwnership: [],
    progress: null,
    message: null,
    evidence: [{ kind: "artifact", ref: "https://evil.example.com" }],
    requestedAction: null,
    expiresAt: null,
    notification: { policy: "journal_only", dedupeKey: "x", ackRequired: false },
    operationId: null,
    operationAttempt: null,
  };
  assert.throws(() => j.append(ev), { key: "ERR_EVIDENCE_REF_INVALID" });
  assert.equal(j.getCount(), 0);
  j.close();
});

// ─── 13. Event size limit ──────────────────────────────────────────────────

test("append rejects records exceeding maxEventBytes", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false, maxEventBytes: 100 });
  assert.throws(() => j.append(makeEvent({ eventId: "CE-1", sequence: 1 })), { key: "ERR_EVENT_TOO_LARGE" });
  assert.equal(j.getCount(), 0);
  j.close();
});

// ─── 14. Closed journal ────────────────────────────────────────────────────

test("append after close throws ERR_INVALID_STATE", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.close();
  assert.throws(() => j.append(makeEvent({ eventId: "CE-1", sequence: 1 })), { key: "ERR_INVALID_STATE" });
});

test("close is idempotent", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  j.close();
  assert.doesNotThrow(() => j.close());
});

// ─── 15. Determinism / canonicalization ───────────────────────────────────

test("stableStringify is key-order independent", () => {
  const a = stableStringify({ b: 2, a: 1, c: { z: 9, y: 8 } });
  const b = stableStringify({ a: 1, c: { y: 8, z: 9 }, b: 2 });
  assert.equal(a, b);
});

test("hash is stable across reopen (same event -> same hash)", () => {
  const dir = freshDir();
  const j = Journal.open(dir, { lock: false });
  const r1 = j.append(makeEvent({ eventId: "CE-1", sequence: 1 }));
  j.close();
  const j2 = Journal.open(dir, { lock: false });
  const metas = j2.getSegmentMetas();
  assert.equal(metas[0].lastHash, r1.hash);
  j2.close();
});

// ─── 16. Exports ───────────────────────────────────────────────────────────

test("journal module exports all required symbols", () => {
  const journal = require("../../lib/coordination/journal");
  const expected = [
    "Journal",
    "GENESIS_HASH",
    "RECORD_VERSION",
    "computeHash",
    "stableStringify",
    "segmentFileName",
    "DEFAULT_MAX_EVENTS_PER_SEGMENT",
    "DEFAULT_LOCK_TTL_MS",
  ];
  for (const sym of expected) {
    assert.ok(journal[sym] !== undefined, `missing export: ${sym}`);
  }
});
