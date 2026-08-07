"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CoordinationApplicationService } = require("../../lib/coordination/application-service.js");
const {
  parseBridgeArgs,
  executeBridgeCommand,
  HOST_EVENT_BRIDGE_SCHEMA_VERSION,
} = require("../../lib/coordination/host-event-bridge.js");
const { createEvent, STATES } = require("../../lib/coordination/contract.js");

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

// Helper: set up a CORTEX_LAUNCH_CONTEXT file for bridge tests
function setupContext(taskId, projectId, targetAgentId, coordinatorId) {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bridge-ctx-"));
  const ctxFile = path.join(dir, "context.json");
  const context = {
    taskId: taskId || "TASK-HB-001",
    projectId: projectId || "test-project",
    targetAgentId: targetAgentId || "bridge-agent",
    coordinatorId: coordinatorId || "test-agent",
    launchId: "LAUNCH-HB-001",
  };
  fs.writeFileSync(ctxFile, JSON.stringify(context), { encoding: "utf8", mode: 0o600 });
  process.env.CORTEX_LAUNCH_CONTEXT = ctxFile;
  return { prev, dir, ctxFile };
}

function cleanupContext(prev, dir, ctxFile) {
  if (prev) process.env.CORTEX_LAUNCH_CONTEXT = prev;
  else delete process.env.CORTEX_LAUNCH_CONTEXT;
  try { fs.unlinkSync(ctxFile); } catch (_) {}
  try { fs.rmdirSync(dir); } catch (_) {}
}

// ─── CLI argument parsing ────────────────────────────────────────────────────

test("parseBridgeArgs rejects invalid usage", () => {
  const result = parseBridgeArgs(["unknown", "action"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_USAGE");
});

test("parseBridgeArgs requires --event-type or --action", () => {
  const result = parseBridgeArgs(["agent", "report"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_USAGE");
});

test("parseBridgeArgs rejects non-agent-scoped event types", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.created",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_TYPE_NOT_AGENT_SCOPED");
});

test("parseBridgeArgs accepts a valid agent-scoped report", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--message", "Processing",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.eventType, "task.progress");
  assert.equal(result.reportInput.message, "Processing");
});

test("parseBridgeArgs accepts --action as alias for --event-type", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--action", "task.heartbeat",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.eventType, "task.heartbeat");
});

test("parseBridgeArgs accepts --evidence-ref", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--evidence-ref", "VC-001",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.reportInput.evidence.length, 1);
  assert.equal(result.reportInput.evidence[0].ref, "VC-001");
});

test("parseBridgeArgs accepts --notification-policy", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.failed",
    "--notification-policy", "coordinator_notify",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.reportInput.notificationPolicy, "coordinator_notify");
});

test("parseBridgeArgs accepts --delivery-id", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--delivery-id", "stable-delivery-001",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.reportInput.deliveryId, "stable-delivery-001");
});

// ─── Governance parameter rejection ──────────────────────────────────────────

test("parseBridgeArgs rejects --actor-id as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--actor-id", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
  assert.ok(result.error.message.includes("actor-id"));
});

test("parseBridgeArgs rejects --project-id as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--project-id", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

test("parseBridgeArgs rejects --task-id as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--task-id", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

test("parseBridgeArgs rejects --kind as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--kind", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

test("parseBridgeArgs rejects --session-id as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--session-id", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

test("parseBridgeArgs rejects --correlation-id as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--correlation-id", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

test("parseBridgeArgs rejects --targets as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--targets", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

test("parseBridgeArgs rejects --repository as unknown option", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--repository", "evil",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

// ─── Bridge execution ────────────────────────────────────────────────────────

test("executeBridgeCommand without service returns SERVICE_UNAVAILABLE", () => {
  const result = executeBridgeCommand([
    "agent", "report",
    "--event-type", "task.progress",
  ], {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SERVICE_UNAVAILABLE");
});

test("executeBridgeCommand fails closed without CORTEX_LAUNCH_CONTEXT", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    setupCoordinatorTask(service, "TASK-HB-NOCTX-001");
    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.accepted",
    ], { service });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ERR_NO_GOVERNED_CONTEXT");
  } finally {
    if (prev) process.env.CORTEX_LAUNCH_CONTEXT = prev;
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executeBridgeCommand submits a valid agent-scoped event", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  const ctx = setupContext("TASK-HB-001", "test-project", "bridge-agent", "bridge-agent");
  try {
    setupCoordinatorTask(service, "TASK-HB-001");
    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.accepted",
    ], { service });

    assert.equal(result.ok, true);
    assert.equal(result.command, "agent.report");
    assert.equal(result.eventType, "task.accepted");
    assert.equal(result.taskId, "TASK-HB-001");
    assert.ok(result.event);
    assert.ok(result.task);
  } finally {
    cleanupContext(ctx.prev, ctx.dir, ctx.ctxFile);
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executeBridgeCommand submits progress and heartbeat through the bridge", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  const ctx = setupContext("TASK-HB-002", "test-project", "bridge-agent", "bridge-agent");
  try {
    setupCoordinatorTask(service, "TASK-HB-002");

    const accepted = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.accepted",
    ], { service });
    assert.equal(accepted.ok, true);

    const progress = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.progress",
      "--message", "Working through bridge",
    ], { service });
    assert.equal(progress.ok, true);
    assert.equal(progress.eventType, "task.progress");

    const heartbeat = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.heartbeat",
    ], { service });
    assert.equal(heartbeat.ok, true);
    assert.equal(heartbeat.eventType, "task.heartbeat");
  } finally {
    cleanupContext(ctx.prev, ctx.dir, ctx.ctxFile);
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executeBridgeCommand submits ready_for_review with a schema-valid artifact ref", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  const ctx = setupContext("TASK-HB-READY", "test-project", "bridge-agent", "bridge-agent");
  try {
    setupCoordinatorTask(service, "TASK-HB-READY");
    assert.equal(executeBridgeCommand([
      "agent", "report", "--event-type", "task.accepted",
    ], { service }).ok, true);
    assert.equal(executeBridgeCommand([
      "agent", "report", "--event-type", "task.progress",
    ], { service }).ok, true);
    const ready = executeBridgeCommand([
      "agent", "report", "--event-type", "task.ready_for_review",
      "--evidence-ref", "ARTIFACT-REAL-HOST",
    ], { service });
    assert.equal(ready.ok, true, JSON.stringify(ready));
    assert.equal(ready.task.state, STATES.READY_FOR_REVIEW);
    assert.deepEqual(ready.event.evidence, [{ kind: "artifact", ref: "ARTIFACT-REAL-HOST" }]);
  } finally {
    cleanupContext(ctx.prev, ctx.dir, ctx.ctxFile);
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executeBridgeCommand rejects events whose state machine transition is invalid", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  const ctx = setupContext("TASK-HB-003", "test-project", "bridge-agent", "bridge-agent");
  try {
    setupCoordinatorTask(service, "TASK-HB-003");

    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.ready_for_review",
    ], { service });
    assert.equal(result.ok, false);
  } finally {
    cleanupContext(ctx.prev, ctx.dir, ctx.ctxFile);
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Negative constraints: --event-json is rejected ─────────────────────────

test("bridge rejects --event-json with invalid JSON", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--event-json", "not-json",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_JSON_REJECTED");
});

test("bridge rejects --event-json even with valid JSON", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--event-json", JSON.stringify({ message: "Custom progress update" }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_JSON_REJECTED");
});

test("bridge rejects --event-json with empty object", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--event-json", "{}",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVENT_JSON_REJECTED");
});

// ─── Negative constraints: governance params from CLI are rejected ──────────

test("bridge rejects all unknown governance options", () => {
  const result = parseBridgeArgs([
    "agent", "report",
    "--event-type", "task.progress",
    "--targets", "evil",
    "--repository", "evil",
    "--sequence", "99",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

// ─── Sensitive content rejection ─────────────────────────────────────────────

test("bridge rejects report with sensitive message content", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  const ctx = setupContext("TASK-HB-SENS-001", "test-project", "bridge-agent", "bridge-agent");
  try {
    setupCoordinatorTask(service, "TASK-HB-SENS-001");

    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.progress",
      "--message", "Using API key sk-proj-abc123def456xyz789abcdef",
    ], { service });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ERR_SENSITIVE_DATA_REJECTED");
  } finally {
    cleanupContext(ctx.prev, ctx.dir, ctx.ctxFile);
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Early exit and spawn failure ────────────────────────────────────────────

test("bridge fails closed when context points to invalid file", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    process.env.CORTEX_LAUNCH_CONTEXT = "/nonexistent/path/context.json";

    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.progress",
    ], { service });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ERR_NO_GOVERNED_CONTEXT");
  } finally {
    if (prev) process.env.CORTEX_LAUNCH_CONTEXT = prev;
    else delete process.env.CORTEX_LAUNCH_CONTEXT;
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge fails closed when context file has wrong permissions", () => {
  const prev = process.env.CORTEX_LAUNCH_CONTEXT;
  delete process.env.CORTEX_LAUNCH_CONTEXT;
  const dir = runtimeDir();
  const service = createService(dir);
  const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bridge-mode-"));
  const ctxFile = path.join(ctxDir, "context.json");
  try {
    fs.writeFileSync(ctxFile, JSON.stringify({ taskId: "T-1", projectId: "p", coordinatorId: "c" }), { encoding: "utf8", mode: 0o644 });
    process.env.CORTEX_LAUNCH_CONTEXT = ctxFile;

    const result = executeBridgeCommand([
      "agent", "report",
      "--event-type", "task.progress",
    ], { service });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "ERR_NO_GOVERNED_CONTEXT");
  } finally {
    if (prev) process.env.CORTEX_LAUNCH_CONTEXT = prev;
    else delete process.env.CORTEX_LAUNCH_CONTEXT;
    try { fs.unlinkSync(ctxFile); } catch (_) {}
    try { fs.rmdirSync(ctxDir); } catch (_) {}
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
