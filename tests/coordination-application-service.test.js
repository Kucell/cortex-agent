"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEvent, STATES } = require("../lib/coordination/contract");
const {
  CoordinationApplicationService,
} = require("../lib/coordination/application-service");

function runtimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-app-"));
}

function event(overrides = {}) {
  return createEvent({
    eventId: overrides.eventId,
    projectId: "project",
    taskId: "TASK-APP",
    correlationId: "CORR-APP",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    sequence: overrides.sequence,
    repository: { repositoryId: "repo" },
    notification: { policy: "journal_only", dedupeKey: "app" },
    ...overrides,
  });
}

test("serializes validation, journal append and snapshot update", () => {
  const dir = runtimeDir();
  const app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  try {
    const created = app.submit(event({ eventId: "CE-create", sequence: null }));
    assert.equal(created.task.state, STATES.CREATED);
    assert.equal(created.task.revision, 1);
    assert.equal(app.listEvents().length, 1);
    assert.equal(app.getTask("TASK-APP").lastEventId, "CE-create");
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supports producer-local sequences across coordinator and assignee", () => {
  const dir = runtimeDir();
  const app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  try {
    app.submit(event({ eventId: "CE-create", sequence: 1 }));
    app.submit(event({
      eventId: "CE-assign", sequence: 2, eventType: "task.assigned",
      previousState: STATES.CREATED, currentState: STATES.ASSIGNED,
      targets: [{ actorId: "claude-1", kind: "agent" }],
    }));
    app.submit(event({
      eventId: "CE-accept", sequence: 1, eventType: "task.accepted",
      previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED,
      producer: { actorId: "claude-1", kind: "agent" },
    }));
    const task = app.getTask("TASK-APP");
    assert.equal(task.state, STATES.ACCEPTED);
    assert.equal(task.revision, 3);
    assert.deepEqual(task.producerSequences, { coordinator: 2, "claude-1": 1 });
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects unauthorized completion without journaling it", () => {
  const dir = runtimeDir();
  const app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  try {
    app.submit(event({ eventId: "CE-create", sequence: 1 }));
    assert.throws(() => app.submit(event({
      eventId: "CE-bad", sequence: 1, eventType: "task.completed",
      previousState: STATES.CREATED, currentState: STATES.COMPLETED,
      producer: { actorId: "worker", kind: "agent" },
    })), { key: "ERR_ACTOR_MISMATCH" });
    assert.equal(app.listEvents().length, 1);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate eventId is idempotent after restart", () => {
  const dir = runtimeDir();
  const first = event({ eventId: "CE-create", sequence: 1 });
  let app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  app.submit(first);
  app.close();
  app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  try {
    const duplicate = app.submit(first);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.task.revision, 1);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repairs a missing snapshot from the authoritative journal", () => {
  const dir = runtimeDir();
  let app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  app.submit(event({ eventId: "CE-create", sequence: 1 }));
  app.close();
  fs.unlinkSync(path.join(dir, "tasks", "TASK-APP.json"));

  app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  try {
    assert.equal(app.getTask("TASK-APP").revision, 1);
    assert.equal(fs.existsSync(path.join(dir, "tasks", "TASK-APP.json")), true);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persists fencing and pending takeover state across restart", () => {
  const dir = runtimeDir();
  let app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  const lease = app.acquireOwnership("lib/coordination/**", "claude-1", {
    actorId: "session-1",
    ttl: 1_000,
  });
  const request = app.requestOwnershipTakeover("lib/coordination/**", "codex", {
    actorId: "coordinator",
    evidence: "operation:stop-requested",
  });
  app.close();

  app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  try {
    assert.equal(app.leases.getLease(lease.leaseId).owner, "claude-1");
    assert.equal(app.leases.getTakeoverRequest(request.requestId).status, "pending");
    const completed = app.completeOwnershipTakeover(request.requestId, {
      actorId: "coordinator",
      recoveryEvidence: "operation:process-exited",
    });
    assert.ok(completed.lease.fencingToken > lease.fencingToken);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed when durable lease state is corrupted", () => {
  const dir = runtimeDir();
  let app = CoordinationApplicationService.open(dir, { journal: { lock: false } });
  app.acquireOwnership("src/**", "agent");
  app.close();
  fs.writeFileSync(path.join(dir, "leases", "state.json"), "{broken");
  assert.throws(
    () => CoordinationApplicationService.open(dir, { journal: { lock: false } }),
    { key: "ERR_INVALID_STATE" }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
