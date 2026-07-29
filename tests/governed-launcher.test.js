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
  defaultExecutor,
  validateWorktree,
  validateOwnership,
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

// ─── Governed Launcher (no executor) ─────────────────────────────────────────

test("createGovernedLauncher requires valid options", () => {
  assert.throws(() => createGovernedLauncher(null, null), /ERR_OPTIONS_REQUIRED/);
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

test("launch creates task and assigns it to target agent (no executor)", () => {
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
    assert.equal(result.spawnStatus, "no_spawn");
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

// ─── Private context isolation ────────────────────────────────────────────────

test("launch result does NOT expose private context or public context", () => {
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

    // Private context must NOT be in the public result
    assert.equal(result.privateContext, undefined);
    // Public context must NOT be in the public result
    assert.equal(result.publicContext, undefined);
    // No private fields leaked
    assert.equal(result.coordinatorId, undefined);
    assert.equal(result.launchedAt, undefined);
    assert.equal(result.repository, undefined);
    assert.equal(result.ownershipScopes, undefined);
    assert.equal(result.allowedTools, undefined);
    assert.equal(result.forbiddenActions, undefined);
    assert.equal(result.acceptanceCriteria, undefined);
    // Only public fields should be present
    assert.equal(result.ok, true);
    assert.equal(result.taskId, "TASK-PRIVATE-001");
    assert.equal(result.launchId, "LAUNCH-TASK-PRIVATE-001-" + result.launchId.split("-").pop());
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

// ─── Executor integration (injectable via constructor option) ─────────────────

test("launch with injectable executor reports accepted on success", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: () => ({ pid: 12345, launchedAt: new Date().toISOString() }),
    });

    const result = launcher.launch({
      taskId: "TASK-EXEC-OK-001",
      targetAgentId: "claude-agent",
    });

    assert.equal(result.ok, true);
    assert.equal(result.spawnStatus, "accepted");
    assert.equal(result.pid, 12345);
    // Should have 2 events: created, assigned (accepted is submitted by the agent)
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    // Task stays in ASSIGNED state — the agent reports accepted via reporter
    assert.equal(result.taskState.state, STATES.ASSIGNED);
    const task = service.getTask("TASK-EXEC-OK-001");
    assert.equal(task.state, STATES.ASSIGNED);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch with injectable executor reports failed on spawn failure", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: () => {
        throw new Error("Executor binary not found");
      },
    });

    const result = launcher.launch({
      taskId: "TASK-EXEC-FAIL-001",
      targetAgentId: "claude-agent",
    });

    assert.equal(result.ok, false);
    assert.equal(result.spawnStatus, "failed");
    assert.equal(result.code, "ERR_LAUNCH_FAILED");
    // Should have 2 events: created, assigned (failed is not submitted by the coordinator)
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    // Task stays in ASSIGNED state — the launcher cannot submit task.failed
    // (owner-scoped events are restricted to the assignee)
    const task = service.getTask("TASK-EXEC-FAIL-001");
    assert.equal(task.state, STATES.ASSIGNED);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch with executor must not leak private context in result", () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: () => ({ pid: 12345, launchedAt: new Date().toISOString() }),
    });

    const result = launcher.launch({
      taskId: "TASK-EXEC-LEAK-001",
      targetAgentId: "claude-agent",
    });

    assert.equal(result.ok, true);
    // Private context must not be in the result
    assert.equal(result.privateContext, undefined);
    assert.equal(result.publicContext, undefined);
    // No command, session, token, or absolute path leaked
    assert.equal(result.coordinatorId, undefined);
    // Only public fields from the executor result
    assert.equal(result.taskId, "TASK-EXEC-LEAK-001");
    assert.equal(result.pid, 12345);
    assert.ok(result.launchedAt);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Worktree validation ─────────────────────────────────────────────────────

test("validateWorktree returns true for empty worktreeId", () => {
  assert.equal(validateWorktree(null), true);
  assert.equal(validateWorktree(undefined), true);
  assert.equal(validateWorktree(""), true);
});

test("validateWorktree returns true for existing paths", () => {
  // Current directory always exists
  assert.equal(validateWorktree(process.cwd()), true);
});

// ─── Ownership validation ────────────────────────────────────────────────────

test("validateOwnership returns true for empty scopes", () => {
  assert.equal(validateOwnership([], "/tmp"), true);
  assert.equal(validateOwnership(null, "/tmp"), true);
  assert.equal(validateOwnership(undefined, "/tmp"), true);
});

test("validateOwnership returns true for existing scopes", () => {
  const dir = runtimeDir();
  try {
    fs.mkdirSync(path.join(dir, "test-scope"), { recursive: true });
    assert.equal(validateOwnership(["test-scope"], dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateOwnership throws for missing scopes", () => {
  const dir = runtimeDir();
  try {
    assert.throws(
      () => validateOwnership(["nonexistent-scope"], dir),
      /ERR_OWNERSHIP_SCOPE_MISSING/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});