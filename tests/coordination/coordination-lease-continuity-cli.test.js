"use strict";

// ---------------------------------------------------------------------------
// The public CLI path for lease continuity.
//
// The reported gap was not only that the framework lacked the capability —
// it was that there was no *supported public entry point* to use it. These
// tests drive the same sequence an operator would type:
//
//   cortex-agent task rebind-ownership --task T-1 --lease-id LEASE-339 \
//     --actor claude-1 --session session-1
//
// and then resume the Task with `task progress`.
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
const { executeCoordinationCommand } = require("../../lib/coordination/cli");

const TASK_ID = "TASK-CLI-CONTINUITY";
const OWNER = "claude-1";
const SESSION = "session-1";

function runtimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lease-cli-"));
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
    correlationId: "CORR-CLI",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [],
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    repository: { repositoryId: "repo" },
    notification: { policy: "journal_only", dedupeKey: "cli-continuity" },
    ...overrides,
  });
}

const AGENT_AUTH = { actorId: OWNER, kind: "agent", sessionId: SESSION };
const AGENT_PRODUCER = { actorId: OWNER, kind: "agent", sessionId: SESSION };

function driveToWaitingForInput(app) {
  const lease = app.acquireOwnership("src/**", OWNER, {
    actorId: SESSION,
    ttl: 100,
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
    requestedAction: { kind: "provide_input", message: "confirm the scope" },
  }), AGENT_AUTH);
  return lease;
}

test("task rebind-ownership moves the reference and unblocks the resume", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    const oldLease = driveToWaitingForInput(app);
    clock.advance(101);
    const newLease = app.acquireOwnership("src/**", OWNER, {
      actorId: SESSION,
      ttl: 100,
    });

    const rebound = executeCoordinationCommand([
      "task", "rebind-ownership",
      "--task", TASK_ID,
      "--lease-id", newLease.leaseId,
      "--actor", OWNER,
      "--session", SESSION,
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(rebound.ok, true, JSON.stringify(rebound.error || {}));

    const task = app.getTask(TASK_ID);
    assert.equal(task.ownership[0].leaseId, newLease.leaseId);
    assert.notEqual(task.ownership[0].leaseId, oldLease.leaseId);
    assert.equal(task.state, STATES.WAITING_FOR_INPUT);

    // The resume that was previously refused now succeeds.
    const resumed = executeCoordinationCommand([
      "task", "progress",
      "--event-json", JSON.stringify({
        schemaVersion: "1.0",
        eventId: "CE-resume",
        projectId: "project",
        taskId: TASK_ID,
        correlationId: "CORR-CLI",
        eventType: "task.progress",
        targets: [],
        previousState: STATES.WAITING_FOR_INPUT,
        currentState: STATES.EXECUTING,
        producer: AGENT_PRODUCER,
        timestamp: "2026-07-28T00:00:10.000Z",
        sequence: 5,
        repository: { repositoryId: "repo" },
        notification: { policy: "journal_only", dedupeKey: "cli-resume" },
      }),
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error || {}));
    assert.equal(app.getTask(TASK_ID).state, STATES.EXECUTING);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("task rebind-ownership rejects an unknown lease", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    driveToWaitingForInput(app);
    const result = executeCoordinationCommand([
      "task", "rebind-ownership",
      "--task", TASK_ID,
      "--lease-id", "LEASE-does-not-exist",
      "--actor", OWNER,
      "--session", SESSION,
    ], { service: app });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "LEASE_NOT_FOUND");
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("task rebind-ownership requires the full flag set", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    driveToWaitingForInput(app);
    const result = executeCoordinationCommand([
      "task", "rebind-ownership", "--task", TASK_ID,
    ], { service: app });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_USAGE");
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("task rebind-ownership refuses a lease owned by somebody else", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    driveToWaitingForInput(app);
    const otherLease = app.acquireOwnership("other/**", "other-agent", {
      actorId: "session-other",
      ttl: 100,
    });
    const result = executeCoordinationCommand([
      "task", "rebind-ownership",
      "--task", TASK_ID,
      "--lease-id", otherLease.leaseId,
      "--actor", OWNER,
      "--session", SESSION,
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ERR_LEASE_CONFLICT");
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The scope is the anchor of a rebind.
//
// A rebind refreshes a reference the task already holds. It is not a way to
// exchange one scope for another: the fencing order of the scope being
// acquired would never be compared with the scope being released, and the
// task could shed a scope it was still bound by.
// ---------------------------------------------------------------------------

test("task rebind-ownership refuses to move the task onto another scope", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    driveToWaitingForInput(app);
    clock.advance(101);
    // A lease over a scope the task never held, acquired by the same owner.
    const otherScopeLease = app.acquireOwnership("other/**", OWNER, {
      actorId: SESSION,
      ttl: 100,
    });
    const result = executeCoordinationCommand([
      "task", "rebind-ownership",
      "--task", TASK_ID,
      "--lease-id", otherScopeLease.leaseId,
      "--actor", OWNER,
      "--session", SESSION,
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ERR_LEASE_CONFLICT");
    // The task keeps pointing at the scope it held.
    const task = app.getTask(TASK_ID);
    assert.equal(task.ownership.length, 1);
    assert.equal(task.ownership[0].scope, "src/**");
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rebound event cannot carry forged reference metadata", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    driveToWaitingForInput(app);
    clock.advance(101);
    const newLease = app.acquireOwnership("src/**", OWNER, {
      actorId: SESSION,
      ttl: 100,
    });
    // A hand-crafted event naming a real lease and its real fencing token,
    // but claiming a scope and an owner the lease does not have.
    assert.throws(() => app.submit(baseEvent({
      eventId: "CE-rebound-forged", sequence: 4, eventType: "ownership.rebound",
      previousState: STATES.WAITING_FOR_INPUT, currentState: STATES.WAITING_FOR_INPUT,
      producer: AGENT_PRODUCER,
      fileOwnership: [{
        leaseId: newLease.leaseId,
        scope: "forged/**",
        owner: "forged-owner",
        fencingToken: newLease.fencingToken,
        expiresAt: newLease.expiresAt,
      }],
    }), AGENT_AUTH), (error) => {
      assert.equal(error.key, "ERR_LEASE_CONFLICT");
      return true;
    });
    const task = app.getTask(TASK_ID);
    assert.equal(task.ownership[0].scope, "src/**");
    assert.equal(task.ownership[0].owner, OWNER);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rebinding one scope keeps the task's other scopes in force", (t) => {
  const dir = runtimeDir();
  const clock = createManualClock(Date.parse("2026-07-28T00:00:00.000Z"));
  const app = CoordinationApplicationService.open(dir, {
    journal: { lock: false }, clock,
  });
  try {
    const srcLease = app.acquireOwnership("src/**", OWNER, {
      actorId: SESSION,
      ttl: 100,
    });
    const configLease = app.acquireOwnership("config/**", OWNER, {
      actorId: SESSION,
      ttl: 100,
    });
    app.submit(baseEvent({
      eventId: "CE-create", sequence: 1, eventType: "task.created",
    }));
    app.submit(baseEvent({
      eventId: "CE-assign", sequence: 2, eventType: "task.assigned",
      previousState: STATES.CREATED, currentState: STATES.ASSIGNED,
      targets: [{ actorId: OWNER, kind: "agent" }],
      fileOwnership: ownershipOf(srcLease).concat(ownershipOf(configLease)),
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
      requestedAction: { kind: "provide_input", message: "confirm the scope" },
    }), AGENT_AUTH);

    clock.advance(101);
    // Only src/** is renewed. config/** is still expired, so the task must
    // keep refusing to resume until that scope is rebound as well.
    const newSrcLease = app.acquireOwnership("src/**", OWNER, {
      actorId: SESSION,
      ttl: 100,
    });
    const rebound = executeCoordinationCommand([
      "task", "rebind-ownership",
      "--task", TASK_ID,
      "--lease-id", newSrcLease.leaseId,
      "--actor", OWNER,
      "--session", SESSION,
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(rebound.ok, true, JSON.stringify(rebound.error || {}));

    // The other scope is still there — it was not silently dropped.
    const task = app.getTask(TASK_ID);
    assert.equal(task.ownership.length, 2);
    const scopes = task.ownership.map((entry) => entry.scope).sort();
    assert.deepEqual(scopes, ["config/**", "src/**"]);

    // And because config/** is still expired, the resume stays refused.
    const resumed = executeCoordinationCommand([
      "task", "progress",
      "--event-json", JSON.stringify({
        schemaVersion: "1.0",
        eventId: "CE-resume-partial",
        projectId: "project",
        taskId: TASK_ID,
        correlationId: "CORR-CLI",
        eventType: "task.progress",
        targets: [],
        previousState: STATES.WAITING_FOR_INPUT,
        currentState: STATES.EXECUTING,
        producer: AGENT_PRODUCER,
        timestamp: "2026-07-28T00:00:20.000Z",
        sequence: 5,
        repository: { repositoryId: "repo" },
        notification: { policy: "journal_only", dedupeKey: "cli-resume-partial" },
      }),
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(resumed.ok, false);
    assert.equal(resumed.error.code, "ERR_LEASE_CONFLICT");

    // Restoring the second scope as well unblocks the task. The src scope is
    // already rebound, so it is not named again — a rebind requires a
    // strictly newer fencing token than the reference it replaces.
    const newConfigLease = app.acquireOwnership("config/**", OWNER, {
      actorId: SESSION,
      ttl: 100,
    });
    const reboundBoth = executeCoordinationCommand([
      "task", "rebind-ownership",
      "--task", TASK_ID,
      "--lease-id", newConfigLease.leaseId,
      "--actor", OWNER,
      "--session", SESSION,
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(reboundBoth.ok, true, JSON.stringify(reboundBoth.error || {}));

    const resumedBoth = executeCoordinationCommand([
      "task", "progress",
      "--event-json", JSON.stringify({
        schemaVersion: "1.0",
        eventId: "CE-resume-both",
        projectId: "project",
        taskId: TASK_ID,
        correlationId: "CORR-CLI",
        eventType: "task.progress",
        targets: [],
        previousState: STATES.WAITING_FOR_INPUT,
        currentState: STATES.EXECUTING,
        producer: AGENT_PRODUCER,
        timestamp: "2026-07-28T00:00:30.000Z",
        sequence: 6,
        repository: { repositoryId: "repo" },
        notification: { policy: "journal_only", dedupeKey: "cli-resume-both" },
      }),
      "--auth-context-json", JSON.stringify(AGENT_AUTH),
    ], { service: app });
    assert.equal(resumedBoth.ok, true, JSON.stringify(resumedBoth.error || {}));
    assert.equal(app.getTask(TASK_ID).state, STATES.EXECUTING);
  } finally {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

