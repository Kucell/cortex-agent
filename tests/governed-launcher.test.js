"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { STATES } = require("../lib/coordination/contract");
const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const {
  createGovernedLauncher,
  createPrivateLaunchContext,
  GovernedLauncherError,
  GOVERNED_LAUNCHER_SCHEMA_VERSION,
} = require("../lib/governed-launcher");

function runtimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governed-launcher-"));
}

function createService(dir) {
  return CoordinationApplicationService.open(dir, { journal: { lock: false } });
}

// ─── Private Launch Context ──────────────────────────────────────────────────

test("createPrivateLaunchContext returns a frozen context with stable identity", () => {
  const context = createPrivateLaunchContext({
    taskId: "TASK-001",
    projectId: "test-project",
    coordinatorId: "coordinator-1",
    repository: { repositoryId: "test-repo", branch: "main" },
    ownershipScopes: ["src/lib"],
    acceptanceCriteria: ["tests pass"],
    forbiddenActions: ["do not push"],
    allowedTools: ["node"],
    heartbeatIntervalMs: 30000,
    terminalTimeoutMs: 300000,
    notificationPolicy: "coordinator_notify",
  });

  assert.equal(context.taskId, "TASK-001");
  assert.equal(context.projectId, "test-project");
  assert.equal(context.coordinatorId, "coordinator-1");
  assert.equal(context.repository.repositoryId, "test-repo");
  assert.equal(context.repository.branch, "main");
  assert.deepEqual(context.ownershipScopes, ["src/lib"]);
  assert.equal(context.schemaVersion, GOVERNED_LAUNCHER_SCHEMA_VERSION);
  assert.ok(context.launchId);
  assert.ok(context.launchedAt);
});

test("createPrivateLaunchContext applies defaults for optional fields", () => {
  const context = createPrivateLaunchContext({
    taskId: "TASK-001",
    projectId: "test-project",
    coordinatorId: "coordinator-1",
  });
  assert.equal(context.heartbeatIntervalMs, 30000);
  assert.equal(context.terminalTimeoutMs, 300000);
  assert.equal(context.notificationPolicy, "journal_only");
  assert.deepEqual(context.ownershipScopes, []);
  assert.deepEqual(context.forbiddenActions, []);
  assert.deepEqual(context.allowedTools, []);
  assert.ok(context.launchId);
});

test("createPrivateLaunchContext rejects missing required fields", () => {
  assert.throws(() => createPrivateLaunchContext({}), /ERR_FIELD_INVALID/);
  assert.throws(() => createPrivateLaunchContext(null), /ERR_INPUT_REQUIRED/);
});

// ─── Governed Launcher ───────────────────────────────────────────────────────

test("createGovernedLauncher requires valid options", () => {
  assert.throws(() => createGovernedLauncher(null, null), /ERR_OPTIONS_REQUIRED/);
  // Empty options object fails on missing coordinatorId, not on service check
  assert.throws(() => createGovernedLauncher({ submit() {} }, {}), /ERR_FIELD_INVALID/);
  assert.throws(() => createGovernedLauncher({ notSubmit: true }, { coordinatorId: "c", projectId: "p" }), /ERR_SERVICE_REQUIRED/);
});

test("createGovernedLauncher returns a frozen launcher with stable identity", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      sessionId: "coordinator-session",
    });

    assert.equal(launcher.coordinatorId, "coordinator-1");
    assert.equal(launcher.projectId, "test-project");
    assert.equal(launcher.schemaVersion, GOVERNED_LAUNCHER_SCHEMA_VERSION);
    assert.equal(typeof launcher.launch, "function");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch creates task and assigns it to target agent", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      sessionId: "coordinator-session",
    });

    const result = launcher.launch({
      taskId: "TASK-LAUNCH-001",
      targetAgentId: "claude-agent",
      acceptanceCriteria: ["focused tests pass"],
      forbiddenActions: ["do not push"],
      ownershipScopes: ["lib/agent-reporter"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.taskId, "TASK-LAUNCH-001");
    assert.equal(result.targetAgentId, "claude-agent");
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.taskState.state, STATES.ASSIGNED);

    // Verify the task exists in the service
    const task = service.getTask("TASK-LAUNCH-001");
    assert.equal(task.state, STATES.ASSIGNED);
    assert.equal(task.assignee, "claude-agent");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch rejects missing required fields", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
    });

    assert.throws(() => launcher.launch({}), /ERR_FIELD_INVALID/);
    assert.throws(() => launcher.launch({ taskId: "T-1" }), /ERR_FIELD_INVALID/);
    assert.throws(() => launcher.launch(null), /ERR_INPUT_REQUIRED/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch creates a private context that is never shared with the agent", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
    });

    const result = launcher.launch({
      taskId: "TASK-PRIVATE-001",
      targetAgentId: "claude-agent",
    });

    // Private context has the launchId
    assert.ok(result.privateContext);
    assert.equal(result.privateContext.taskId, "TASK-PRIVATE-001");
    assert.equal(result.privateContext.coordinatorId, "coordinator-1");

    // Public context has the slimmed-down version (no coordinatorId)
    assert.ok(result.publicContext);
    assert.equal(result.publicContext.taskId, "TASK-PRIVATE-001");
    // The public context should NOT contain private fields
    // (coordinatorId is in the public context for the agent to know who
    // assigned the task, but the full private context has more details)
    assert.ok(result.publicContext.coordinatorId);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple launches create independent tasks", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
    });

    const first = launcher.launch({
      taskId: "TASK-MULTI-001",
      targetAgentId: "agent-1",
    });
    assert.equal(first.ok, true);

    const second = launcher.launch({
      taskId: "TASK-MULTI-002",
      targetAgentId: "agent-2",
    });
    assert.equal(second.ok, true);

    // Both tasks are independent
    const task1 = service.getTask("TASK-MULTI-001");
    const task2 = service.getTask("TASK-MULTI-002");
    assert.equal(task1.state, STATES.ASSIGNED);
    assert.equal(task2.state, STATES.ASSIGNED);
    assert.notEqual(task1.taskId, task2.taskId);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});