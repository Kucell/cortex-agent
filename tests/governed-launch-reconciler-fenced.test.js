"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const { createEvent, STATES } = require("../lib/coordination/contract");
const { reconcileAttemptForReadiness } = require("../lib/governed-launch-reconciler");

// ─── Fixture helpers ────────────────────────────────────────────────────────

function makeRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-fenced-"));
}

function cleanup(root, privateDir) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch (_) {}
}

function writeLaunchContext(privateDir, taskId, projectId, coordinatorId, targetAgentId, sessionId, leaseId, fencingToken, repo) {
  const contextFile = path.join(privateDir, "context.json");
  fs.writeFileSync(contextFile, JSON.stringify({
    taskId, projectId, coordinatorId, targetAgentId,
    launchId: `LAUNCH-${taskId}`,
    sessionId, leaseId, fencingToken,
    producer: { actorId: targetAgentId, kind: "agent", sessionId },
    repository: { repositoryId: projectId, worktreeId: repo },
    notificationTarget: { actorId: coordinatorId, kind: "coordinator" },
  }), { mode: 0o600 });
  return contextFile;
}

function seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId) {
  const coordinator = { actorId: coordinatorId, kind: "coordinator", sessionId: "root" };
  const agent = { actorId: agentId, kind: "agent", sessionId };
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: coordinator, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED, repository: { repositoryId: projectId } }), coordinator);
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: coordinator, targets: [{ actorId: agent.actorId, kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, repository: { repositoryId: projectId } }), coordinator);
  const lease = service.acquireOwnership(`task:${taskId}`, agent.actorId, { actorId: agent.sessionId, ttl: 60_000 });
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, repository: { repositoryId: projectId }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }), agent);
  return { lease };
}

function blockTask(service, taskId, projectId, agentId, sessionId, lease) {
  const agent = { actorId: agentId, kind: "agent", sessionId };
  const ownership = [{ leaseId: lease.leaseId, scope: lease.scope, owner: agentId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }];
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.blocked", previousState: STATES.ACCEPTED, currentState: STATES.BLOCKED, repository: { repositoryId: projectId }, fileOwnership: ownership }), agent);
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: agent, targets: [], eventType: "ownership.released", previousState: STATES.BLOCKED, currentState: STATES.BLOCKED, repository: { repositoryId: projectId } }), agent);
  service.releaseOwnership(lease.leaseId, { actorId: sessionId });
}

function seedTerminalTask(service, taskId, projectId, coordinatorId) {
  const coordinator = { actorId: coordinatorId, kind: "coordinator", sessionId: "root" };
  const agent = { actorId: "pi-completed", kind: "agent", sessionId: "session-completed" };
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: coordinator, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED, repository: { repositoryId: projectId } }), coordinator);
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: coordinator, targets: [{ actorId: agent.actorId, kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, repository: { repositoryId: projectId } }), coordinator);
  const lease = service.acquireOwnership(`task:${taskId}`, agent.actorId, { actorId: agent.sessionId, ttl: 60_000 });
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, repository: { repositoryId: projectId }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }), agent);
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.progress", previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING, repository: { repositoryId: projectId }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }), agent);
  service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.ready_for_review", previousState: STATES.EXECUTING, currentState: STATES.READY_FOR_REVIEW, repository: { repositoryId: projectId }, fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agent.actorId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }], evidence: [{ kind: "artifact", ref: "ART-INITIAL" }] }), agent);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("fenced reconciler promotes BLOCKED attention attempt when fresh lease + evidence are present", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-PROMOTE";
  const projectId = "fenced";
  const coordinatorId = "codex-root";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  let newLease;
  try {
    const { lease } = seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId);
    blockTask(service, taskId, projectId, agentId, sessionId, lease);
    newLease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, agentId, sessionId, newLease.leaseId, newLease.fencingToken, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO", outcome: "REPORTED_BLOCKED" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: newLease.leaseId,
        newFencingToken: newLease.fencingToken,
        actorId: sessionId,
        validationRefs: ["RUN-001-abcdef0", "ARTIFACT-RUN-1"],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.toState, STATES.READY_FOR_REVIEW);
      assert.equal(reopened.getTask(taskId).state, STATES.READY_FOR_REVIEW);
      const events = reopened.listEvents({ taskId });
      assert.ok(events.some((event) => event.eventType === "task.progress" && event.currentState === STATES.EXECUTING));
      assert.ok(events.some((event) => event.eventType === "task.testing" && event.currentState === STATES.TESTING));
      assert.ok(events.some((event) => event.eventType === "task.ready_for_review"));
      const readyEvent = events.find((event) => event.eventType === "task.ready_for_review");
      const evidenceRefs = (readyEvent.evidence || []).map((ref) => ref.ref);
      assert.ok(evidenceRefs.includes("RUN-001-abcdef0"));
      assert.ok(evidenceRefs.includes("ARTIFACT-RUN-1"));
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler rejects requests missing a fresh lease", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-MISS-LEASE";
  const projectId = "fenced";
  const coordinatorId = "codex-root";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  try {
    const { lease } = seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId);
    blockTask(service, taskId, projectId, agentId, sessionId, lease);
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, agentId, sessionId, lease.leaseId, lease.fencingToken, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: null,
        newFencingToken: 1,
        validationRefs: ["RUN-001-abcdef0"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ERR_LEASE_CONFLICT");
      assert.equal(reopened.getTask(taskId).state, STATES.BLOCKED);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler rejects stale fencing token", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-STALE-TOKEN";
  const projectId = "fenced";
  const coordinatorId = "codex-root";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  let newLease;
  try {
    const { lease } = seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId);
    blockTask(service, taskId, projectId, agentId, sessionId, lease);
    newLease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, agentId, sessionId, newLease.leaseId, newLease.fencingToken, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: newLease.leaseId,
        newFencingToken: newLease.fencingToken - 1,
        validationRefs: ["RUN-001-abcdef0"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ERR_LEASE_CONFLICT");
      assert.equal(reopened.getTask(taskId).state, STATES.BLOCKED);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler rejects empty validationRefs", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-MISS-EVIDENCE";
  const projectId = "fenced";
  const coordinatorId = "codex-root";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  let newLease;
  try {
    const { lease } = seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId);
    blockTask(service, taskId, projectId, agentId, sessionId, lease);
    newLease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, agentId, sessionId, newLease.leaseId, newLease.fencingToken, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: newLease.leaseId,
        newFencingToken: newLease.fencingToken,
        validationRefs: [],
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ERR_EVIDENCE_REQUIRED");
      assert.equal(reopened.getTask(taskId).state, STATES.BLOCKED);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler rejects promotions when Task is not BLOCKED", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  try {
    const taskId = "T-FENCED-COMPLETED";
    const projectId = "fenced";
    const coordinatorId = "codex-root";
    seedTerminalTask(service, taskId, projectId, coordinatorId);
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, "pi-fenced", "session-fenced", "lease-x", 1, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: "lease-y",
        newFencingToken: 1,
        validationRefs: ["RUN-001-abcdef0"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ERR_TASK_STATE_NOT_RECONCILABLE");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler rejects when attempt disposition is not attention_required", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-ACTIVE";
  const projectId = "fenced";
  const coordinatorId = "codex-root";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  let newLease;
  try {
    // Seed a BLOCKED task but with the OWNER LINGERING still active —
    // the projection is `attempt_inconsistent` so the reconciler must
    // demand explicit handling beyond the simple attention_required path.
    // To exercise the *non-reconcilable* disposition code we keep the
    // owner alive and add explicit evidence that this is the same active
    // attempt — meaning the fenced reconciler should refuse because no
    // human attention is yet required.
    seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId);
    newLease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, agentId, sessionId, newLease.leaseId, newLease.fencingToken, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: newLease.leaseId,
        newFencingToken: newLease.fencingToken,
        validationRefs: ["RUN-001-abcdef0"],
      });
      // ACCEPTED + active owner is `attempt_active`, neither attention nor
      // inconsistent — fenced promotion must be rejected.
      assert.equal(result.ok, false);
      assert.equal(result.code, "ERR_TASK_STATE_NOT_RECONCILABLE");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler fails closed when the supplied leaseId does not exist", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-MISSING-LEASE";
  const projectId = "fenced";
  const coordinatorId = "codex-root";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  try {
    const { lease } = seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId);
    blockTask(service, taskId, projectId, agentId, sessionId, lease);
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, agentId, sessionId, "lease-unknown", 999, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: "lease-unknown",
        newFencingToken: 999,
        validationRefs: ["RUN-001-abcdef0"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ERR_LEASE_CONFLICT");
      assert.equal(reopened.getTask(taskId).state, STATES.BLOCKED);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler persists a redacted reconciliation receipt on success", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-RECEIPT";
  const projectId = "fenced";
  const coordinatorId = "codex-root";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  let newLease;
  try {
    const { lease } = seedAcceptedTask(service, taskId, projectId, coordinatorId, agentId, sessionId);
    blockTask(service, taskId, projectId, agentId, sessionId, lease);
    newLease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, coordinatorId, agentId, sessionId, newLease.leaseId, newLease.fencingToken, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: newLease.leaseId,
        newFencingToken: newLease.fencingToken,
        actorId: sessionId,
        validationRefs: ["RUN-001-abcdef0"],
      });
      assert.equal(result.ok, true);
      const reconciliationReceiptFile = path.join(privateDir, "reconciliation-receipt.json");
      assert.ok(fs.existsSync(reconciliationReceiptFile), "redacted reconciliation receipt must be persisted");
      const receiptBody = JSON.parse(fs.readFileSync(reconciliationReceiptFile, "utf8"));
      assert.equal(receiptBody.taskId, taskId);
      assert.equal(receiptBody.newLeaseId, newLease.leaseId);
      assert.equal(receiptBody.newFencingToken, newLease.fencingToken);
      const mode = fs.statSync(reconciliationReceiptFile).mode & 0o777;
      assert.equal(mode, 0o600, `redacted reconciliation receipt must be 0600, got ${mode.toString(8)}`);
      const serialized = JSON.stringify(receiptBody);
      for (const forbidden of ["agentCommand", "agentArgs", "sessionId", "contextFile", "prompt"]) {
        assert.ok(!serialized.includes(forbidden), `reconciliation receipt must not include ${forbidden}: ${serialized}`);
      }
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});

test("fenced reconciler refuses snapshot-only repair of legacy ownership", () => {
  const root = makeRuntime();
  const privateDir = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  const taskId = "T-FENCED-LEGACY-OWNER";
  const projectId = "fenced";
  const agentId = "pi-fenced";
  const sessionId = "session-fenced";
  try {
    const { lease } = seedAcceptedTask(service, taskId, projectId, "codex-root", agentId, sessionId);
    const agent = { actorId: agentId, kind: "agent", sessionId };
    const ownership = [{ leaseId: lease.leaseId, scope: lease.scope, owner: agentId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }];
    service.submit(createEvent({ projectId, taskId, correlationId: "C", producer: agent, targets: [], eventType: "task.blocked", previousState: STATES.ACCEPTED, currentState: STATES.BLOCKED, repository: { repositoryId: projectId }, fileOwnership: ownership }), agent);
    service.releaseOwnership(lease.leaseId, { actorId: sessionId });
    const fresh = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
    service.close();

    const reopened = CoordinationApplicationService.open(runtimeCoord);
    try {
      const contextFile = writeLaunchContext(privateDir, taskId, projectId, "codex-root", agentId, sessionId, fresh.leaseId, fresh.fencingToken, root);
      const receiptFile = path.join(privateDir, "child-receipt.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: "exited", code: "EXIT_ZERO" }), { mode: 0o600 });
      const beforeEvents = reopened.listEvents({ taskId }).length;
      const result = reconcileAttemptForReadiness(reopened, {
        contextFile,
        receiptFile,
        newLeaseId: fresh.leaseId,
        newFencingToken: fresh.fencingToken,
        actorId: sessionId,
        validationRefs: ["RUN-LEGACY-1"],
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "ERR_OWNERSHIP_RECOVERY_REQUIRED");
      assert.equal(reopened.getTask(taskId).state, STATES.BLOCKED);
      assert.equal(reopened.listEvents({ taskId }).length, beforeEvents);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(root, privateDir);
  }
});
