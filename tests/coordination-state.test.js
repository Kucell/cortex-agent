"use strict";

// ─── T-ACN-004: State Machine & Snapshot tests ─────────────────────────────
// Covers: deterministic reducer, revision/lastSequence, idempotent replay,
// illegal-transition fail-closed, sequence gap / out-of-order (no guessing),
// previousState mismatch, ABSENT guard, Run.phase protection, snapshot atomic
// write, CAS by revision, corruption detection, and journal-replay recovery.
//
// Validates M-008 VC-003 ("snapshot recovery, dedupe, sequence reconcile").
// Zero third-party dependencies.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEvent, STATES, SCHEMA_VERSION } = require("../lib/coordination/contract");
const { CODES, CoordinationError } = require("../lib/coordination/errors");
const {
  reduce, replay, createInitialState, LIVENESS_EVENT_TYPES,
} = require("../lib/coordination/state");
const {
  writeSnapshot, readSnapshot, loadTaskState, recoverSnapshot,
  buildSnapshotEnvelope, computeIntegrity, canonicalStringify,
  SNAPSHOT_SCHEMA_VERSION,
} = require("../lib/coordination/snapshot");

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProducer(overrides = {}) {
  return { actorId: "agent-1", kind: "agent", vendor: "test", ...overrides };
}

let SEQ = 0;
function nextSeq() { return ++SEQ; }

function makeEvent(overrides = {}) {
  const seq = overrides.sequence !== undefined ? overrides.sequence : nextSeq();
  return createEvent({
    eventId: `CE-${seq}-${overrides.eventType || "x"}`,
    projectId: "proj-1",
    taskId: "TASK-001",
    correlationId: "CORR-1",
    producer: makeProducer(),
    targets: [{ actorId: "coordinator", kind: "coordinator" }],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: `2026-07-28T00:00:${String(seq).padStart(2, "0")}.000Z`,
    sequence: seq,
    repository: { repositoryId: "proj-1", worktreeId: null, branch: "main", baselineCommit: null },
    notification: { policy: "journal_only", dedupeKey: "task.created", ackRequired: false },
    ...overrides,
  });
}

// Build a full legal lifecycle to READY_FOR_REVIEW with evidence.
function readyLifecycle(taskId = "TASK-001") {
  const ev = (id, type, prev, cur, seq, extra = {}) => makeEvent({
    eventId: id, eventType: type, previousState: prev, currentState: cur, sequence: seq, taskId,
    targets: [], ...extra,
  });
  return [
    ev("CE-1", "task.created", null, STATES.CREATED, 1),
    ev("CE-2", "task.assigned", STATES.CREATED, STATES.ASSIGNED, 2),
    ev("CE-3", "task.accepted", STATES.ASSIGNED, STATES.ACCEPTED, 3),
    ev("CE-4", "task.progress", STATES.ACCEPTED, STATES.EXECUTING, 4),
    ev("CE-5", "task.testing", STATES.EXECUTING, STATES.TESTING, 5),
    ev("CE-6", "task.ready_for_review", STATES.TESTING, STATES.READY_FOR_REVIEW, 6,
      { evidence: [{ kind: "artifact", ref: "ARTIFACT-001" }] }),
  ];
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coord-state-"));
}

// ─── 1. Reducer basics & determinism ───────────────────────────────────────

test("ABSENT -> CREATED applies task.created with revision 1 and lastSequence 1", () => {
  const e = makeEvent({ sequence: 1 });
  const r = reduce(null, e);
  assert.equal(r.applied, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.state.state, STATES.CREATED);
  assert.equal(r.state.revision, 1);
  assert.equal(r.state.lastSequence, 1);
  assert.equal(r.state.lastEventId, e.eventId);
  assert.equal(r.state.schemaVersion, SCHEMA_VERSION);
  // deterministic timestamps come from the event, not wall-clock
  assert.equal(r.state.createdAt, e.timestamp);
  assert.equal(r.state.updatedAt, e.timestamp);
});

test("full legal lifecycle reaches COMPLETED with monotonic revision/lastSequence", () => {
  const events = readyLifecycle();
  events.push(makeEvent({
    eventId: "CE-7", eventType: "task.completed",
    previousState: STATES.READY_FOR_REVIEW, currentState: STATES.COMPLETED,
    sequence: 7, targets: [],
  }));
  const { state, log } = replay(events);
  assert.equal(state.state, STATES.COMPLETED);
  assert.equal(state.revision, 7);
  assert.equal(state.lastSequence, 7);
  assert.equal(log.length, 7);
  assert.ok(log.every((l) => l.applied && !l.duplicate));
});

test("revision bumps once per applied event; lastSequence equals event sequence", () => {
  const events = readyLifecycle();
  let state = null;
  const seen = [];
  for (const e of events) {
    const r = reduce(state, e);
    state = r.state;
    seen.push({ revision: state.revision, lastSequence: state.lastSequence, seq: e.sequence });
  }
  seen.forEach((s, i) => {
    assert.equal(s.revision, i + 1);
    assert.equal(s.lastSequence, s.seq);
  });
});

test("reducer is deterministic: identical events yield identical state", () => {
  const events = readyLifecycle();
  const a = replay(events).state;
  const b = replay(events).state;
  assert.deepEqual(a, b);
  // canonical hash equality as a strong determinism check
  assert.equal(computeIntegrity(a), computeIntegrity(b));
});

test("reduce accepts validateEnvelope:false to skip envelope re-validation", () => {
  const e = makeEvent({ sequence: 1 });
  const r = reduce(null, e, { validateEnvelope: false });
  assert.equal(r.applied, true);
  assert.equal(r.state.state, STATES.CREATED);
});

// ─── 2. Idempotent replay (dedupe) ─────────────────────────────────────────

test("duplicate event (same sequence <= lastSequence) is a no-op: state unchanged", () => {
  const events = readyLifecycle();
  const { state } = replay(events);
  const dup = events[events.length - 1]; // sequence 6
  const r = reduce(state, dup);
  assert.equal(r.applied, false);
  assert.equal(r.duplicate, true);
  assert.equal(r.state, state); // same reference, no new state
  assert.equal(r.revision, state.revision); // revision unchanged
});

test("out-of-order older event (sequence < expected) is an idempotent no-op, not a gap", () => {
  const events = readyLifecycle();
  const { state } = replay(events); // lastSequence 6
  const older = events[1]; // sequence 2
  const r = reduce(state, older);
  assert.equal(r.applied, false);
  assert.equal(r.duplicate, true);
  assert.equal(r.state, state);
});

test("replay with a duplicate in the stream is idempotent: final state unchanged", () => {
  const events = readyLifecycle();
  const baseline = replay(events).state;
  const withDup = replay([...events, events[2]]).state; // replay CE-3 again
  assert.deepEqual(withDup, baseline);
});

test("duplicate event delivery does not bump snapshot revision", () => {
  const dir = tmpDir();
  try {
    const events = readyLifecycle();
    const e1 = events[0];
    const e2 = events[1];
    // first write
    const s1 = reduce(null, e1).state;
    writeSnapshot(dir, s1, { expectedRevision: 0 });
    assert.equal(loadTaskState(dir, "TASK-001").revision, 1);
    // second write (rev 2)
    const s2 = reduce(s1, e2).state;
    writeSnapshot(dir, s2, { expectedRevision: 1 });
    assert.equal(loadTaskState(dir, "TASK-001").revision, 2);
    // deliver e2 again (duplicate) -> state still rev 2; CAS write stays at rev 2
    const dup = reduce(s2, e2);
    assert.equal(dup.applied, false);
    assert.equal(dup.state.revision, 2);
    writeSnapshot(dir, dup.state, { expectedRevision: 2 });
    assert.equal(loadTaskState(dir, "TASK-001").revision, 2); // NOT 3
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 3. Illegal transition fail-closed ─────────────────────────────────────

test("illegal transition (CREATED -> EXECUTING) fails closed and leaves state unchanged", () => {
  const created = reduce(null, makeEvent({ sequence: 1 })).state;
  const bad = makeEvent({
    eventId: "CE-BAD", eventType: "task.progress",
    previousState: STATES.CREATED, currentState: STATES.EXECUTING, sequence: 2, targets: [],
  });
  assert.throws(() => reduce(created, bad), { key: "ERR_INVALID_TRANSITION" });
});

test("transition from a terminal state (COMPLETED -> EXECUTING) fails closed", () => {
  const events = readyLifecycle();
  events.push(makeEvent({
    eventId: "CE-7", eventType: "task.completed",
    previousState: STATES.READY_FOR_REVIEW, currentState: STATES.COMPLETED, sequence: 7, targets: [],
  }));
  const { state } = replay(events);
  const bad = makeEvent({
    eventId: "CE-8", eventType: "task.progress",
    previousState: STATES.COMPLETED, currentState: STATES.EXECUTING, sequence: 8, targets: [],
  });
  assert.throws(() => reduce(state, bad), { key: "ERR_INVALID_TRANSITION" });
});

test("event type not legal for the transition fails closed (ERR_EVENT_NOT_LEGAL)", () => {
  const created = reduce(null, makeEvent({ sequence: 1 })).state;
  // CREATED -> ASSIGNED is legal only via task.assigned, not task.accepted
  const bad = makeEvent({
    eventId: "CE-X", eventType: "task.accepted",
    previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2, targets: [],
  });
  assert.throws(() => reduce(created, bad), { key: "ERR_EVENT_NOT_LEGAL" });
});

test("READY_FOR_REVIEW transition without evidence fails closed (ERR_MISSING_EVIDENCE)", () => {
  const events = readyLifecycle().slice(0, 5); // up to TESTING
  const { state } = replay(events);
  const noEvidence = makeEvent({
    eventId: "CE-NE", eventType: "task.ready_for_review",
    previousState: STATES.TESTING, currentState: STATES.READY_FOR_REVIEW,
    sequence: 6, targets: [], evidence: [],
  });
  assert.throws(() => reduce(state, noEvidence), { key: "ERR_MISSING_EVIDENCE" });
});

test("WAITING_FOR_INPUT without requestedAction fails closed (ERR_MISSING_REQUESTED_ACTION)", () => {
  const created = reduce(null, makeEvent({ sequence: 1 })).state;
  const accepted = reduce(created, makeEvent({
    eventId: "CE-2", eventType: "task.assigned",
    previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2, targets: [],
  })).state;
  const acc = reduce(accepted, makeEvent({
    eventId: "CE-3", eventType: "task.accepted",
    previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, sequence: 3, targets: [],
  })).state;
  const bad = makeEvent({
    eventId: "CE-4", eventType: "task.input_required",
    previousState: STATES.ACCEPTED, currentState: STATES.WAITING_FOR_INPUT,
    sequence: 4, targets: [], requestedAction: null,
  });
  assert.throws(() => reduce(acc, bad), { key: "ERR_MISSING_REQUESTED_ACTION" });
});

test("same-state event for a non-liveness type fails closed", () => {
  const created = reduce(null, makeEvent({ sequence: 1 })).state;
  // task.assigned with previousState === currentState === CREATED is not liveness
  const bad = makeEvent({
    eventId: "CE-SS", eventType: "task.assigned",
    previousState: STATES.CREATED, currentState: STATES.CREATED, sequence: 2, targets: [],
  });
  assert.throws(() => reduce(created, bad), { key: "ERR_INVALID_TRANSITION" });
});

test("same-state bookkeeping events include ownership release", () => {
  assert.deepEqual([...LIVENESS_EVENT_TYPES].sort(),
    ["artifact.ready", "ownership.released", "task.heartbeat", "task.progress"]);
});

test("heartbeat is a legal same-state liveness update (bumps revision/lastSequence)", () => {
  const events = readyLifecycle().slice(0, 5); // up to TESTING
  const { state } = replay(events); // lastSequence 5
  const hb = makeEvent({
    eventId: "CE-HB", eventType: "task.heartbeat",
    previousState: STATES.TESTING, currentState: STATES.TESTING,
    sequence: 6, targets: [], expiresAt: "2026-07-28T01:00:00.000Z",
  });
  const r = reduce(state, hb);
  assert.equal(r.applied, true);
  assert.equal(r.sameState, true);
  assert.equal(r.state.state, STATES.TESTING); // state unchanged
  assert.equal(r.state.revision, 6); // bumped
  assert.equal(r.state.lastSequence, 6);
  assert.equal(r.state.heartbeatDueAt, "2026-07-28T01:00:00.000Z");
});

// ─── 4. Sequence gap / out-of-order (no guessing) ──────────────────────────

test("sequence gap (sequence > lastSequence + 1) fails closed (ERR_SEQUENCE_GAP)", () => {
  const events = readyLifecycle().slice(0, 3); // lastSequence 3
  const { state } = replay(events);
  const gap = makeEvent({
    eventId: "CE-G", eventType: "task.progress",
    previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING,
    sequence: 9, targets: [],
  });
  let threw = null;
  try { reduce(state, gap); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.equal(threw.key, "ERR_SEQUENCE_GAP");
  assert.equal(threw.details.expected, 4);
  assert.equal(threw.details.actual, 9);
});

test("gap leaves state unchanged (no guessing of intermediate states)", () => {
  const events = readyLifecycle().slice(0, 3);
  const { state } = replay(events);
  const before = JSON.stringify(state);
  const gap = makeEvent({
    eventId: "CE-G", eventType: "task.progress",
    previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING,
    sequence: 10, targets: [],
  });
  try { reduce(state, gap); } catch (_e) { /* expected */ }
  assert.equal(JSON.stringify(state), before); // state object not mutated
});

test("replay across a gap throws and does not produce a partial advanced state", () => {
  const events = readyLifecycle().slice(0, 3);
  const gapEvent = makeEvent({
    eventId: "CE-G", eventType: "task.progress",
    previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING,
    sequence: 99, targets: [], timestamp: "2026-07-28T00:01:39.000Z",
  });
  assert.throws(() => replay([...events, gapEvent]), { key: "ERR_SEQUENCE_GAP" });
});

// ─── 5. previousState mismatch (stale / concurrent) ────────────────────────

test("event whose previousState disagrees with actual state fails closed (ERR_REVISION_MISMATCH)", () => {
  const events = readyLifecycle().slice(0, 4); // state EXECUTING
  const { state } = replay(events);
  const stale = makeEvent({
    eventId: "CE-STALE", eventType: "task.testing",
    previousState: STATES.ACCEPTED, currentState: STATES.TESTING, // claims ACCEPTED, actually EXECUTING
    sequence: 5, targets: [],
  });
  assert.throws(() => reduce(state, stale), { key: "ERR_REVISION_MISMATCH" });
});

test("correct previousState applies normally", () => {
  const events = readyLifecycle().slice(0, 4); // EXECUTING
  const { state } = replay(events);
  const ok = makeEvent({
    eventId: "CE-OK", eventType: "task.testing",
    previousState: STATES.EXECUTING, currentState: STATES.TESTING, sequence: 5, targets: [],
  });
  const r = reduce(state, ok);
  assert.equal(r.applied, true);
  assert.equal(r.state.state, STATES.TESTING);
});

// ─── 6. ABSENT guard ───────────────────────────────────────────────────────

test("non-task.created event from ABSENT fails closed (ERR_ABSENT_NO_EVENT)", () => {
  const bad = makeEvent({
    eventId: "CE-A", eventType: "task.assigned",
    previousState: null, currentState: STATES.ASSIGNED, sequence: 1, targets: [],
  });
  assert.throws(() => reduce(null, bad), { key: "ERR_ABSENT_NO_EVENT" });
});

// ─── 7. Run.phase protection ───────────────────────────────────────────────

test("task.completed carrying progress.phase fails closed (ERR_COMPLETED_RUN_PHASE_PROTECTED)", () => {
  const { state } = replay(readyLifecycle()); // READY_FOR_REVIEW
  const bad = makeEvent({
    eventId: "CE-RP", eventType: "task.completed",
    previousState: STATES.READY_FOR_REVIEW, currentState: STATES.COMPLETED,
    sequence: 7, targets: [], progress: { phase: "done", percent: 100 },
  });
  assert.throws(() => reduce(state, bad), { key: "ERR_COMPLETED_RUN_PHASE_PROTECTED" });
});

test("task.completed without progress.phase applies and does not touch Run.phase", () => {
  const { state } = replay(readyLifecycle()); // READY_FOR_REVIEW
  const ok = makeEvent({
    eventId: "CE-OK", eventType: "task.completed",
    previousState: STATES.READY_FOR_REVIEW, currentState: STATES.COMPLETED,
    sequence: 7, targets: [],
  });
  const r = reduce(state, ok);
  assert.equal(r.applied, true);
  assert.equal(r.state.state, STATES.COMPLETED);
  // snapshot stores coordination task state only; no Run.phase field is introduced
  assert.equal(r.state.progress, null);
});

test("Run.phase protection throw leaves state unchanged", () => {
  const { state } = replay(readyLifecycle());
  const before = JSON.stringify(state);
  const bad = makeEvent({
    eventId: "CE-RP2", eventType: "task.completed",
    previousState: STATES.READY_FOR_REVIEW, currentState: STATES.COMPLETED,
    sequence: 7, targets: [], progress: { phase: "done" },
  });
  try { reduce(state, bad); } catch (_e) { /* expected */ }
  assert.equal(JSON.stringify(state), before);
});

// ─── 8. Field updates ──────────────────────────────────────────────────────

test("assignee is set on task.assigned and cleared on task.cancelled", () => {
  const created = reduce(null, makeEvent({ sequence: 1 })).state;
  const assigned = reduce(created, makeEvent({
    eventId: "CE-2", eventType: "task.assigned",
    previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2,
    targets: [{ actorId: "agent-7", kind: "agent" }],
  })).state;
  assert.equal(assigned.assignee, "agent-7");
  // -> CANCEL_REQUESTED -> CANCELLED
  const cr = reduce(assigned, makeEvent({
    eventId: "CE-3", eventType: "task.cancel_requested",
    previousState: STATES.ASSIGNED, currentState: STATES.CANCEL_REQUESTED, sequence: 3, targets: [],
  })).state;
  const cancelled = reduce(cr, makeEvent({
    eventId: "CE-4", eventType: "task.cancelled",
    previousState: STATES.CANCEL_REQUESTED, currentState: STATES.CANCELLED, sequence: 4, targets: [],
  })).state;
  assert.equal(cancelled.assignee, null);
  assert.deepEqual(cancelled.ownership, []);
});

test("requestedAction set on input_required and cleared on progress", () => {
  let s = reduce(null, makeEvent({ sequence: 1 })).state;
  s = reduce(s, makeEvent({ eventId: "CE-2", eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2, targets: [] })).state;
  s = reduce(s, makeEvent({ eventId: "CE-3", eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, sequence: 3, targets: [] })).state;
  s = reduce(s, makeEvent({
    eventId: "CE-4", eventType: "task.input_required",
    previousState: STATES.ACCEPTED, currentState: STATES.WAITING_FOR_INPUT, sequence: 4, targets: [],
    requestedAction: { kind: "provide_input", ref: "DEC-001" },
  })).state;
  assert.deepEqual(s.requestedAction, { kind: "provide_input", ref: "DEC-001" });
  s = reduce(s, makeEvent({
    eventId: "CE-5", eventType: "task.progress",
    previousState: STATES.WAITING_FOR_INPUT, currentState: STATES.EXECUTING, sequence: 5, targets: [],
  })).state;
  assert.equal(s.requestedAction, null);
});

test("evidenceRefs are appended and deduped on ready_for_review / artifact.ready", () => {
  const { state } = replay(readyLifecycle());
  assert.deepEqual(state.evidenceRefs, ["ARTIFACT-001"]);
  // second artifact.ready same-state appends a new ref
  const r = reduce(state, makeEvent({
    eventId: "CE-AR", eventType: "artifact.ready",
    previousState: STATES.READY_FOR_REVIEW, currentState: STATES.READY_FOR_REVIEW,
    sequence: 7, targets: [], evidence: [{ kind: "artifact", ref: "ARTIFACT-002" }],
  }));
  assert.deepEqual(r.state.evidenceRefs, ["ARTIFACT-001", "ARTIFACT-002"]);
});

test("pendingCriticalEvents appends critical event ids (deduped)", () => {
  const { state } = replay(readyLifecycle());
  // task.created / assigned / accepted / ready_for_review are critical
  assert.ok(state.pendingCriticalEvents.includes("CE-1"));
  assert.ok(state.pendingCriticalEvents.includes("CE-6"));
  // dedup: replaying a critical event does not double-add (it's a no-op duplicate)
  const dup = reduce(state, readyLifecycle()[5]);
  assert.equal(dup.applied, false);
  assert.equal(dup.state, state);
});

// ─── 9. Snapshot atomic write + CAS ────────────────────────────────────────

test("writeSnapshot creates a valid envelope with integrity hash", () => {
  const dir = tmpDir();
  try {
    const s = reduce(null, makeEvent({ sequence: 1 })).state;
    const w = writeSnapshot(dir, s, { expectedRevision: 0, now: "2026-07-28T00:00:00.000Z" });
    assert.equal(w.revision, 1);
    assert.equal(w.writtenAt, "2026-07-28T00:00:00.000Z");
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "TASK-001.json"), "utf8"));
    assert.equal(raw.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(raw.kind, "coordination-task-snapshot");
    assert.equal(raw.integrityAlgo, "sha256");
    assert.equal(raw.integrity, computeIntegrity(raw.payload));
    assert.equal(raw.revision, 1);
    // no leftover temp files
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSnapshot CAS advances revision on matching expectedRevision", () => {
  const dir = tmpDir();
  try {
    const s1 = reduce(null, makeEvent({ sequence: 1 })).state;
    writeSnapshot(dir, s1, { expectedRevision: 0 });
    const s2 = reduce(s1, makeEvent({
      eventId: "CE-2", eventType: "task.assigned",
      previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2, targets: [],
    })).state;
    writeSnapshot(dir, s2, { expectedRevision: 1 });
    assert.equal(loadTaskState(dir, "TASK-001").revision, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSnapshot CAS rejects concurrent writer (ERR_REVISION_MISMATCH)", () => {
  const dir = tmpDir();
  try {
    const s1 = reduce(null, makeEvent({ sequence: 1 })).state;
    writeSnapshot(dir, s1, { expectedRevision: 0 });
    // stale writer still expects revision 0 but snapshot is now at 1
    assert.throws(() => writeSnapshot(dir, s1, { expectedRevision: 0 }), { key: "ERR_REVISION_MISMATCH" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSnapshot to absent with expectedRevision > 0 fails (ERR_REVISION_MISMATCH)", () => {
  const dir = tmpDir();
  try {
    const s = reduce(null, makeEvent({ sequence: 1 })).state;
    assert.throws(() => writeSnapshot(dir, s, { expectedRevision: 3 }), { key: "ERR_REVISION_MISMATCH" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two concurrent writers: only the CAS winner commits; loser fails", () => {
  const dir = tmpDir();
  try {
    // build to ACCEPTED (revision 3) - a state with multiple legal exits
    const events = readyLifecycle().slice(0, 3);
    let state = null;
    let expectedRevision = 0;
    for (const e of events) {
      const r = reduce(state, e);
      state = r.state;
      writeSnapshot(dir, state, { expectedRevision });
      expectedRevision = state.revision;
    }
    const loaded = loadTaskState(dir, "TASK-001"); // ACCEPTED, rev 3
    // both writers compute a different legal transition from ACCEPTED at seq 4
    const wA = reduce(loaded, makeEvent({
      eventId: "CE-A", eventType: "task.progress",
      previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING, sequence: 4, targets: [],
    })).state;
    const wB = reduce(loaded, makeEvent({
      eventId: "CE-B", eventType: "task.blocked",
      previousState: STATES.ACCEPTED, currentState: STATES.BLOCKED, sequence: 4, targets: [],
    })).state;
    // writer A wins CAS
    writeSnapshot(dir, wA, { expectedRevision: 3 });
    // writer B loses: snapshot is now at revision 4, B still expects 3
    assert.throws(() => writeSnapshot(dir, wB, { expectedRevision: 3 }), { key: "ERR_REVISION_MISMATCH" });
    assert.equal(loadTaskState(dir, "TASK-001").state, STATES.EXECUTING);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSnapshot refuses to overwrite a corrupted snapshot without force", () => {
  const dir = tmpDir();
  try {
    const s = reduce(null, makeEvent({ sequence: 1 })).state;
    writeSnapshot(dir, s, { expectedRevision: 0 });
    fs.writeFileSync(path.join(dir, "TASK-001.json"), "{broken");
    assert.throws(() => writeSnapshot(dir, s, { expectedRevision: 1 }), { key: "ERR_INVALID_STATE" });
    // force bypasses the corrupted check (recovery path)
    assert.doesNotThrow(() => writeSnapshot(dir, s, { force: true }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 10. Snapshot corruption detection + recovery ──────────────────────────

test("readSnapshot returns absent when no file exists", () => {
  const dir = tmpDir();
  try {
    const r = readSnapshot(dir, "NOPE");
    assert.equal(r.status, "absent");
    assert.equal(loadTaskState(dir, "NOPE"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot storage rejects task IDs that escape the tasks directory", () => {
  const dir = tmpDir();
  try {
    const state = reduce(null, makeEvent({ taskId: "../outside", sequence: 1 })).state;
    assert.throws(() => writeSnapshot(dir, state, { expectedRevision: 0 }), {
      key: "ERR_INVALID_STATE",
    });
    assert.equal(fs.existsSync(path.join(path.dirname(dir), "outside.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshot detects task identity mismatch even with valid integrity", () => {
  const dir = tmpDir();
  try {
    const state = reduce(null, makeEvent({ sequence: 1 })).state;
    const envelope = buildSnapshotEnvelope(state);
    envelope.taskId = "TASK-OTHER";
    fs.writeFileSync(path.join(dir, "TASK-001.json"), JSON.stringify(envelope));
    const result = readSnapshot(dir, "TASK-001");
    assert.equal(result.status, "corrupted");
    assert.equal(result.reason, "task-id-mismatch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption detected on JSON parse failure", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "T.json"), "{not json");
    const r = readSnapshot(dir, "T");
    assert.equal(r.status, "corrupted");
    assert.equal(r.reason, "json-parse-failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption detected on integrity hash mismatch (tampered payload)", () => {
  const dir = tmpDir();
  try {
    const s = reduce(null, makeEvent({ sequence: 1 })).state;
    writeSnapshot(dir, s, { expectedRevision: 0 });
    // tamper: change state without updating integrity
    const file = path.join(dir, "TASK-001.json");
    const env = JSON.parse(fs.readFileSync(file, "utf8"));
    env.payload.state = STATES.COMPLETED;
    fs.writeFileSync(file, JSON.stringify(env));
    const r = readSnapshot(dir, "TASK-001");
    assert.equal(r.status, "corrupted");
    assert.equal(r.reason, "integrity-mismatch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption detected on schema version mismatch", () => {
  const dir = tmpDir();
  try {
    const s = reduce(null, makeEvent({ sequence: 1 })).state;
    writeSnapshot(dir, s, { expectedRevision: 0 });
    const file = path.join(dir, "TASK-001.json");
    const env = JSON.parse(fs.readFileSync(file, "utf8"));
    env.schemaVersion = "9.9";
    env.payload.schemaVersion = "9.9";
    env.integrity = computeIntegrity(env.payload);
    fs.writeFileSync(file, JSON.stringify(env));
    const r = readSnapshot(dir, "TASK-001");
    assert.equal(r.status, "corrupted");
    assert.equal(r.reason, "schema-version-mismatch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption detected on envelope/payload revision mismatch", () => {
  const dir = tmpDir();
  try {
    const s = reduce(null, makeEvent({ sequence: 1 })).state;
    writeSnapshot(dir, s, { expectedRevision: 0 });
    const file = path.join(dir, "TASK-001.json");
    const env = JSON.parse(fs.readFileSync(file, "utf8"));
    env.revision = 99; // disagree with payload.revision (1)
    fs.writeFileSync(file, JSON.stringify(env));
    const r = readSnapshot(dir, "TASK-001");
    assert.equal(r.status, "corrupted");
    assert.equal(r.reason, "envelope-payload-revision-mismatch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadTaskState throws ERR_INVALID_STATE on corruption (caller recovers)", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "T.json"), "{broken");
    assert.throws(() => loadTaskState(dir, "T"), { key: "ERR_INVALID_STATE" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverSnapshot rebuilds a corrupted snapshot from journal events atomically", () => {
  const dir = tmpDir();
  try {
    const events = readyLifecycle();
    // seed a healthy snapshot, then corrupt it
    const { state } = replay(events);
    writeSnapshot(dir, state, { expectedRevision: 0 });
    fs.writeFileSync(path.join(dir, "TASK-001.json"), "{corrupted");
    // recovery
    const rec = recoverSnapshot(dir, "TASK-001", events);
    assert.equal(rec.recovered, true);
    assert.equal(rec.taskState.state, STATES.READY_FOR_REVIEW);
    assert.equal(rec.taskState.revision, 6);
    assert.equal(rec.audit.kind, "recovery-audit");
    assert.equal(rec.audit.reason, "json-parse-failed");
    assert.equal(rec.audit.recoveredRevision, 6);
    assert.equal(rec.audit.eventsReplayed, 6);
    assert.equal(rec.audit.appliedCount, 6);
    // snapshot is now healthy again
    const loaded = loadTaskState(dir, "TASK-001");
    assert.equal(loaded.state, STATES.READY_FOR_REVIEW);
    assert.equal(loaded.revision, 6);
    // integrity hash matches
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "TASK-001.json"), "utf8"));
    assert.equal(raw.integrity, computeIntegrity(raw.payload));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverSnapshot rebuilds an absent snapshot (cold cache)", () => {
  const dir = tmpDir();
  try {
    const events = readyLifecycle();
    const rec = recoverSnapshot(dir, "TASK-001", events);
    assert.equal(rec.recovered, true);
    assert.equal(rec.audit.reason, "absent");
    assert.equal(loadTaskState(dir, "TASK-001").state, STATES.READY_FOR_REVIEW);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverSnapshot is deterministic: same events -> identical rebuilt state", () => {
  const dir1 = tmpDir();
  const dir2 = tmpDir();
  try {
    const events = readyLifecycle();
    const a = recoverSnapshot(dir1, "TASK-001", events).taskState;
    const b = recoverSnapshot(dir2, "TASK-001", events).taskState;
    assert.deepEqual(a, b);
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test("recoverSnapshot is idempotent against duplicate events in the stream", () => {
  const dir = tmpDir();
  try {
    const events = readyLifecycle();
    const rec = recoverSnapshot(dir, "TASK-001", [...events, events[2]]);
    assert.equal(rec.taskState.revision, 6); // not 7
    assert.equal(rec.audit.duplicateCount, 1);
    assert.equal(rec.audit.appliedCount, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverSnapshot with a gapped event stream fails closed (no guessing)", () => {
  const dir = tmpDir();
  try {
    const events = readyLifecycle().slice(0, 3);
    const gap = makeEvent({
      eventId: "CE-G", eventType: "task.progress",
      previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING,
      sequence: 99, targets: [], timestamp: "2026-07-28T00:01:39.000Z",
    });
    assert.throws(() => recoverSnapshot(dir, "TASK-001", [...events, gap]), { key: "ERR_SEQUENCE_GAP" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverSnapshot with empty events throws (cannot rebuild, no guessing)", () => {
  const dir = tmpDir();
  try {
    assert.throws(() => recoverSnapshot(dir, "TASK-001", []), { key: "ERR_INVALID_STATE" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 11. Cross-cutting: CAS + dedupe + recovery end-to-end ─────────────────

test("end-to-end: load -> reduce -> CAS write -> reload matches reduce output", () => {
  const dir = tmpDir();
  try {
    const events = readyLifecycle();
    let state = null;
    let expectedRevision = 0;
    for (const e of events) {
      const loaded = loadTaskState(dir, "TASK-001");
      if (loaded) { state = loaded; expectedRevision = loaded.revision; }
      const r = reduce(state, e);
      state = r.state;
      writeSnapshot(dir, state, { expectedRevision });
      expectedRevision = state.revision;
    }
    const finalLoaded = loadTaskState(dir, "TASK-001");
    assert.equal(finalLoaded.state, STATES.READY_FOR_REVIEW);
    assert.equal(finalLoaded.revision, 6);
    assert.deepEqual(finalLoaded, state);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: corrupt after steady state, recover from event log, resume", () => {
  const dir = tmpDir();
  try {
    const events = readyLifecycle();
    // steady state
    let state = null;
    let expectedRevision = 0;
    for (const e of events) {
      const r = reduce(state, e);
      state = r.state;
      writeSnapshot(dir, state, { expectedRevision });
      expectedRevision = state.revision;
    }
    // corrupt the snapshot
    fs.writeFileSync(path.join(dir, "TASK-001.json"), "{corrupted");
    // recover from the full event log
    const rec = recoverSnapshot(dir, "TASK-001", events);
    assert.equal(rec.taskState.state, STATES.READY_FOR_REVIEW);
    // resume: apply a new event after recovery
    const next = makeEvent({
      eventId: "CE-7", eventType: "task.completed",
      previousState: STATES.READY_FOR_REVIEW, currentState: STATES.COMPLETED,
      sequence: 7, targets: [],
    });
    const r = reduce(rec.taskState, next);
    writeSnapshot(dir, r.state, { expectedRevision: rec.taskState.revision });
    assert.equal(loadTaskState(dir, "TASK-001").state, STATES.COMPLETED);
    assert.equal(loadTaskState(dir, "TASK-001").revision, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 12. Error code stability ──────────────────────────────────────────────

test("state/snapshot use stable coordination error codes from errors.js", () => {
  const codes = CODES;
  assert.equal(codes.ERR_SEQUENCE_GAP.code, 1005);
  assert.equal(codes.ERR_REVISION_MISMATCH.code, 1007);
  assert.equal(codes.ERR_INVALID_TRANSITION.code, 1001);
  assert.equal(codes.ERR_EVENT_NOT_LEGAL.code, 1019);
  assert.equal(codes.ERR_MISSING_EVIDENCE.code, 1017);
  assert.equal(codes.ERR_MISSING_REQUESTED_ACTION.code, 1018);
  assert.equal(codes.ERR_ABSENT_NO_EVENT.code, 1025);
  assert.equal(codes.ERR_COMPLETED_RUN_PHASE_PROTECTED.code, 1026);
  assert.equal(codes.ERR_INVALID_STATE.code, 1009);
});

test("CoordinationError thrown by reducer is the stable class", () => {
  const created = reduce(null, makeEvent({ sequence: 1 })).state;
  const bad = makeEvent({
    eventId: "CE-X", eventType: "task.progress",
    previousState: STATES.CREATED, currentState: STATES.EXECUTING, sequence: 2, targets: [],
  });
  try {
    reduce(created, bad);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof CoordinationError);
    assert.equal(err.name, "CoordinationError");
    assert.equal(typeof err.code, "number");
  }
});

// ─── 13. Zero third-party dependencies ─────────────────────────────────────

test("state.js and snapshot.js require only node builtins and local modules", () => {
  const stateSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "coordination", "state.js"), "utf8");
  const snapSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "coordination", "snapshot.js"), "utf8");
  const combined = stateSrc + "\n" + snapSrc;
  // no require("non-builtin") other than ./contract and ./errors
  const requires = [...combined.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  for (const r of requires) {
    const isBuiltin = r.startsWith("node:") || ["fs", "path", "crypto", "os", "assert", "util", "events", "stream", "buffer", "child_process"].includes(r);
    const isLocal = r.startsWith("./") || r.startsWith("../");
    assert.ok(isBuiltin || isLocal, `unexpected dependency: ${r}`);
  }
});
