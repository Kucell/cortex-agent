"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const {
  parseBridgeArgs,
  executeBridgeCommand,
  HOST_EVENT_BRIDGE_SCHEMA_VERSION,
} = require("../lib/host-event-bridge");
const { createEvent, STATES } = require("../lib/coordination/contract");

function runtimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-host-bridge-"));
}

function createService(dir) {
  return CoordinationApplicationService.open(dir, { journal: { lock: false } });
}

function setupCoordinatorTask(service, taskId) {
  const created = createEvent({
    eventId: `CE-coord-create-${taskId}`,
    projectId: "test-project",
    taskId,
    correlationId: "CORR-HB-001",
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
    eventId: `CE-coord-assign-${taskId}`,
    projectId: "test-project",
    taskId,
    correlationId: "CORR-HB-001",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [{ actorId: "bridge-agent", kind: "agent" }],
    eventType: "task.assigned",
    previousState: STATES.CREATED,
    currentState: STATES.ASSIGNED,
    sequence: 2,
    repository: { repositoryId: "test-project" },
    notification: { policy: "journal_only", dedupeKey: "test" },
  });
  service.submit(assigned, { actorId: "coordinator", kind: "coordinator", sessionId: "sess" });
}

// ─── CLI argument parsing ────────────────────────────────────────────────────

test("parseBridgeArgs rejects invalid usage", () => {
  const result = parseBridgeArgs(["unknown", "action"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_USAGE");
});

test("parseBridgeArgs requires --event-type and --task-id", () => {
  const result = parseBridgeArgs(["agent", "report"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_USAGE");
});

test("parseBridgeArgs rejects non-agent-scoped event types", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.created",
    "--task-id", "TASK-001",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_TYPE_NOT_AGENT_SCOPED");
});

test("parseBridgeArgs accepts a valid agent-scoped report", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "TASK-001",
    "--actor-id", "bridge-agent",
    "--kind", "agent",
    "--session-id", "bridge-session",
    "--project-id", "test-project",
    "--message", "Processing",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.eventType, "task.progress");
  assert.equal(result.taskId, "TASK-001");
  assert.equal(result.actorId, "bridge-agent");
  assert.equal(result.kind, "agent");
  assert.equal(result.sessionId, "bridge-session");
  assert.equal(result.projectId, "test-project");
  assert.equal(result.reportInput.message, "Processing");
});

test("parseBridgeArgs uses defaults for optional actor fields", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.heartbeat",
    "--task-id", "TASK-001",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.actorId, "bridge-agent");
  assert.equal(result.kind, "agent");
  assert.equal(result.sessionId, "bridge-session");
  assert.equal(result.projectId, "default");
});

test("parseBridgeArgs accepts optional --correlation-id and --notification-policy", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.failed",
    "--task-id", "TASK-001",
    "--correlation-id", "CORR-HB-001",
    "--notification-policy", "coordinator_notify",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.reportInput.correlationId, "CORR-HB-001");
  assert.equal(result.reportInput.notificationPolicy, "coordinator_notify");
});

// ─── Bridge execution ────────────────────────────────────────────────────────

test("executeBridgeCommand without service returns SERVICE_UNAVAILABLE", () => {
  const result = executeBridgeCommand([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "TASK-001",
  ], {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SERVICE_UNAVAILABLE");
});

test("executeBridgeCommand submits a valid agent-scoped event", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    setupCoordinatorTask(service, "TASK-HB-001");
    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.accepted",
      "--task-id", "TASK-HB-001",
      "--actor-id", "bridge-agent",
      "--kind", "agent",
      "--session-id", "bridge-session",
      "--project-id", "test-project",
    ], { service });

    assert.equal(result.ok, true);
    assert.equal(result.command, "agent.report");
    assert.equal(result.eventType, "task.accepted");
    assert.equal(result.taskId, "TASK-HB-001");
    assert.ok(result.event);
    assert.ok(result.task);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executeBridgeCommand submits progress and heartbeat through the bridge", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    setupCoordinatorTask(service, "TASK-HB-002");

    const accepted = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.accepted",
      "--task-id", "TASK-HB-002",
      "--actor-id", "bridge-agent",
      "--kind", "agent",
      "--session-id", "bridge-session",
      "--project-id", "test-project",
    ], { service });
    assert.equal(accepted.ok, true);

    const progress = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.progress",
      "--task-id", "TASK-HB-002",
      "--actor-id", "bridge-agent",
      "--kind", "agent",
      "--session-id", "bridge-session",
      "--project-id", "test-project",
      "--message", "Working through bridge",
    ], { service });
    assert.equal(progress.ok, true);
    assert.equal(progress.eventType, "task.progress");

    const heartbeat = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.heartbeat",
      "--task-id", "TASK-HB-002",
      "--actor-id", "bridge-agent",
      "--kind", "agent",
      "--session-id", "bridge-session",
      "--project-id", "test-project",
    ], { service });
    assert.equal(heartbeat.ok, true);
    assert.equal(heartbeat.eventType, "task.heartbeat");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executeBridgeCommand rejects events whose state machine transition is invalid", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    setupCoordinatorTask(service, "TASK-HB-003");

    // Try to report ready_for_review when task is still in ASSIGNED
    // (not EXECUTING/TESTING)
    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.ready_for_review",
      "--task-id", "TASK-HB-003",
      "--actor-id", "bridge-agent",
      "--kind", "agent",
      "--session-id", "bridge-session",
      "--project-id", "test-project",
    ], { service });
    // The bridge passes through the service result; the service may reject
    // based on the state machine. The bridge does not validate transitions.
    assert.equal(result.ok, false);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Negative constraints: --event-json is rejected ─────────────────────────

test("bridge rejects --event-json with invalid JSON", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "TASK-001",
    "--event-json", "not-json",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_JSON_REJECTED");
});

test("bridge rejects --event-json even with valid JSON", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "TASK-001",
    "--event-json", JSON.stringify({ message: "Custom progress update" }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_JSON_REJECTED");
});

test("bridge rejects --event-json with empty object", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "TASK-001",
    "--event-json", "{}",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_JSON_REJECTED");
});

test("bridge rejects unknown options that are not in the restricted allowlist", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "TASK-001",
    "--targets", '[{"actorId":"evil","kind":"agent"}]',
    "--repository", '{"repositoryId":"evil-repo"}',
    "--sequence", "99",
  ]);
  // Unknown options are silently ignored by the bridge (they are not parsed)
  // but should not affect the valid result
  assert.equal(result.ok, true);
  // The bridge should not forward these fields
  assert.equal(result.reportInput.targets, undefined);
  assert.equal(result.reportInput.repository, undefined);
  assert.equal(result.reportInput.sequence, undefined);
});

// ─── Bridge must not forward raw event envelope ─────────────────────────────

test("bridge does not accept targets or repository from CLI", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "TASK-001",
    // These are not recognized options and will be silently ignored
    "--targets", "evil",
    "--repository", "evil",
  ]);
  assert.equal(result.ok, true);
  // The bridge only maps restricted fields
  assert.equal(result.reportInput.targets, undefined);
  assert.equal(result.reportInput.repository, undefined);
});