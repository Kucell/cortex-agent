"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const { createEvent, STATES } = require("../lib/coordination/contract");
const { reconcileGovernedLaunch } = require("../lib/governed-launch-reconciler");

test("reconciler idempotently finalizes a ghost accepted task and releases its lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-reconcile-"));
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-reconcile-private-"));
  const service = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"), { journal: { lock: false } });
  const coordinator = { actorId: "coordinator", kind: "coordinator", sessionId: "root" };
  const agent = { actorId: "pi-reconcile", kind: "agent", sessionId: "session-pi-reconcile" };
  const taskId = "T-RECONCILE-GHOST";
  try {
    service.submit(createEvent({ projectId: "reconcile", taskId, correlationId: "CORR-R", producer: coordinator, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED, repository: { repositoryId: "reconcile" } }), coordinator);
    service.submit(createEvent({ projectId: "reconcile", taskId, correlationId: "CORR-R", producer: coordinator, targets: [{ actorId: agent.actorId, kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, repository: { repositoryId: "reconcile" } }), coordinator);
    const lease = service.acquireOwnership(`task:${taskId}`, agent.actorId, { actorId: agent.sessionId, ttl: 60_000 });
    service.submit(createEvent({ projectId: "reconcile", taskId, correlationId: "CORR-R", producer: agent, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, repository: { repositoryId: "reconcile" }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }), agent);
    const contextFile = path.join(privateDir, "context.json");
    const receiptFile = path.join(privateDir, "child-receipt.json");
    fs.writeFileSync(contextFile, JSON.stringify({ taskId, projectId: "reconcile", coordinatorId: coordinator.actorId, targetAgentId: agent.actorId, launchId: "LAUNCH-RECONCILE", leaseId: lease.leaseId, fencingToken: lease.fencingToken, producer: agent, repository: { repositoryId: "reconcile", worktreeId: root } }), { mode: 0o600 });
    fs.writeFileSync(receiptFile, JSON.stringify({ phase: "pending_finalization", code: "EXIT_ABNORMAL", outcome: "SERVICE_UNAVAILABLE", serviceErrorCode: "COORDINATION_BUSY" }), { mode: 0o600 });
    const first = reconcileGovernedLaunch(service, { contextFile, receiptFile });
    const second = reconcileGovernedLaunch(service, { contextFile, receiptFile });
    assert.equal(first.ok, true);
    assert.equal(first.outcome, "REPORTED_FAILED");
    assert.equal(second.outcome, "ALREADY_FINAL");
    assert.equal(service.getTask(taskId).state, STATES.FAILED);
    assert.equal(service.listEvents({ taskId }).filter((event) => event.eventType === "task.failed").length, 1);
    assert.ok(service.leases.getLease(lease.leaseId).releasedAt);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
});
