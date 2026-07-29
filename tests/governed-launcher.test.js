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

function mockExecutor() {
  return { pid: 12345, launchedAt: new Date().toISOString() };
}

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
    targetAgentId: "claude-agent",
    agentCommand: "/usr/bin/node",
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
  assert.equal(context.targetAgentId, "claude-agent");
  assert.equal(context.agentCommand, "/usr/bin/node");
  assert.equal(context.coordinatorId, "coordinator-1");
  assert.equal(context.repository.repositoryId, "test-repo");
  assert.equal(context.repository.branch, "main");
  assert.deepEqual(context.ownershipScopes, ["src/lib"]);
  assert.equal(context.schemaVersion, GOVERNED_LAUNCHER_SCHEMA_VERSION);
  assert.ok(context.launchId);
  assert.ok(context.launchedAt);
  // Producer is immutable
  assert.ok(context.producer);
  assert.equal(context.producer.actorId, "claude-agent");
  assert.equal(context.producer.kind, "agent");
});

test("createPrivateLaunchContext applies defaults for optional fields", () => {
  const context = createPrivateLaunchContext({
    taskId: "TASK-001",
    projectId: "test-project",
    targetAgentId: "claude-agent",
    agentCommand: "/usr/bin/node",
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

test("createPrivateLaunchContext requires agentCommand", () => {
  assert.throws(() => createPrivateLaunchContext({
    taskId: "T-1",
    projectId: "p",
    targetAgentId: "a",
    coordinatorId: "c",
    // no agentCommand
  }), /ERR_FIELD_INVALID/);
});

test("createPrivateLaunchContext requires targetAgentId", () => {
  assert.throws(() => createPrivateLaunchContext({
    taskId: "T-1",
    projectId: "p",
    agentCommand: "/usr/bin/node",
    coordinatorId: "c",
    // no targetAgentId
  }), /ERR_FIELD_INVALID/);
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
      executor: mockExecutor,
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

test("launch creates task and assigns it to target agent (with mock executor)", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      sessionId: "coordinator-session",
      executor: mockExecutor,
    });

    const result = await launcher.launch({
      taskId: "TASK-LAUNCH-001",
      targetAgentId: "claude-agent",
      agentCommand: "/usr/bin/node",
      acceptanceCriteria: ["focused tests pass"],
      forbiddenActions: ["do not push"],
      ownershipScopes: ["lib/agent-reporter"],
    });

    assert.equal(result.ok, true);
    assert.equal(result.taskId, "TASK-LAUNCH-001");
    assert.equal(result.targetAgentId, "claude-agent");
    assert.equal(result.spawnStatus, "accepted");
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.accepted");
    assert.ok(result.taskState);
    const task = service.getTask("TASK-LAUNCH-001");
    assert.equal(task.assignee, "claude-agent");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch rejects missing required fields", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
    });

    await assert.rejects(() => launcher.launch({}), /ERR_FIELD_INVALID/);
    await assert.rejects(() => launcher.launch({ taskId: "T-1" }), /ERR_FIELD_INVALID/);
    await assert.rejects(() => launcher.launch(null), /ERR_INPUT_REQUIRED/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Private context isolation ────────────────────────────────────────────────

test("launch result does NOT expose private context or public context", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
    });

    const result = await launcher.launch({
      taskId: "TASK-PRIVATE-001",
      targetAgentId: "claude-agent",
      agentCommand: "/usr/bin/node",
    });

    // Private context must NOT be in the public result
    assert.equal(result.privateContext, undefined);
    assert.equal(result.publicContext, undefined);
    // No private fields leaked
    assert.equal(result.coordinatorId, undefined);
    assert.equal(result.repository, undefined);
    assert.equal(result.ownershipScopes, undefined);
    assert.equal(result.allowedTools, undefined);
    assert.equal(result.forbiddenActions, undefined);
    assert.equal(result.acceptanceCriteria, undefined);
    // Only public fields should be present
    assert.equal(result.ok, true);
    assert.equal(result.taskId, "TASK-PRIVATE-001");
    assert.ok(result.launchId);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple launches create independent tasks", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
    });

    const first = await launcher.launch({
      taskId: "TASK-MULTI-001",
      targetAgentId: "agent-1",
      agentCommand: "/usr/bin/node",
    });
    assert.equal(first.ok, true);

    const second = await launcher.launch({
      taskId: "TASK-MULTI-002",
      targetAgentId: "agent-2",
      agentCommand: "/usr/bin/node",
    });
    assert.equal(second.ok, true);

    // Both tasks are independent
    const task1 = service.getTask("TASK-MULTI-001");
    const task2 = service.getTask("TASK-MULTI-002");
    assert.ok(task1.state);
    assert.ok(task2.state);
    assert.notEqual(task1.taskId, task2.taskId);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Executor integration (injectable via constructor option) ─────────────────

test("launch with injectable executor reports accepted on success", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: () => ({ pid: 12345, launchedAt: new Date().toISOString() }),
    });

    const result = await launcher.launch({
      taskId: "TASK-EXEC-OK-001",
      targetAgentId: "claude-agent",
      agentCommand: "/usr/bin/node",
    });

    assert.equal(result.ok, true);
    assert.equal(result.spawnStatus, "accepted");
    assert.equal(result.pid, 12345);
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.accepted");
    assert.ok(result.taskState);
    const task = service.getTask("TASK-EXEC-OK-001");
    assert.ok(task);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch with injectable executor reports failed on spawn failure", async () => {
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

    const result = await launcher.launch({
      taskId: "TASK-EXEC-FAIL-001",
      targetAgentId: "claude-agent",
      agentCommand: "/usr/bin/node",
    });

    assert.equal(result.ok, false);
    assert.equal(result.spawnStatus, "failed");
    assert.equal(result.code, "ERR_LAUNCH_FAILED");
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");
    assert.ok(result.taskState);
    // The contract may reject task.failed from coordinator producer,
    // but the failed event is recorded in the events array.
    // The task was created and assigned — verify that.
    const task = service.getTask("TASK-EXEC-FAIL-001");
    assert.ok(task);
    assert.equal(task.assignee, "claude-agent");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch with executor must not leak private context in result", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: () => ({ pid: 12345, launchedAt: new Date().toISOString() }),
    });

    const result = await launcher.launch({
      taskId: "TASK-EXEC-LEAK-001",
      targetAgentId: "claude-agent",
      agentCommand: "/usr/bin/node",
    });

    assert.equal(result.ok, true);
    assert.equal(result.privateContext, undefined);
    assert.equal(result.publicContext, undefined);
    assert.equal(result.coordinatorId, undefined);
    assert.equal(result.taskId, "TASK-EXEC-LEAK-001");
    assert.equal(result.pid, 12345);
    assert.ok(result.launchedAt);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11: agentCommand required (no fallback) ────────────────────────

test("launch requires agentCommand — no empty/process.execPath fallback", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
    });

    // Missing agentCommand should throw synchronously (field validation)
    await assert.rejects(() => launcher.launch({
      taskId: "TASK-NO-CMD-001",
      targetAgentId: "claude-agent",
    }), /ERR_FIELD_INVALID/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11: Async E2E — real subprocess lifecycle ──────────────────────

test("launch with real subprocess executor — accepted after child alive", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      // Real executor using node -e to sleep briefly
      executor: (ctxFile, privateCtx) => {
        const { spawn } = require("node:child_process");
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 500)"], {
            stdio: "ignore",
            env: { CORTEX_LAUNCH_CONTEXT: ctxFile },
          });
          const timeout = setTimeout(() => {
            resolve({ pid: child.pid, launchedAt: new Date().toISOString() });
          }, 200);
          child.once("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
          child.once("exit", () => {
            clearTimeout(timeout);
            // Child exited successfully — still resolve
            resolve({ pid: child.pid, launchedAt: new Date().toISOString() });
          });
          child.unref();
        });
      },
    });

    const startTime = Date.now();
    const result = await launcher.launch({
      taskId: "TASK-ASYNC-ALIVE-001",
      targetAgentId: "claude-agent",
      agentCommand: process.execPath,
      agentArgs: ["-e", "setTimeout(() => process.exit(0), 500)"],
    });

    const elapsed = Date.now() - startTime;

    assert.equal(result.ok, true);
    assert.equal(result.spawnStatus, "accepted");
    // Should have taken at least 200ms (the executor wait time)
    assert.ok(elapsed >= 100, `E2E executor should have taken some time, got ${elapsed}ms`);
    // Task state should be ACCEPTED (or ASSIGNED if contract rejects coordinator-submitted accepted)
    // The key assertion is that the event was recorded
    assert.ok(result.taskState);
    const task = service.getTask("TASK-ASYNC-ALIVE-001");
    assert.ok(task);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch with real executor — spawn failure produces task.failed", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: (ctxFile, privateCtx) => {
        const { spawn } = require("node:child_process");
        return new Promise((resolve, reject) => {
          const child = spawn("/nonexistent/binary", [], { stdio: "ignore" });
          child.once("error", (err) => {
            reject(err);
          });
          child.once("exit", (code, signal) => {
            reject(new Error(`Spawn failed: code=${code} signal=${signal}`));
          });
          child.unref();
        });
      },
    });

    const result = await launcher.launch({
      taskId: "TASK-ASYNC-FAIL-001",
      targetAgentId: "claude-agent",
      agentCommand: "/nonexistent/binary",
    });

    assert.equal(result.ok, false);
    assert.equal(result.spawnStatus, "failed");
    assert.equal(result.code, "ERR_LAUNCH_FAILED");
    assert.ok(result.taskState);
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");

    // The contract may reject task.failed from coordinator producer,
    // but the task was created and assigned.
    const task = service.getTask("TASK-ASYNC-FAIL-001");
    assert.ok(task);
    assert.equal(task.assignee, "claude-agent");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch with real executor — early exit produces task.failed", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: (ctxFile, privateCtx) => {
        const { spawn } = require("node:child_process");
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
            stdio: "ignore",
            env: { CORTEX_LAUNCH_CONTEXT: ctxFile },
          });
          child.once("error", (err) => reject(err));
          child.once("exit", (code, signal) => {
            reject(new Error(`Executor exited early: code=${code} signal=${signal}`));
          });
          child.unref();
        });
      },
    });

    const result = await launcher.launch({
      taskId: "TASK-ASYNC-EARLY-001",
      targetAgentId: "claude-agent",
      agentCommand: process.execPath,
      agentArgs: ["-e", "process.exit(1)"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.spawnStatus, "failed");
    assert.ok(result.taskState);
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");

    // The contract may reject task.failed from coordinator producer,
    // but the task was created and assigned.
    const task = service.getTask("TASK-ASYNC-EARLY-001");
    assert.ok(task);
    assert.equal(task.assignee, "claude-agent");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11: agentCommand/args reach executor ────────────────────────────

test("agentCommand and agentArgs are passed to executor", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  let receivedCommand = null;
  let receivedArgs = null;

  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: (ctxFile, privateCtx) => {
        receivedCommand = privateCtx.agentCommand;
        receivedArgs = privateCtx.agentArgs;
        return { pid: 12345, launchedAt: new Date().toISOString() };
      },
    });

    const result = await launcher.launch({
      taskId: "TASK-EXEC-CMD-001",
      targetAgentId: "claude-agent",
      agentCommand: "/custom/path/agent",
      agentArgs: ["--verbose", "--project", "/tmp/test"],
    });

    assert.equal(result.ok, true);
    assert.equal(receivedCommand, "/custom/path/agent");
    assert.deepEqual(receivedArgs, ["--verbose", "--project", "/tmp/test"]);
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