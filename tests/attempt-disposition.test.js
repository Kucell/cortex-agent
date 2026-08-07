"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CoordinationApplicationService } = require("../../lib/coordination/application-service");
const { createEvent, STATES } = require("../../lib/coordination/contract");
const {
  ATTEMPT_DISPOSITIONS,
  ATTEMPT_DISPOSITION_SET,
  deriveAttemptDisposition,
  buildAttemptProjection,
} = require("../../lib/attempt-disposition");

test("attempt disposition vocabulary covers P-005 enumerations", () => {
  for (const expected of [
    "attempt_active",
    "attempt_review_ready",
    "attempt_attention_required",
    "attempt_closed",
    "attempt_inconsistent",
  ]) {
    assert.ok(ATTEMPT_DISPOSITION_SET.has(expected), `missing disposition ${expected}`);
  }
  assert.deepEqual(new Set(ATTEMPT_DISPOSITIONS), ATTEMPT_DISPOSITION_SET);
});

test("deriveAttemptDisposition returns attempt_active when lease + agent are alive", () => {
  const disposition = deriveAttemptDisposition({
    taskState: { state: STATES.ACCEPTED },
    leaseState: { active: true, released: false, stale: false, present: true },
    agentActivity: { active: true, observed: true },
    receiptCode: null,
  });
  assert.equal(disposition.disposition, "attempt_active");
  assert.equal(disposition.monitoringTerminal, false);
  assert.equal(disposition.notify, false);
  assert.equal(disposition.reconciliationRequired, false);
});

test("deriveAttemptDisposition returns attempt_attention_required when child exited and lease released", () => {
  const disposition = deriveAttemptDisposition({
    taskState: { state: STATES.BLOCKED },
    leaseState: { active: false, released: true, stale: false, present: true },
    agentActivity: { active: false, observed: true },
    receiptCode: "EXIT_ZERO",
  });
  assert.equal(disposition.disposition, "attempt_attention_required");
  assert.equal(disposition.monitoringTerminal, true);
  assert.equal(disposition.notify, true);
  assert.equal(disposition.reconciliationRequired, true);
});

test("deriveAttemptDisposition returns attempt_review_ready when Task is already READY_FOR_REVIEW", () => {
  const disposition = deriveAttemptDisposition({
    taskState: { state: STATES.READY_FOR_REVIEW },
    leaseState: { active: false, released: true, stale: false, present: true },
    agentActivity: { active: false, observed: true },
    receiptCode: "EXIT_ZERO",
    handoffRecorded: true,
  });
  assert.equal(disposition.disposition, "attempt_review_ready");
  assert.equal(disposition.monitoringTerminal, true);
  assert.equal(disposition.reconciliationRequired, false);
});

test("deriveAttemptDisposition returns attempt_closed when Task is COMPLETED", () => {
  const disposition = deriveAttemptDisposition({
    taskState: { state: STATES.COMPLETED },
    leaseState: { active: false, released: true, stale: false, present: true },
    agentActivity: { active: false, observed: true },
    reconciliationRecorded: true,
  });
  assert.equal(disposition.disposition, "attempt_closed");
  assert.equal(disposition.monitoringTerminal, true);
});

test("deriveAttemptDisposition returns attempt_inconsistent when lease is stale but Task is ACCEPTED", () => {
  const disposition = deriveAttemptDisposition({
    taskState: { state: STATES.ACCEPTED },
    leaseState: { active: false, released: false, stale: true, present: true },
    agentActivity: { active: true, observed: true },
  });
  assert.equal(disposition.disposition, "attempt_inconsistent");
  assert.equal(disposition.monitoringTerminal, true);
  assert.equal(disposition.reconciliationRequired, true);
});

test("deriveAttemptDisposition output never contains private launch context", () => {
  const disposition = deriveAttemptDisposition({
    taskState: { state: STATES.EXECUTING },
    leaseState: { active: true, released: false, stale: false, present: true },
    agentActivity: { active: true, observed: true },
  });
  const serialized = JSON.stringify(disposition);
  for (const forbidden of ["agentCommand", "agentArgs", "leaseId", "fencingToken", "sessionId", "contextFile", "prompt"]) {
    assert.ok(!serialized.includes(forbidden), `disposition must not contain ${forbidden}: ${serialized}`);
  }
});

test("buildAttemptProjection is read-only and idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-attempt-"));
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  try {
    const coordinator = { actorId: "coordinator", kind: "coordinator", sessionId: "root" };
    const agent = { actorId: "pi-attempt", kind: "agent", sessionId: "session-attempt" };
    const taskId = "T-ATTEMPT-1";
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: coordinator, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED, repository: { repositoryId: "attempt" } }), coordinator);
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: coordinator, targets: [{ actorId: agent.actorId, kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, repository: { repositoryId: "attempt" } }), coordinator);
    const lease = service.acquireOwnership(`task:${taskId}`, agent.actorId, { actorId: agent.sessionId, ttl: 60_000 });
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, repository: { repositoryId: "attempt" }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }), agent);

    const before = JSON.stringify(service.listEvents({ taskId }));
    const projection = buildAttemptProjection(service, taskId);
    const after = JSON.stringify(service.listEvents({ taskId }));
    assert.equal(before, after, "buildAttemptProjection must not mutate the journal");
    assert.equal(projection.ok, true);
    assert.equal(projection.taskState, STATES.ACCEPTED);
    assert.equal(projection.leaseState.present, true);
    assert.equal(projection.leaseState.active, true);
    assert.equal(projection.disposition, "attempt_active");
    assert.equal(projection.monitoringTerminal, false);

    const taskStatePath = path.join(runtimeCoord, "tasks", `${taskId}.json`);
    const beforeSnapshot = fs.statSync(taskStatePath).mtimeMs;
    buildAttemptProjection(service, taskId);
    const afterSnapshot = fs.statSync(taskStatePath).mtimeMs;
    assert.equal(beforeSnapshot, afterSnapshot, "projection must not rewrite the snapshot");
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildAttemptProjection reflects BLOCKED attention_required after lease release", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-attempt-"));
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  try {
    const coordinator = { actorId: "coordinator", kind: "coordinator", sessionId: "root" };
    const agent = { actorId: "pi-attention", kind: "agent", sessionId: "session-attention" };
    const taskId = "T-ATTEMPT-ATTENTION";
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: coordinator, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED, repository: { repositoryId: "attempt" } }), coordinator);
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: coordinator, targets: [{ actorId: agent.actorId, kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, repository: { repositoryId: "attempt" } }), coordinator);
    const lease = service.acquireOwnership(`task:${taskId}`, agent.actorId, { actorId: agent.sessionId, ttl: 60_000 });
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, repository: { repositoryId: "attempt" }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }), agent);
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.blocked", previousState: STATES.ACCEPTED, currentState: STATES.BLOCKED, repository: { repositoryId: "attempt" }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }), agent);
    service.releaseOwnership(lease.leaseId, { actorId: agent.sessionId });
    const projection = buildAttemptProjection(service, taskId);
    assert.equal(projection.disposition, "attempt_attention_required");
    assert.equal(projection.monitoringTerminal, true);
    assert.equal(projection.reconciliationRequired, true);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("historical testing does not close a later BLOCKED attempt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-attempt-"));
  const service = CoordinationApplicationService.open(
    path.join(root, ".agent-runtime", "coordination"),
    { journal: { lock: false } },
  );
  try {
    const coordinator = { actorId: "coordinator", kind: "coordinator", sessionId: "root" };
    const agent = { actorId: "pi-history", kind: "agent", sessionId: "session-history" };
    const taskId = "T-ATTEMPT-HISTORY";
    const common = { projectId: "attempt", taskId, correlationId: "C", repository: { repositoryId: "attempt" } };
    service.submit(createEvent({ ...common, producer: coordinator, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED }), coordinator);
    service.submit(createEvent({ ...common, producer: coordinator, targets: [{ actorId: agent.actorId, kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED }), coordinator);
    const lease = service.acquireOwnership(`task:${taskId}`, agent.actorId, { actorId: agent.sessionId, ttl: 60_000 });
    const ownership = [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }];
    service.submit(createEvent({ ...common, producer: agent, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, fileOwnership: ownership }), agent);
    service.submit(createEvent({ ...common, producer: agent, targets: [], eventType: "task.progress", previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING, fileOwnership: ownership }), agent);
    service.submit(createEvent({ ...common, producer: agent, targets: [], eventType: "task.testing", previousState: STATES.EXECUTING, currentState: STATES.TESTING, fileOwnership: ownership }), agent);
    service.submit(createEvent({ ...common, producer: agent, targets: [], eventType: "task.blocked", previousState: STATES.TESTING, currentState: STATES.BLOCKED, fileOwnership: ownership }), agent);
    service.submit(createEvent({ ...common, producer: agent, targets: [], eventType: "ownership.released", previousState: STATES.BLOCKED, currentState: STATES.BLOCKED }), agent);
    service.releaseOwnership(lease.leaseId, { actorId: agent.sessionId });

    const projection = buildAttemptProjection(service, taskId, { clock: () => "2026-08-04T00:00:00.000Z" });
    assert.equal(projection.disposition, "attempt_attention_required");
    assert.equal(projection.reconciliationRecorded, false);
    assert.equal(projection.monitoringTerminal, true);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildAttemptProjection returns attempt_review_ready when Task is READY_FOR_REVIEW", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-attempt-"));
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  try {
    const coordinator = { actorId: "coordinator", kind: "coordinator", sessionId: "root" };
    const agent = { actorId: "pi-review", kind: "agent", sessionId: "session-review" };
    const taskId = "T-ATTEMPT-REVIEW";
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: coordinator, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED, repository: { repositoryId: "attempt" } }), coordinator);
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: coordinator, targets: [{ actorId: agent.actorId, kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, repository: { repositoryId: "attempt" } }), coordinator);
    const lease = service.acquireOwnership(`task:${taskId}`, agent.actorId, { actorId: agent.sessionId, ttl: 60_000 });
    const ownership = [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }];
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, repository: { repositoryId: "attempt" }, fileOwnership: ownership }), agent);
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.progress", previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING, repository: { repositoryId: "attempt" }, fileOwnership: ownership }), agent);
    service.submit(createEvent({ projectId: "attempt", taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.ready_for_review", previousState: STATES.EXECUTING, currentState: STATES.READY_FOR_REVIEW, repository: { repositoryId: "attempt" }, fileOwnership: ownership, evidence: [{ kind: "artifact", ref: "ART-REVIEW-1" }] }), agent);
    const projection = buildAttemptProjection(service, taskId);
    assert.equal(projection.disposition, "attempt_review_ready");
    assert.equal(projection.monitoringTerminal, true);
    assert.equal(projection.reconciliationRequired, false);
    assert.equal(projection.handoffRecorded, true);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildAttemptProjection rejects invalid taskId", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-attempt-"));
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  try {
    assert.equal(buildAttemptProjection(service, "").ok, false);
    assert.equal(buildAttemptProjection(service, "T-DOES-NOT-EXIST").ok, false);
    assert.equal(buildAttemptProjection(null, "T-X").ok, false);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
