"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CoordinationApplicationService,
} = require("../lib/coordination/application-service");
const { createClaudeAdapter, createLaunchContext } = require("../lib/coordination/claude-adapter");
const { createCodexAdapter } = require("../lib/coordination/codex-adapter");
const { ConsumerCursorStore } = require("../lib/coordination/consumer-cursor");
const { createEvent, STATES } = require("../lib/coordination/contract");
const { createManualClock } = require("../lib/coordination/lease");
const { NotificationPump } = require("../lib/coordination/notification-pump");

const COORDINATOR = { actorId: "codex-coordinator", kind: "coordinator" };
const CLAUDE = {
  actorId: "claude-worker", kind: "agent", sessionId: "session-claude",
};
const SUCCESSOR = {
  actorId: "codex-recovery", kind: "agent", sessionId: "session-recovery",
};
const COORDINATOR_AUTH = {
  ...COORDINATOR,
  sessionId: "session-coordinator",
  workflowGate: "M-008",
};
const CLAUDE_AUTH = {
  ...CLAUDE,
  sessionId: "session-claude",
};
const SUCCESSOR_AUTH = {
  ...SUCCESSOR,
  sessionId: "session-recovery",
};
const REPOSITORY = {
  repositoryId: "samhmi-pilot",
  worktreeId: "coordination-pilot",
  branch: "codex/coordination-pilot",
  baselineCommit: "baseline-commit",
};

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-samhmi-pilot-"));
}

function event(overrides) {
  return createEvent({
    eventId: overrides.eventId,
    projectId: "samhmi-pilot",
    taskId: overrides.taskId || "TASK-SAMHMI-PILOT",
    correlationId: overrides.correlationId || "CORR-SAMHMI-PILOT",
    producer: overrides.producer || COORDINATOR,
    targets: overrides.targets || [],
    eventType: overrides.eventType,
    previousState: overrides.previousState,
    currentState: overrides.currentState,
    timestamp: overrides.timestamp || "2026-07-28T08:00:00.000Z",
    sequence: overrides.sequence,
    repository: REPOSITORY,
    fileOwnership: overrides.fileOwnership || [],
    progress: overrides.progress,
    message: overrides.message,
    evidence: overrides.evidence,
    requestedAction: overrides.requestedAction,
    notification: overrides.notification || {
      policy: "journal_only",
      dedupeKey: overrides.eventType,
      ackRequired: false,
    },
  });
}

function submitLifecycle(app, taskId = "TASK-SAMHMI-PILOT") {
  app.submit(event({
    taskId,
    eventId: `CE-${taskId}-CREATED`,
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
  }), COORDINATOR_AUTH);
  app.submit(event({
    taskId,
    eventId: `CE-${taskId}-ASSIGNED`,
    eventType: "task.assigned",
    previousState: STATES.CREATED,
    currentState: STATES.ASSIGNED,
    targets: [{ actorId: CLAUDE.actorId, kind: CLAUDE.kind }],
  }), COORDINATOR_AUTH);
  app.submit(event({
    taskId,
    eventId: `CE-${taskId}-ACCEPTED`,
    producer: CLAUDE,
    eventType: "task.accepted",
    previousState: STATES.ASSIGNED,
    currentState: STATES.ACCEPTED,
  }), CLAUDE_AUTH);
  app.submit(event({
    taskId,
    eventId: `CE-${taskId}-EXECUTING`,
    producer: CLAUDE,
    eventType: "task.progress",
    previousState: STATES.ACCEPTED,
    currentState: STATES.EXECUTING,
    progress: { phase: "implementation", percent: 30 },
  }), CLAUDE_AUTH);
}

function notificationAdapter(codex, acknowledge) {
  return {
    async deliver(delivery) {
      const result = await codex.wake(delivery.event);
      return {
        acknowledged: acknowledge(delivery.event, result),
      };
    },
  };
}

test("SamHMI pilot completes Codex to Claude to Codex input, restart, unacked and ready flow", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const launch = createLaunchContext({
    taskId: "TASK-SAMHMI-PILOT",
    correlationId: "CORR-SAMHMI-PILOT",
    projectId: "samhmi-pilot",
    repository: REPOSITORY,
    ownershipScopes: ["src/coordination-pilot/**"],
    acceptanceCriteria: ["coordination pilot tests pass"],
    forbiddenActions: ["do not push"],
    allowedTools: ["node"],
    heartbeatIntervalMs: 30_000,
    terminalTimeoutMs: 300_000,
    notificationPolicy: "coordinator_notify",
  });
  const claude = createClaudeAdapter({ hooks: true, explicitCli: true });
  assert.equal(launch.repository.repositoryId, "samhmi-pilot");
  assert.equal(claude.buildReport("task.testing", {
    event: event({
      eventId: "CE-FALLBACK-TESTING",
      producer: CLAUDE,
      eventType: "task.testing",
      previousState: STATES.EXECUTING,
      currentState: STATES.TESTING,
    }),
  }).hookName, "TestStart");

  let app = CoordinationApplicationService.open(root, {
    journal: { lock: false },
    authorization: { workflowGates: ["M-008"] },
  });
  submitLifecycle(app);
  app.submit(event({
    eventId: "CE-INPUT-REQUIRED",
    producer: CLAUDE,
    targets: [COORDINATOR],
    eventType: "task.input_required",
    previousState: STATES.EXECUTING,
    currentState: STATES.WAITING_FOR_INPUT,
    requestedAction: {
      kind: "provide_input",
      decisionRef: "D-SAMHMI-PILOT-INPUT",
      waitpointRef: "WP-SAMHMI-PILOT-INPUT",
    },
    message: "A bounded implementation choice needs coordinator input",
    notification: {
      policy: "user_attention",
      dedupeKey: "pilot-input",
      ackRequired: true,
    },
  }), CLAUDE_AUTH);

  const wakeups = [];
  const codex = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    deliver: async (request) => wakeups.push(request),
  });
  let cursor = new ConsumerCursorStore(path.join(root, "consumers"), "codex-coordinator");
  let pump = new NotificationPump({
    journal: app.journal,
    cursor,
    target: COORDINATOR,
    retry: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
    adapter: notificationAdapter(codex, () => false),
  });
  assert.equal((await pump.runOnce()).delivered, 1);
  assert.equal(wakeups[0].requestedAction.decisionRef, "D-SAMHMI-PILOT-INPUT");
  assert.equal(cursor.read().acknowledged && Object.keys(cursor.read().acknowledged).length, 0);
  app.close();

  app = CoordinationApplicationService.open(root, {
    journal: { lock: false },
    authorization: { workflowGates: ["M-008"] },
  });
  cursor = new ConsumerCursorStore(path.join(root, "consumers"), "codex-coordinator");
  pump = new NotificationPump({
    journal: app.journal,
    cursor,
    target: COORDINATOR,
    adapter: notificationAdapter(codex, (delivered) =>
      delivered.eventId === "CE-INPUT-REQUIRED" || delivered.eventId === "CE-READY"),
  });
  assert.equal((await pump.runOnce()).acknowledged, 1);
  assert.equal(wakeups.filter((item) => item.eventId === "CE-INPUT-REQUIRED").length, 2);

  app.submit(event({
    eventId: "CE-INPUT-RESOLVED",
    producer: CLAUDE,
    eventType: "task.progress",
    previousState: STATES.WAITING_FOR_INPUT,
    currentState: STATES.EXECUTING,
    progress: { phase: "implementation", percent: 60 },
  }), CLAUDE_AUTH);
  app.submit(event({
    eventId: "CE-TESTING",
    producer: CLAUDE,
    eventType: "task.testing",
    previousState: STATES.EXECUTING,
    currentState: STATES.TESTING,
  }), CLAUDE_AUTH);
  app.submit(event({
    eventId: "CE-READY",
    producer: CLAUDE,
    targets: [COORDINATOR],
    eventType: "task.ready_for_review",
    previousState: STATES.TESTING,
    currentState: STATES.READY_FOR_REVIEW,
    evidence: [{ kind: "validation", ref: "reports/samhmi-pilot-tests" }],
    message: "Pilot evidence is ready for independent review",
    notification: {
      policy: "coordinator_notify",
      dedupeKey: "pilot-ready",
      ackRequired: true,
    },
  }), CLAUDE_AUTH);

  assert.equal((await pump.runOnce()).acknowledged, 1);
  assert.equal(wakeups.at(-1).eventId, "CE-READY");
  assert.equal(wakeups.at(-1).autoApprove, false);
  assert.equal(wakeups.at(-1).executeSideEffects, false);
  app.submit(event({
    eventId: "CE-COMPLETED",
    eventType: "task.completed",
    previousState: STATES.READY_FOR_REVIEW,
    currentState: STATES.COMPLETED,
    evidence: [{ kind: "validation", ref: "reports/independent-review" }],
  }), COORDINATOR_AUTH);
  assert.equal(app.getTask("TASK-SAMHMI-PILOT").state, STATES.COMPLETED);

  const durableText = fs.readFileSync(
    path.join(root, "journal", "events-000001.jsonl"),
    "utf8",
  );
  assert.equal(durableText.includes(`${path.sep}Users${path.sep}`), false);
  assert.equal(durableText.includes(`${path.sep}workspace${path.sep}`), false);
  assert.doesNotMatch(durableText, /token|socket|pid/i);
  app.close();
});

test("SamHMI pilot fails closed before a fenced takeover and completes with recovery evidence", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = createManualClock(Date.parse("2026-07-28T09:00:00.000Z"));
  const app = CoordinationApplicationService.open(root, {
    clock,
    journal: { lock: false },
    authorization: { workflowGates: ["M-008"] },
  });
  t.after(() => app.close());

  const taskId = "TASK-SAMHMI-TAKEOVER";
  submitLifecycle(app, taskId);
  const scope = "src/coordination-pilot/**";
  const original = app.acquireOwnership(scope, CLAUDE.actorId, {
    actorId: "session-claude",
    ttl: 1_000,
  });
  clock.advance(1_001);

  assert.throws(
    () => app.acquireOwnership(scope, SUCCESSOR.actorId, {
      actorId: "session-recovery",
      ttl: 1_000,
    }),
    { key: "ERR_LEASE_CONFLICT" },
  );
  const stale = app.markOwnershipStale(original.leaseId, {
    actorId: COORDINATOR.actorId,
  });
  assert.ok(stale.staleAt);
  app.submit(event({
    taskId,
    eventId: "CE-STALE",
    eventType: "task.stale",
    previousState: STATES.EXECUTING,
    currentState: STATES.STALE,
    message: "Lease expired and continuity could not be proven",
  }), COORDINATOR_AUTH);

  const requested = app.requestOwnershipTakeover(scope, SUCCESSOR.actorId, {
    actorId: COORDINATOR.actorId,
    evidence: "operation:stop-observed",
  });
  app.submit(event({
    taskId,
    eventId: "CE-TAKEOVER-REQUESTED",
    eventType: "task.takeover_requested",
    previousState: STATES.STALE,
    currentState: STATES.TAKEOVER_REQUESTED,
    requestedAction: { kind: "takeover" },
    evidence: [{ kind: "operation", ref: "operation/stop-observed" }],
  }), COORDINATOR_AUTH);
  assert.throws(
    () => app.completeOwnershipTakeover(requested.requestId, {
      actorId: COORDINATOR.actorId,
    }),
    { key: "ERR_MISSING_EVIDENCE" },
  );

  const takeover = app.completeOwnershipTakeover(requested.requestId, {
    actorId: COORDINATOR.actorId,
    sessionId: SUCCESSOR_AUTH.sessionId,
    recoveryEvidence: "operation:worktree-reconciled",
    ttl: 10_000,
  });
  assert.ok(takeover.lease.fencingToken > original.fencingToken);
  app.submit(event({
    taskId,
    eventId: "CE-TAKEN-OVER",
    producer: SUCCESSOR,
    eventType: "task.taken_over",
    previousState: STATES.TAKEOVER_REQUESTED,
    currentState: STATES.TAKEN_OVER,
    fileOwnership: [{
      leaseId: takeover.lease.leaseId,
      scope,
      owner: takeover.lease.owner,
      fencingToken: takeover.lease.fencingToken,
      expiresAt: takeover.lease.expiresAt,
    }],
    evidence: [{ kind: "operation", ref: "operation/worktree-reconciled" }],
  }), SUCCESSOR_AUTH);
  app.submit(event({
    taskId,
    eventId: "CE-RECOVERY-EXECUTING",
    producer: SUCCESSOR,
    eventType: "task.progress",
    previousState: STATES.TAKEN_OVER,
    currentState: STATES.EXECUTING,
    progress: { phase: "recovery", percent: 80 },
  }), SUCCESSOR_AUTH);
  app.submit(event({
    taskId,
    eventId: "CE-RECOVERY-TESTING",
    producer: SUCCESSOR,
    eventType: "task.testing",
    previousState: STATES.EXECUTING,
    currentState: STATES.TESTING,
  }), SUCCESSOR_AUTH);
  app.submit(event({
    taskId,
    eventId: "CE-RECOVERY-READY",
    producer: SUCCESSOR,
    targets: [COORDINATOR],
    eventType: "task.ready_for_review",
    previousState: STATES.TESTING,
    currentState: STATES.READY_FOR_REVIEW,
    evidence: [{ kind: "validation", ref: "reports/takeover-validation" }],
    notification: {
      policy: "coordinator_notify",
      dedupeKey: "takeover-ready",
      ackRequired: true,
    },
  }), SUCCESSOR_AUTH);
  app.submit(event({
    taskId,
    eventId: "CE-RECOVERY-COMPLETED",
    eventType: "task.completed",
    previousState: STATES.READY_FOR_REVIEW,
    currentState: STATES.COMPLETED,
  }), COORDINATOR_AUTH);

  const task = app.getTask(taskId);
  assert.equal(task.state, STATES.COMPLETED);
  assert.equal(task.assignee, SUCCESSOR.actorId);
  assert.equal(task.ownership.length, 1);
  assert.equal(task.ownership[0].scope, scope);
  assert.equal(task.ownership[0].fencingToken, takeover.lease.fencingToken);
});
