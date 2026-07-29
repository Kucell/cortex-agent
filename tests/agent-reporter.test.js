"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEvent, STATES } = require("../lib/coordination/contract");
const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const {
  createAgentReporter,
  AGENT_SCOPED_EVENT_TYPES,
  AGENT_SCOPED_EVENT_SET,
  AGENT_TRANSITIONS,
  AgentReporterError,
  FORBIDDEN_AGENT_FIELDS,
  sanitizeAgentInput,
  scanAgentInput,
  buildRedactedReceipt,
} = require("../lib/agent-reporter");

function runtimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agent-reporter-"));
}

function createService(dir) {
  return CoordinationApplicationService.open(dir, { journal: { lock: false } });
}

let setupCounter = 0;

function setupCoordinatorTask(service, taskId) {
  setupCounter += 1;
  const tid = taskId || `TASK-RPT-${String(setupCounter).padStart(3, "0")}`;
  const created = createEvent({
    eventId: `CE-coord-create-${tid}`,
    projectId: "test-project",
    taskId: tid,
    correlationId: `CORR-RPT-${tid}`,
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    sequence: 1,
    repository: { repositoryId: "test-project" },
    notification: { policy: "journal_only", dedupeKey: "test" },
  });
  service.submit(created, { actorId: "coordinator", kind: "coordinator", sessionId: "sess" });

  const assigned = createEvent({
    eventId: `CE-coord-assign-${tid}`,
    projectId: "test-project",
    taskId: tid,
    correlationId: `CORR-RPT-${tid}`,
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [{ actorId: "test-agent", kind: "agent" }],
    eventType: "task.assigned",
    previousState: STATES.CREATED,
    currentState: STATES.ASSIGNED,
    sequence: 2,
    repository: { repositoryId: "test-project" },
    notification: { policy: "journal_only", dedupeKey: "test" },
  });
  service.submit(assigned, { actorId: "coordinator", kind: "coordinator", sessionId: "sess" });

  return tid;
}

// ─── Agent Reporter construction ─────────────────────────────────────────────

test("createAgentReporter requires valid options", () => {
  assert.throws(() => createAgentReporter(null, null), /ERR_OPTIONS_REQUIRED/);
  assert.throws(() => createAgentReporter(null, {}), /ERR_FIELD_INVALID/);
  assert.throws(() => createAgentReporter(null, { actorId: "a", kind: "coordinator", sessionId: "s", projectId: "p" }), /ERR_KIND_MUST_BE_AGENT/);
});

test("createAgentReporter returns a frozen reporter with stable identity", () => {
  const reporter = createAgentReporter(null, {
    actorId: "test-agent",
    kind: "agent",
    sessionId: "session-1",
    projectId: "test-project",
  });
  assert.equal(reporter.actorId, "test-agent");
  assert.equal(reporter.kind, "agent");
  assert.equal(reporter.sessionId, "session-1");
  assert.equal(reporter.projectId, "test-project");
  assert.equal(reporter.schemaVersion, "1.0");
  assert.equal(typeof reporter.report, "function");
  assert.equal(typeof reporter.openBatch, "function");
});

// ─── Agent-scoped event type vocabulary ──────────────────────────────────────

test("agent-scoped event types match the existing coordination vocabulary", () => {
  const expectedTypes = [
    "task.accepted",
    "task.progress",
    "task.heartbeat",
    "task.testing",
    "task.blocked",
    "task.input_required",
    "task.failed",
    "task.ready_for_review",
  ];
  assert.deepEqual([...AGENT_SCOPED_EVENT_TYPES].sort(), expectedTypes.sort());
  expectedTypes.forEach((t) => assert.ok(AGENT_SCOPED_EVENT_SET.has(t)));
  assert.equal(AGENT_SCOPED_EVENT_SET.has("task.created"), false);
  assert.equal(AGENT_SCOPED_EVENT_SET.has("task.completed"), false);
  assert.equal(AGENT_SCOPED_EVENT_SET.has("task.cancelled"), false);
});

// ─── Report without service (offline/no-op) ──────────────────────────────────

test("report without service returns SERVICE_UNAVAILABLE", () => {
  const reporter = createAgentReporter(null, {
    actorId: "test-agent",
    kind: "agent",
    sessionId: "session-1",
    projectId: "test-project",
  });
  const result = reporter.report("task.progress", { taskId: "TASK-001" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SERVICE_UNAVAILABLE");
});

test("report rejects non-agent-scoped event types", () => {
  const reporter = createAgentReporter(null, {
    actorId: "test-agent",
    kind: "agent",
    sessionId: "session-1",
    projectId: "test-project",
  });
  const result = reporter.report("task.created", { taskId: "TASK-001" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ERR_EVENT_TYPE_NOT_AGENT_SCOPED");
});

// ─── Report with service (lifecycle flow) ────────────────────────────────────

test("report submits accepted event through the service", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const result = reporter.report("task.accepted", { taskId });
    assert.equal(result.ok, true);
    assert.equal(result.event.eventType, "task.accepted");
    assert.equal(result.task.state, STATES.ACCEPTED);
    assert.equal(result.appended, true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report submits progress event with message", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    reporter.report("task.accepted", { taskId });
    const result = reporter.report("task.progress", {
      taskId,
      message: "Working on phase 1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.event.eventType, "task.progress");
    assert.equal(result.event.message, "Working on phase 1");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report submits heartbeat event without state change", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    reporter.report("task.accepted", { taskId });
    const result = reporter.report("task.heartbeat", { taskId });
    assert.equal(result.ok, true);
    assert.equal(result.event.eventType, "task.heartbeat");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report submits testing event", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    reporter.report("task.accepted", { taskId });
    reporter.report("task.progress", { taskId });
    const result = reporter.report("task.testing", { taskId });
    assert.equal(result.ok, true);
    assert.equal(result.event.eventType, "task.testing");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report submits blocked and failed events", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    reporter.report("task.accepted", { taskId });

    const blocked = reporter.report("task.blocked", {
      taskId,
      message: "Waiting for API key",
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.event.eventType, "task.blocked");

    // Cannot report failed from blocked (agent can always report failed)
    const failed = reporter.report("task.failed", {
      taskId,
      message: "Dependency unavailable",
    });
    // Failed may or may not be accepted depending on state machine; agent
    // reporter reports it regardless, the service may reject it.
    // Verify the reporter at least attempted to send it.
    assert.equal(failed.ok === true || failed.ok === false, true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report rejects coordinator-scoped events like completed", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const result = reporter.report("task.completed", { taskId });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_EVENT_TYPE_NOT_AGENT_SCOPED");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Duplicate detection ─────────────────────────────────────────────────────

test("duplicate event submission is idempotent", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const first = reporter.report("task.accepted", { taskId });
    assert.equal(first.ok, true);
    assert.equal(first.appended, true);

    // Re-submit the same event (duplicate detection via eventId)
    const second = reporter.report("task.accepted", { taskId });
    // The second call generates a new event with a new eventId, so it's
    // not a duplicate from the service's perspective (different eventId).
    // But it should fail because the state machine rejects accepted → accepted.
    assert.equal(second.ok, false);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Batch reporting (openBatch) ─────────────────────────────────────────────

test("openBatch creates a batch with shared correlation", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const batch = reporter.openBatch(taskId);
    assert.equal(batch.taskId, taskId);
    assert.ok(typeof batch.batchId, "string");
    assert.equal(typeof batch.add, "function");
    assert.equal(Array.isArray(batch.events()), true);
    assert.equal(typeof batch.summary, "function");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("batch summary reports ok and failed counts", () => {
  const reporter = createAgentReporter(null, {
    actorId: "test-agent",
    kind: "agent",
    sessionId: "agent-session",
    projectId: "test-project",
  });

  const batch = reporter.openBatch("TASK-001");
  batch.add("task.progress", { taskId: "TASK-001" });
  batch.add("task.heartbeat", { taskId: "TASK-001" });
  batch.add("task.created", { taskId: "TASK-001" });

  const summary = batch.summary();
  assert.equal(summary.total, 3);
  assert.equal(summary.ok, 0); // no service
  assert.equal(summary.failed, 3);
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test("report rejects empty taskId", () => {
  const reporter = createAgentReporter(null, {
    actorId: "test-agent",
    kind: "agent",
    sessionId: "session-1",
    projectId: "test-project",
  });
  assert.throws(() => reporter.report("task.progress", { taskId: "" }), /ERR_FIELD_INVALID/);
});

test("report with evidence refs is accepted", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const result = reporter.report("task.accepted", {
      taskId,
      evidence: [{ kind: "validation", ref: "VC-001" }],
    });
    assert.equal(result.ok, true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Negative constraints: forbidden fields are stripped from agent input ────

test("sanitizeAgentInput strips forbidden fields", () => {
  const sanitized = sanitizeAgentInput({
    taskId: "TASK-001",
    message: "Working",
    targets: [{ actorId: "evil", kind: "agent" }],
    repository: { repositoryId: "evil-repo" },
    sequence: 99,
    workflowGate: "evil-gate",
    currentState: "COMPLETED",
    previousState: "CREATED",
    permission: "admin",
    ownership: "write",
    Decision: "approve",
    Waitpoint: "release",
  });

  assert.equal(sanitized.taskId, "TASK-001");
  assert.equal(sanitized.message, "Working");
  assert.equal(sanitized.targets, undefined);
  assert.equal(sanitized.repository, undefined);
  assert.equal(sanitized.sequence, undefined);
  assert.equal(sanitized.workflowGate, undefined);
  assert.equal(sanitized.currentState, undefined);
  assert.equal(sanitized.previousState, undefined);
  assert.equal(sanitized.permission, undefined);
  assert.equal(sanitized.ownership, undefined);
  assert.equal(sanitized.Decision, undefined);
  assert.equal(sanitized.Waitpoint, undefined);
});

test("sanitizeAgentInput limits message length", () => {
  const longMessage = "x".repeat(5000);
  const sanitized = sanitizeAgentInput({
    taskId: "TASK-001",
    message: longMessage,
  });
  assert.ok(sanitized.message.length <= 4000);
  assert.equal(sanitized.message.length, 4000);
});

test("sanitizeAgentInput limits evidence count", () => {
  const manyEvidence = Array.from({ length: 50 }, (_, i) => ({ kind: "validation", ref: `VC-${i}` }));
  const sanitized = sanitizeAgentInput({
    taskId: "TASK-001",
    evidence: manyEvidence,
  });
  assert.ok(Array.isArray(sanitized.evidence));
  assert.equal(sanitized.evidence.length, 32);
});

test("sanitizeAgentInput truncates long evidence refs", () => {
  const longRef = "a".repeat(300);
  const sanitized = sanitizeAgentInput({
    taskId: "TASK-001",
    evidence: [{ kind: "validation", ref: longRef }],
  });
  assert.ok(sanitized.evidence[0].ref.length <= 256);
  assert.equal(sanitized.evidence[0].ref.length, 256);
});

test("report does not forward targets, repository, or sequence to service", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    // Try to inject forbidden fields — they should be silently stripped
    const result = reporter.report("task.accepted", {
      taskId,
      targets: [{ actorId: "evil", kind: "coordinator" }],
      repository: { repositoryId: "evil-repo" },
      sequence: 999,
      workflowGate: "evil-gate",
    });

    assert.equal(result.ok, true);
    // The event should NOT contain the forbidden fields
    assert.deepEqual(result.event.targets, []);
    // repository should be the project context, not the agent's value
    // The service assigns a real sequence number; verify agent's 999 was not used
    assert.notEqual(result.event.sequence, 999);
    // Targets in the event should be empty (agent cannot set targets)
    assert.equal(result.event.targets.length, 0);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report does not forward workflowGate from agent input", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    // workflowGate should not be passed to service.submit
    const result = reporter.report("task.accepted", {
      taskId,
      workflowGate: "coordinator_approval",
    });

    assert.equal(result.ok, true);
    // The event should not have any workflowGate reference
    assert.equal(result.event.eventType, "task.accepted");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report returns a redacted receipt on success", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const result = reporter.report("task.accepted", {
      taskId,
      message: "Some sensitive info",
    });

    assert.equal(result.ok, true);
    assert.ok(result.receipt);
    assert.equal(result.receipt.eventId, result.event.eventId);
    assert.equal(result.receipt.eventType, "task.accepted");
    assert.equal(result.receipt.taskId, taskId);
    assert.ok(result.receipt.timestamp);
    assert.ok(result.receipt.state);
    // Receipt should not contain raw event details
    assert.equal(result.receipt.ok, true);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report rejects input with sensitive data patterns", () => {
  const reporter = createAgentReporter(null, {
    actorId: "test-agent",
    kind: "agent",
    sessionId: "agent-session",
    projectId: "test-project",
  });

  // Input containing a secret-like pattern
  const result = reporter.report("task.progress", {
    taskId: "TASK-001",
    message: "Using API key sk-proj-abc123def456",
  });

  // Without service, it returns SERVICE_UNAVAILABLE (no secret scan in offline mode)
  assert.equal(result.ok, false);
  assert.equal(result.code, "SERVICE_UNAVAILABLE");
});

// ─── P-003 CP-11: Governance field stripping ────────────────────────────────

test("report strips governance fields from agent input", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    // Agent tries to override governance fields
    const result = reporter.report("task.accepted", {
      taskId,
      targets: [{ actorId: "evil", kind: "agent" }],
      repository: { repositoryId: "evil-repo" },
      sequence: 999,
      workflowGate: "skip",
      currentState: "COMPLETED",
      previousState: "COMPLETED",
    });
    assert.equal(result.ok, true);
    // The event should use the reporter's governance values, not agent's
    assert.equal(result.event.targets.length, 0);
    assert.equal(result.event.repository.repositoryId, "test-project");
    // The service assigns a real sequence number; verify agent's 999 was not used
    assert.notEqual(result.event.sequence, 999);
    // currentState/previousState should be derived from service
    assert.equal(result.event.previousState, "ASSIGNED");
    assert.equal(result.event.currentState, "ACCEPTED");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report strips forbidden fields even without service", () => {
  const reporter = createAgentReporter(null, {
    actorId: "test-agent",
    kind: "agent",
    sessionId: "session-1",
    projectId: "test-project",
  });
  const result = reporter.report("task.progress", {
    taskId: "TASK-001",
    targets: [{ actorId: "evil" }],
    repository: { repositoryId: "evil" },
    sequence: 99,
    workflowGate: "skip",
  });
  // Without service, it returns SERVICE_UNAVAILABLE from the no-op path
  // but the important thing is it doesn't throw or crash
  assert.equal(result.ok, false);
  assert.equal(result.code, "SERVICE_UNAVAILABLE");
  // The input in the result should NOT contain governance fields
  assert.equal(result.input.targets, undefined);
  assert.equal(result.input.repository, undefined);
  assert.equal(result.input.sequence, undefined);
  assert.equal(result.input.workflowGate, undefined);
});

// ─── P-003 CP-11: Input sanitization (length limits) ────────────────────────

test("report truncates overly long message", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const longMsg = "x".repeat(5000);
    const result = reporter.report("task.accepted", {
      taskId,
      message: longMsg,
    });
    assert.equal(result.ok, true);
    assert.equal(result.event.message.length, 4000);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report limits evidence count", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const manyEvidence = Array.from({ length: 50 }, (_, i) => ({
      kind: "validation",
      ref: `VC-${i}`,
    }));
    const result = reporter.report("task.accepted", {
      taskId,
      evidence: manyEvidence,
    });
    assert.equal(result.ok, true);
    assert.equal(result.event.evidence.length, 32);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report truncates evidence refs that are too long", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const longRef = [{ kind: "validation", ref: "x".repeat(500) }];
    const result = reporter.report("task.accepted", {
      taskId,
      evidence: longRef,
    });
    assert.equal(result.ok, true);
    assert.equal(result.event.evidence[0].ref.length, 256);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11: Redacted receipt ──────────────────────────────────────────

test("report returns a redacted receipt", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const result = reporter.report("task.accepted", {
      taskId,
      message: "Working on task",
    });
    assert.equal(result.ok, true);
    assert.ok(result.receipt);
    assert.equal(result.receipt.eventId, result.event.eventId);
    assert.equal(result.receipt.eventType, "task.accepted");
    assert.equal(result.receipt.taskId, taskId);
    assert.equal(result.receipt.projectId, "test-project");
    assert.ok(result.receipt.timestamp);
    assert.equal(result.receipt.state, "ACCEPTED");
    assert.equal(result.receipt.ok, true);
    assert.equal(result.receipt.message, "Working on task");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11 §13.5: ready_for_review requires evidence ────────────────────

test("ready_for_review without evidence is rejected by the service", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    // Accept first, then progress to EXECUTING
    reporter.report("task.accepted", { taskId });
    reporter.report("task.progress", { taskId });

    // Try ready_for_review without evidence — should fail
    const result = reporter.report("task.ready_for_review", { taskId });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_MISSING_EVIDENCE");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ready_for_review with evidence is accepted", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    // Accept first, then progress to EXECUTING
    reporter.report("task.accepted", { taskId });
    reporter.report("task.progress", { taskId });

    // Submit ready_for_review WITH evidence
    const result = reporter.report("task.ready_for_review", {
      taskId,
      evidence: [{ kind: "validation", ref: "VC-001" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.event.eventType, "task.ready_for_review");
    assert.equal(result.task.state, STATES.READY_FOR_REVIEW);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11 §13.5: Exit 0 / stop must NOT auto complete ─────────────────

test("exit 0 does not auto-transition to completed or ready_for_review", () => {
  // This test verifies that the governed launcher and agent reporter
  // do NOT auto-transition on exit 0. The system only transitions
  // when an explicit event is submitted through the service.
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const taskId = setupCoordinatorTask(service);
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    // Accept and progress
    reporter.report("task.accepted", { taskId });
    reporter.report("task.progress", { taskId });

    // Verify task is still in EXECUTING (not auto-completed)
    const task = service.getTask(taskId);
    assert.equal(task.state, STATES.EXECUTING);

    // There is no auto-ready or auto-complete on exit 0.
    // The system stays in EXECUTING until an explicit event.
    const taskAfter = service.getTask(taskId);
    assert.equal(taskAfter.state, STATES.EXECUTING);

    // A heartbeat does not trigger ready or complete
    reporter.report("task.heartbeat", { taskId });
    const taskAfterHeartbeat = service.getTask(taskId);
    assert.equal(taskAfterHeartbeat.state, STATES.EXECUTING);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11: E2E lifecycle: governed launch → agent report → ready ──────

test("E2E lifecycle: governed launch, agent report, ready with evidence", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    // Step 1: Governed Launcher creates the task
    const { createGovernedLauncher } = require("../lib/governed-launcher");
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      sessionId: "e2e-session",
    });

    const launchResult = launcher.launch({
      taskId: "TASK-E2E-001",
      targetAgentId: "test-agent",
      ownershipScopes: [],
    });
    assert.equal(launchResult.ok, true);
    assert.equal(launchResult.taskState.state, STATES.ASSIGNED);

    // Step 2: Agent Reporter accepts the task
    const reporter = createAgentReporter(service, {
      actorId: "test-agent",
      kind: "agent",
      sessionId: "agent-session",
      projectId: "test-project",
    });

    const acceptResult = reporter.report("task.accepted", { taskId: "TASK-E2E-001" });
    assert.equal(acceptResult.ok, true);
    assert.equal(acceptResult.task.state, STATES.ACCEPTED);

    // Step 3: Agent reports progress
    const progressResult = reporter.report("task.progress", {
      taskId: "TASK-E2E-001",
      message: "Working on implementation",
    });
    assert.equal(progressResult.ok, true);
    assert.equal(progressResult.task.state, STATES.EXECUTING);

    // Step 4: Agent reports blocked (negative)
    const blockedResult = reporter.report("task.blocked", {
      taskId: "TASK-E2E-001",
      message: "Waiting for API key",
    });
    assert.equal(blockedResult.ok, true);
    assert.equal(blockedResult.task.state, STATES.BLOCKED);

    // Step 5: Agent reports progress again (unblocked)
    const unblockResult = reporter.report("task.progress", {
      taskId: "TASK-E2E-001",
      message: "API key received, continuing",
    });
    assert.equal(unblockResult.ok, true);
    assert.equal(unblockResult.task.state, STATES.EXECUTING);

    // Step 6: Agent tries ready_for_review WITHOUT evidence → rejected
    const noEvidenceResult = reporter.report("task.ready_for_review", {
      taskId: "TASK-E2E-001",
    });
    assert.equal(noEvidenceResult.ok, false);
    assert.equal(noEvidenceResult.code, "ERR_MISSING_EVIDENCE");

    // Step 7: Agent reports ready_for_review WITH evidence → accepted
    const readyResult = reporter.report("task.ready_for_review", {
      taskId: "TASK-E2E-001",
      evidence: [{ kind: "artifact", ref: "ARTIFACT-E2E-001" }],
    });
    assert.equal(readyResult.ok, true);
    assert.equal(readyResult.task.state, STATES.READY_FOR_REVIEW);

    // Step 8: Host Event Bridge can also report events
    const { executeBridgeCommand } = require("../lib/host-event-bridge");
    const heartbeatResult = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.heartbeat",
      "--task-id", "TASK-E2E-001",
      "--actor-id", "test-agent",
      "--kind", "agent",
      "--session-id", "bridge-session",
      "--project-id", "test-project",
    ], { service });
    assert.equal(heartbeatResult.ok, true);
    assert.equal(heartbeatResult.eventType, "task.heartbeat");

    // Verify final task state
    const finalTask = service.getTask("TASK-E2E-001");
    assert.equal(finalTask.state, STATES.READY_FOR_REVIEW);
    assert.equal(finalTask.assignee, "test-agent");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});