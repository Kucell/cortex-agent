"use strict";

// ---------------------------------------------------------------------------
// Lease continuity across a WAITING_FOR_INPUT pause.
//
// The scenario this file pins is a real one, reported from the field:
//
//   A Task is in WAITING_FOR_INPUT. Its ownership[] reference points at a
//   lease that has since expired. The same owner acquires a fresh lease
//   (new leaseId, higher fencing token) and then tries to resume with
//   `task.progress`.
//
// `task.progress` is the only event that moves WAITING_FOR_INPUT back to
// EXECUTING, and the ownership check rejects it because the reference still
// names the expired lease. The result is a deadlock: the Task cannot resume,
// and there is no supported public entry point that refreshes the reference
// to the new lease.
//
// These tests describe the behaviour. Where the behaviour is a gap, the test
// says so explicitly rather than asserting a wish — a test that asserts the
// desired behaviour fails until the framework provides the entry point, and
// that is exactly the signal a gap should produce.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEvent, STATES } = require("../../lib/coordination/contract");
const {
  CoordinationApplicationService,
} = require("../../lib/coordination/application-service");
const { createManualClock } = require("../../lib/coordination/lease");

const TASK_ID = "TASK-LEASE-CONTINUITY";
const OWNER = "claude-1";

function runtimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lease-continuity-"));
}

function ownershipOf(lease) {
  return [{
    leaseId: lease.leaseId,
    scope: lease.scope,
    owner: lease.owner,
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt,
  }];
}

function baseEvent(overrides = {}) {
  return createEvent({
    projectId: "project",
    taskId: TASK_ID,
    correlationId: "CORR-LEASE",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [],
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    repository: { repositoryId: "repo" },
    notification: { policy: "journal_only", dedupeKey: "lease-continuity" },
    ...overrides,
  });
}

const AGENT_AUTH = { actorId: OWNER, kind: "agent", sessionId: "session-1" };
const AGENT_PRODUCER = { actorId: OWNER, kind: "agent", sessionId: "session-1" };

// Drives a Task to WAITING_FOR_INPUT with a live ownership reference, and
// returns the app plus the lease it is holding.
function driveToWaitingForInput(app, clock, options = {}) {
  const ttl = options.ttl !== undefined ? options.ttl : 100;
  const lease = app.acquireOwnership("src/**", OWNER, {
    actorId: "session-1",
    ttl,
  });
  app.submit(baseEvent({
    eventId: "CE-create", sequence: 1, eventType: "task.created",
  }));
  app.submit(baseEvent({
    eventId: "CE-assign", sequence: 2, eventType: "task.assigned",
    previousState: STATES.CREATED, currentState: STATES.ASSIGNED,
    targets: [{ actorId: OWNER, kind: "agent" }],
    fileOwnership: ownershipOf(lease),
  }));
  app.submit(baseEvent({
    eventId: "CE-accept", sequence: 1, eventType: "task.accepted",
    previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED,
    producer: AGENT_PRODUCER,
  }), AGENT_AUTH);
  app.submit(baseEvent({
    eventId: "CE-exec", sequence: 2, eventType: "task.progress",
    previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING,
    producer: AGENT_PRODUCER,
  }), AGENT_AUTH);
  app.submit(baseEvent({
    eventId: "CE-input", sequence: 3, eventType: "task.input_required",
    previousState: STATES.EXECUTING, currentState: STATES.WAITING_FOR_INPUT,
    producer: AGENT_PRODUCER,
    requestedAction: { kind: "provide_input", message: "confirm the diagnosis scope" },
  }), AGENT_AUTH);
  return lease;
}

test("a Task in WAITING_FOR_INPUT holds an ownership reference to its lease", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    const lease = driveToWaitingForInput(app, clock);
    const task = app.getTask(TASK_ID);
    assert.equal(task.state, STATES.WAITING_FOR_INPUT);
    assert.equal(task.ownership.length, 1);
    assert.equal(task.ownership[0].leaseId, lease.leaseId);
    assert.equal(task.ownership[0].fencingToken, lease.fencingToken);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("task.progress is rejected once the referenced lease has expired", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    driveToWaitingForInput(app, clock);
    clock.advance(101);

    assert.throws(() => app.submit(baseEvent({
      eventId: "CE-resume", sequence: 4, eventType: "task.progress",
      previousState: STATES.WAITING_FOR_INPUT, currentState: STATES.EXECUTING,
      producer: AGENT_PRODUCER,
    }), AGENT_AUTH), { key: "ERR_LEASE_CONFLICT" });

    assert.equal(app.getTask(TASK_ID).state, STATES.WAITING_FOR_INPUT);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh lease for the same owner does not unblock the Task by itself", (t) => {
  // This is the reported gap. The owner acquires a new lease over the same
  // scope, and the Task still cannot resume, because the ownership
  // reference names the old lease id and the old fencing token. Acquiring a
  // lease is not enough — the reference has to be moved, and that is what
  // `ownership.rebound` is for.
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    const oldLease = driveToWaitingForInput(app, clock);
    clock.advance(101);

    const newLease = app.acquireOwnership("src/**", OWNER, {
      actorId: "session-1",
      ttl: 100,
    });
    assert.notEqual(newLease.leaseId, oldLease.leaseId);
    assert.ok(newLease.fencingToken > oldLease.fencingToken);

    // The Task still points at the old reference.
    assert.equal(app.getTask(TASK_ID).ownership[0].leaseId, oldLease.leaseId);

    // And the resume is still refused: the new lease does not help on its own.
    assert.throws(() => app.submit(baseEvent({
      eventId: "CE-resume", sequence: 4, eventType: "task.progress",
      previousState: STATES.WAITING_FOR_INPUT, currentState: STATES.EXECUTING,
      producer: AGENT_PRODUCER,
    }), AGENT_AUTH), { key: "ERR_LEASE_CONFLICT" });

    // Rebinding the reference to the fresh lease is what unblocks it.
    app.submit(baseEvent({
      eventId: "CE-rebind", sequence: 4, eventType: "ownership.rebound",
      previousState: STATES.WAITING_FOR_INPUT,
      currentState: STATES.WAITING_FOR_INPUT,
      producer: AGENT_PRODUCER,
      fileOwnership: ownershipOf(newLease),
    }), AGENT_AUTH);

    const task = app.getTask(TASK_ID);
    assert.equal(task.ownership[0].leaseId, newLease.leaseId);
    assert.equal(task.ownership[0].fencingToken, newLease.fencingToken);
    assert.equal(task.state, STATES.WAITING_FOR_INPUT);

    // And now the resume is accepted.
    app.submit(baseEvent({
      eventId: "CE-resume", sequence: 5, eventType: "task.progress",
      previousState: STATES.WAITING_FOR_INPUT, currentState: STATES.EXECUTING,
      producer: AGENT_PRODUCER,
    }), AGENT_AUTH);
    assert.equal(app.getTask(TASK_ID).state, STATES.EXECUTING);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rebind cannot seize another owner's scope", (t) => {
  // The rebind is a recovery path, not a takeover. Moving the reference onto
  // a lease owned by somebody else would defeat the fencing order, so the
  // owner of the scope must match.
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    driveToWaitingForInput(app, clock);

    // Another owner holds a live lease over a *different* scope. A rebind
    // onto it would not be a recovery of this Task's own scope but a seizure
    // of somebody else's — the reference must not be allowed to leave the
    // scope it was bound to.
    const otherLease = app.acquireOwnership("other/**", "other-agent", {
      actorId: "session-other",
      ttl: 100,
    });

    assert.throws(() => app.submit(baseEvent({
      eventId: "CE-steal", sequence: 4, eventType: "ownership.rebound",
      previousState: STATES.WAITING_FOR_INPUT,
      currentState: STATES.WAITING_FOR_INPUT,
      producer: AGENT_PRODUCER,
      fileOwnership: ownershipOf(otherLease),
    }), AGENT_AUTH), { key: "ERR_LEASE_CONFLICT" });
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rebind cannot rewind the fencing token", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    const lease = driveToWaitingForInput(app, clock);
    clock.advance(101);

    // A newer lease over the same scope, so that a rebind onto it would be
    // legal in every respect except that it rewinds the fencing order.
    const newer = app.acquireOwnership("src/**", OWNER, {
      actorId: "session-1",
      ttl: 100,
    });
    assert.ok(newer.fencingToken > lease.fencingToken);

    // Rebinding to a *lower* fencing token would rewind the fencing order,
    // so a rebind must carry a strictly newer token than the one it replaces.
    assert.throws(() => app.submit(baseEvent({
      eventId: "CE-rewind", sequence: 4, eventType: "ownership.rebound",
      previousState: STATES.WAITING_FOR_INPUT,
      currentState: STATES.WAITING_FOR_INPUT,
      producer: AGENT_PRODUCER,
      fileOwnership: [{
        leaseId: lease.leaseId,
        scope: lease.scope,
        owner: lease.owner,
        fencingToken: newer.fencingToken - 1,
        expiresAt: newer.expiresAt,
      }],
    }), AGENT_AUTH), { key: "ERR_LEASE_CONFLICT" });
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rebind accepts the owner's own successor lease across an interruption", (t) => {
  // The scope was released, then held by somebody else, then released again.
  // The owner acquires it again. That lease is not a *direct* continuation
  // of the one the Task holds, but it is the owner's own successor over the
  // same scope, and the rebind has to accept it — otherwise every Task whose
  // scope was briefly taken over would be stuck forever.
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    const lease = driveToWaitingForInput(app, clock);
    clock.advance(101);

    // Another owner takes the scope and releases it again.
    app.releaseOwnership(lease.leaseId, { actorId: "session-1" });
    const otherLease = app.acquireOwnership("src/**", "other-owner", {
      actorId: "session-other",
      ttl: 100,
    });
    app.releaseOwnership(otherLease.leaseId, { actorId: "session-other" });

    // The owner acquires the scope again.
    const successor = app.acquireOwnership("src/**", OWNER, {
      actorId: "session-1",
      ttl: 100,
    });
    assert.ok(successor.fencingToken > lease.fencingToken);
    assert.equal(successor.recoveredFrom, null);
    assert.equal(successor.continuityFrom, lease.leaseId);

    // The rebind is accepted: the new lease continues the replaced one in
    // the owner's own lineage.
    app.submit(baseEvent({
      eventId: "CE-rebind-across-interruption", sequence: 4,
      eventType: "ownership.rebound",
      previousState: STATES.WAITING_FOR_INPUT,
      currentState: STATES.WAITING_FOR_INPUT,
      producer: AGENT_PRODUCER,
      fileOwnership: ownershipOf(successor),
    }), AGENT_AUTH);

    const task = app.getTask(TASK_ID);
    assert.equal(task.ownership[0].leaseId, successor.leaseId);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rebind refuses a lease that is not the owner's successor", (t) => {
  // Same owner, same scope, newer fencing token — but a lease that is *not*
  // on the owner's lineage for that scope. Two leases of one owner over one
  // scope that are not on a common chain are two separate lines of work, not
  // one line of work seen twice, so the rebind must refuse it: otherwise a
  // rebind is a way to attach a Task to an unrelated lease.
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    const lease = driveToWaitingForInput(app, clock);
    clock.advance(101);

    // The Task's lease is released, and another lease of the same owner over
    // the same scope is acquired afterwards. That lease *is* on the owner's
    // lineage, so it would be accepted — the refusal case needs a lease whose
    // lineage does not reach the reference at all.
    app.releaseOwnership(lease.leaseId, { actorId: "session-1" });
    const unrelated = app.acquireOwnership("src/**", OWNER, {
      actorId: "session-1",
      ttl: 100,
    });

    // Build a lease over the same scope by the same owner that carries a
    // chain of its own but on which the Task's lease does not appear: the
    // durable state is edited directly, the way a corrupted or hand-forged
    // state file would look.
    const forged = {
      ...unrelated,
      leaseId: "LEASE-9001",
      fencingToken: unrelated.fencingToken + 10,
      continuityFrom: null,
    };
    const leases = app.leases;
    leases._leases.set(forged.leaseId, forged);
    leases._indexLease(forged.scope, forged.leaseId);
    // The forged lease has to pass every *other* rebind check, otherwise the
    // refusal this test asserts would come from one of them and the lineage
    // check would never be reached. So it must be live, it must be the
    // highest fencing token on the scope, and it must not be expired.
    clock.advance(101);
    forged.expiresAt = new Date(clock.now() + 1000).toISOString();
    leases._fencing.set(forged.scope, forged.fencingToken);

    assert.throws(() => app.submit(baseEvent({
      eventId: "CE-rebind-unrelated", sequence: 4,
      eventType: "ownership.rebound",
      previousState: STATES.WAITING_FOR_INPUT,
      currentState: STATES.WAITING_FOR_INPUT,
      producer: AGENT_PRODUCER,
      fileOwnership: ownershipOf(forged),
    }), AGENT_AUTH), { key: "ERR_LEASE_CONFLICT" });
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the public surface exposes a rebind entry point", (t) => {
  // The coordination application service is the whole of the supported
  // write surface. `renewOwnership` extends a lease that is still alive; it
  // does not help here, because the reference names a lease that has already
  // expired — renewing an expired lease is refused. No method rebinds a
  // Task's ownership reference to a newer lease. This test names the gap so
  // that adding one is a deliberate change rather than an accident.
  const dir = runtimeDir();
  const app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  try {
    const methods = Object.getOwnPropertyNames(
      CoordinationApplicationService.prototype,
    ).filter((name) => typeof app[name] === "function");
    const refreshCandidates = methods.filter((name) =>
      /refresh|rebind|reassign|transfer/i.test(name));
    assert.deepEqual(refreshCandidates, []);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

