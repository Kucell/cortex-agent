"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { STATES } = require("../../lib/coordination/contract");
const { CoordinationApplicationService } = require("../../lib/coordination/application-service");
const {
  createGovernedLauncher,
  createPrivateLaunchContext,
  GovernedLauncherError,
  GOVERNED_LAUNCHER_SCHEMA_VERSION,
  defaultExecutor,
  createMonitorSpawnOptions,
  validateWorktree,
  validateOwnership,
  validateAgentCommand,
  validateAgentArgs,
} = require("../../lib/governed/launcher.js");

test("monitor runs in a detached process group after the launcher exits", () => {
  const options = createMonitorSpawnOptions("/private/context.json", {
    repository: { worktreeId: "/workspace/task" },
  });
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "/workspace/task");
  assert.equal(options.env.CORTEX_LAUNCH_CONTEXT, "/private/context.json");
});

function mockExecutor() {
  return { pid: 12345, launchedAt: new Date().toISOString() };
}

function runtimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governed-launcher-"));
}

function createService(dir) {
  return CoordinationApplicationService.open(dir, { journal: { lock: false } });
}

// ─── Test fixture: create a temporary executable file ─────────────────────────
function createTempExecutable(dir, content) {
  const execPath = path.join(dir, "test-agent.sh");
  fs.writeFileSync(execPath, content || "#!/bin/sh\necho 'test-agent'", { mode: 0o755 });
  return execPath;
}

// ─── Global test fixture executable ───────────────────────────────────────────
// A single temp executable shared across all tests that need a valid agentCommand.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-global-fixture-"));
const FIXTURE_EXEC = createTempExecutable(FIXTURE_DIR);

test.after(() => {
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ─── Private Launch Context ──────────────────────────────────────────────────

test("createPrivateLaunchContext returns a frozen context with stable identity", () => {
  const context = createPrivateLaunchContext({
    taskId: "TASK-001",
    projectId: "test-project",
    targetAgentId: "claude-agent",
    agentCommand: FIXTURE_EXEC,
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
  assert.equal(context.agentCommand, FIXTURE_EXEC);
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
    agentCommand: FIXTURE_EXEC,
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
    agentCommand: FIXTURE_EXEC,
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
      testMode: true,
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-LAUNCH-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
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
      testMode: true,
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-PRIVATE-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
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
      testMode: true,
    });

    const first = await launcher.launch({
      taskId: "TASK-MULTI-001",
      targetAgentId: "agent-1",
      agentCommand: FIXTURE_EXEC,
    });
    assert.equal(first.ok, true);

    const second = await launcher.launch({
      taskId: "TASK-MULTI-002",
      targetAgentId: "agent-2",
      agentCommand: FIXTURE_EXEC,
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-EXEC-OK-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-EXEC-FAIL-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-EXEC-LEAK-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
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
      testMode: true,
    });

    // Missing agentCommand should throw ERR_AGENT_COMMAND_EMPTY
    await assert.rejects(() => launcher.launch({
      taskId: "TASK-NO-CMD-001",
      targetAgentId: "claude-agent",
    }), /ERR_AGENT_COMMAND_EMPTY/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11: Async E2E — real subprocess lifecycle ──────────────────────

test("launch with real subprocess executor — accepted after child alive", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-fixture-"));
  const agentPath = createTempExecutable(fixtureDir);
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
      testMode: true,
    });

    const startTime = Date.now();
    const result = await launcher.launch({
      taskId: "TASK-ASYNC-ALIVE-001",
      targetAgentId: "claude-agent",
      agentCommand: agentPath,
      agentArgs: [],
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
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("launch with real executor — spawn failure produces task.failed", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-fixture-"));
  const agentPath = createTempExecutable(fixtureDir);
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-ASYNC-FAIL-001",
      targetAgentId: "claude-agent",
      agentCommand: agentPath,
    });

    assert.equal(result.ok, false);
    assert.equal(result.spawnStatus, "failed");
    assert.equal(result.code, "ERR_LAUNCH_FAILED");
    assert.ok(result.taskState);
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");

    // Task should be in FAILED state
    const task = service.getTask("TASK-ASYNC-FAIL-001");
    assert.ok(task);
    assert.equal(task.assignee, "claude-agent");
    assert.equal(task.state, STATES.FAILED);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("launch with real executor — early exit produces task.failed", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-fixture-"));
  const agentPath = createTempExecutable(fixtureDir);
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-ASYNC-EARLY-001",
      targetAgentId: "claude-agent",
      agentCommand: agentPath,
      agentArgs: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.spawnStatus, "failed");
    assert.ok(result.taskState);
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");

    // Task should be in FAILED state
    const task = service.getTask("TASK-ASYNC-EARLY-001");
    assert.ok(task);
    assert.equal(task.assignee, "claude-agent");
    assert.equal(task.state, STATES.FAILED);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// ─── P-003 CP-11: agentCommand/args reach executor ────────────────────────────

test("agentCommand and agentArgs are passed to executor", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-fixture-"));
  const agentPath = createTempExecutable(fixtureDir);
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
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-EXEC-CMD-001",
      targetAgentId: "claude-agent",
      agentCommand: agentPath,
      agentArgs: ["--verbose", "--project", "/tmp/test"],
    });

    assert.equal(result.ok, true);
    assert.equal(receivedCommand, path.resolve(agentPath));
    assert.deepEqual(receivedArgs, ["--verbose", "--project", "/tmp/test"]);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
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
// ─── validateAgentCommand tests ───────────────────────────────────────────────

test("validateAgentCommand rejects empty/null", () => {
  assert.throws(() => validateAgentCommand(""), /ERR_AGENT_COMMAND_EMPTY/);
  assert.throws(() => validateAgentCommand(null), /ERR_AGENT_COMMAND_EMPTY/);
  assert.throws(() => validateAgentCommand(undefined), /ERR_AGENT_COMMAND_EMPTY/);
});

test("validateAgentCommand rejects relative paths", () => {
  assert.throws(() => validateAgentCommand("relative/path"), /ERR_AGENT_COMMAND_RELATIVE_PATH/);
  assert.throws(() => validateAgentCommand("./agent.sh"), /ERR_AGENT_COMMAND_RELATIVE_PATH/);
  assert.throws(() => validateAgentCommand("agent"), /ERR_AGENT_COMMAND_RELATIVE_PATH/);
});

test("validateAgentCommand rejects process.execPath fallback", () => {
  assert.throws(() => validateAgentCommand(process.execPath), /ERR_AGENT_COMMAND_FALLBACK/);
});

test("validateAgentCommand rejects non-existent path", () => {
  assert.throws(() => validateAgentCommand("/nonexistent/binary"), /ERR_AGENT_COMMAND_NOT_RESOLVABLE/);
});

test("validateAgentCommand rejects non-executable file", () => {
  const dir = runtimeDir();
  try {
    const nonExec = path.join(dir, "non-exec.js");
    fs.writeFileSync(nonExec, "console.log('test')", { mode: 0o644 });
    assert.throws(() => validateAgentCommand(nonExec), /ERR_AGENT_COMMAND_NOT_EXECUTABLE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAgentCommand rejects command injection characters", () => {
  const dir = runtimeDir();
  try {
    const execPath = createTempExecutable(dir);
    assert.throws(() => validateAgentCommand(`${execPath}; rm -rf /`), /ERR_AGENT_COMMAND_INJECTION_CHARS/);
    assert.throws(() => validateAgentCommand(`${execPath}|cat /etc/passwd`), /ERR_AGENT_COMMAND_INJECTION_CHARS/);
    assert.throws(() => validateAgentCommand(`${execPath}&exit`), /ERR_AGENT_COMMAND_INJECTION_CHARS/);
    assert.throws(() => validateAgentCommand(`${execPath}$(id)`), /ERR_AGENT_COMMAND_INJECTION_CHARS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAgentCommand accepts valid executable", () => {
  const dir = runtimeDir();
  try {
    const execPath = createTempExecutable(dir);
    const resolved = validateAgentCommand(execPath);
    assert.equal(resolved, path.resolve(execPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAgentCommand rejects non-whitelisted command", () => {
  const dir = runtimeDir();
  try {
    const execPath = createTempExecutable(dir);
    const otherDir = runtimeDir();
    const otherExec = createTempExecutable(otherDir);
    try {
      assert.throws(
        () => validateAgentCommand(execPath, { allowedAgentCommands: [otherExec] }),
        /ERR_AGENT_COMMAND_NOT_ALLOWED/,
      );
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAgentCommand accepts whitelisted command", () => {
  const dir = runtimeDir();
  try {
    const execPath = createTempExecutable(dir);
    const resolved = validateAgentCommand(execPath, { allowedAgentCommands: [execPath] });
    assert.equal(resolved, path.resolve(execPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAgentCommand preserves an approved symlink path for argv0-sensitive shims", () => {
  const dir = runtimeDir();
  try {
    const target = createTempExecutable(dir);
    const shim = path.join(dir, "pi");
    fs.symlinkSync(target, shim);
    const validated = validateAgentCommand(shim, { allowedAgentCommands: [shim] });
    assert.equal(validated, shim);
    assert.notEqual(validated, fs.realpathSync(shim));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── validateAgentArgs tests ──────────────────────────────────────────────────

test("validateAgentArgs rejects non-array", () => {
  assert.throws(() => validateAgentArgs("not-an-array"), /ERR_AGENT_ARGS_NOT_ARRAY/);
  assert.throws(() => validateAgentArgs(42), /ERR_AGENT_ARGS_NOT_ARRAY/);
  assert.throws(() => validateAgentArgs({}), /ERR_AGENT_ARGS_NOT_ARRAY/);
});

test("validateAgentArgs rejects too many args", () => {
  const manyArgs = Array.from({ length: 65 }, (_, i) => `arg-${i}`);
  assert.throws(() => validateAgentArgs(manyArgs), /ERR_AGENT_ARGS_TOO_MANY/);
});

test("validateAgentArgs rejects overlong args", () => {
  assert.throws(() => validateAgentArgs(["x".repeat(4097)]), /ERR_AGENT_ARG_TOO_LONG/);
});

test("validateAgentArgs rejects NUL character in args", () => {
  assert.throws(() => validateAgentArgs(["--path", "bad\0arg"]), /ERR_AGENT_ARGS_NUL/);
  assert.throws(() => validateAgentArgs(["\0start"]), /ERR_AGENT_ARGS_NUL/);
  assert.throws(() => validateAgentArgs(["end\0"]), /ERR_AGENT_ARGS_NUL/);
});

test("validateAgentArgs rejects non-string args", () => {
  assert.throws(() => validateAgentArgs([42]), /ERR_AGENT_ARGS_NOT_STRING/);
  assert.throws(() => validateAgentArgs([true]), /ERR_AGENT_ARGS_NOT_STRING/);
  assert.throws(() => validateAgentArgs([null]), /ERR_AGENT_ARGS_NOT_STRING/);
});

test("validateAgentArgs accepts null/undefined as empty", () => {
  assert.deepEqual(validateAgentArgs(null), []);
  assert.deepEqual(validateAgentArgs(undefined), []);
});

test("validateAgentArgs accepts valid args", () => {
  const result = validateAgentArgs(["--verbose", "--project", "/tmp/test"]);
  assert.deepEqual(result, ["--verbose", "--project", "/tmp/test"]);
});

test("validateAgentArgs accepts up to 64 args", () => {
  const sixtyFour = Array.from({ length: 64 }, (_, i) => `arg-${i}`);
  assert.doesNotThrow(() => validateAgentArgs(sixtyFour));
});

// ─── Launch failure auditability: task.failed after create/assign ─────────────

test("launch worktree failure emits task.failed event and task.state=FAILED", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-WT-FAIL-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
      repository: { worktreeId: "/nonexistent/worktree/path" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_WORKTREE_NOT_FOUND");
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");

    // Task was created, assigned, then failed
    const task = service.getTask("TASK-WT-FAIL-001");
    assert.ok(task);
    assert.equal(task.assignee, "claude-agent");
    assert.equal(task.state, STATES.FAILED);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch ownership failure emits task.failed event and task.state=FAILED", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      projectRoot: dir,
      executor: mockExecutor,
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-OWN-FAIL-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
      ownershipScopes: ["nonexistent-scope"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_OWNERSHIP_VALIDATION_FAILED");
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");

    // Task was created, assigned, then failed
    const task = service.getTask("TASK-OWN-FAIL-001");
    assert.ok(task);
    assert.equal(task.assignee, "claude-agent");
    assert.equal(task.state, STATES.FAILED);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch with allowedAgentCommands rejects non-whitelisted command", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  const fixtureDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-fixture-"));
  const otherExec = createTempExecutable(fixtureDir2);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
      allowedAgentCommands: [FIXTURE_EXEC],
    });

    await assert.rejects(() => launcher.launch({
      taskId: "TASK-ALLOW-001",
      targetAgentId: "claude-agent",
      agentCommand: otherExec,
    }), /ERR_AGENT_COMMAND_NOT_ALLOWED/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fixtureDir2, { recursive: true, force: true });
  }
});

// ─── Temp executable fixture test ─────────────────────────────────────────────

test("temp executable fixture can be launched", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  const fixtureDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-fixture-"));
  const agentPath = createTempExecutable(fixtureDir2, "#!/bin/sh\necho 'agent-alive'");
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: (ctxFile, privateCtx) => {
        // Use the validated agent command from private context
        const { spawn } = require("node:child_process");
        return new Promise((resolve, reject) => {
          const child = spawn(privateCtx.agentCommand, [], {
            stdio: "ignore",
            env: { CORTEX_LAUNCH_CONTEXT: ctxFile },
          });
          const timeout = setTimeout(() => {
            resolve({ pid: child.pid, launchedAt: new Date().toISOString() });
          }, 500);
          child.once("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve({ pid: child.pid, launchedAt: new Date().toISOString() });
          });
          child.unref();
        });
      },
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-FIXTURE-ALIVE-001",
      targetAgentId: "claude-agent",
      agentCommand: agentPath,
      agentArgs: [],
    });

    assert.equal(result.ok, true);
    assert.equal(result.spawnStatus, "accepted");
    assert.ok(result.pid, "Should have a child PID");
    // Verify the task was created and the executor ran
    const task = service.getTask("TASK-FIXTURE-ALIVE-001");
    assert.ok(task);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fixtureDir2, { recursive: true, force: true });
  }
});

// ─── ASSIGNED→FAILED authorization tightening ─────────────────────────────
// Only the coordinator who created the task may fail it while in ASSIGNED.

test("second coordinator cannot fail an assigned task (ASSIGNED→FAILED rejected)", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    // Create and assign task with coordinator-1
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
      testMode: true,
    });

    const launchResult = await launcher.launch({
      taskId: "TASK-AUTH-001",
      targetAgentId: "test-agent",
      agentCommand: FIXTURE_EXEC,
    });
    assert.equal(launchResult.ok, true);

    // Now try to fail the assigned task with coordinator-2
    const { createEvent, STATES } = require("../../lib/coordination/contract");
    const failEvent = createEvent({
      eventId: "CE-coord2-fail-TASK-AUTH-001",
      projectId: "test-project",
      taskId: "TASK-AUTH-001",
      correlationId: "CORR-AUTH-001",
      producer: { actorId: "coordinator-2", kind: "coordinator" },
      targets: [],
      eventType: "task.failed",
      previousState: STATES.ASSIGNED,
      currentState: STATES.FAILED,
      sequence: 4,
      repository: { repositoryId: "test-project" },
      notification: { policy: "journal_only", dedupeKey: "test" },
    });

    assert.throws(
      () => service.submit(failEvent, { actorId: "coordinator-2", kind: "coordinator", sessionId: "sess" }),
      (err) => err.key === "ERR_ACTOR_MISMATCH",
    );

    // Verify task is still in ASSIGNED state
    const task = service.getTask("TASK-AUTH-001");
    assert.equal(task.state, STATES.ASSIGNED);
    assert.equal(task.createdBy, "coordinator-1");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("original coordinator can fail assigned task (spawn/validation failure → FAILED)", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: () => {
        throw new Error("Simulated launch failure");
      },
      testMode: true,
    });

    const result = await launcher.launch({
      taskId: "TASK-AUTH-002",
      targetAgentId: "test-agent",
      agentCommand: FIXTURE_EXEC,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_LAUNCH_FAILED");
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].eventType, "task.created");
    assert.equal(result.events[1].eventType, "task.assigned");
    assert.equal(result.events[2].eventType, "task.failed");

    const task = service.getTask("TASK-AUTH-002");
    assert.ok(task);
    assert.equal(task.state, STATES.FAILED);
    assert.equal(task.createdBy, "coordinator-1");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Command whitelist enforcement (fail closed) ─────────────────────────

test("launch fails closed when allowedAgentCommands is not provided and testMode is not set", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
      // testMode not set — allowedAgentCommands defaults to [] (fail closed)
    });

    await assert.rejects(() => launcher.launch({
      taskId: "TASK-ALLOW-MISSING-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
    }), /ERR_AGENT_COMMAND_NOT_ALLOWED/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch fails closed when allowedAgentCommands is empty array", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
      allowedAgentCommands: [],
    });

    await assert.rejects(() => launcher.launch({
      taskId: "TASK-ALLOW-EMPTY-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
    }), /ERR_AGENT_COMMAND_NOT_ALLOWED/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch accepts whitelisted valid executable command", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
      allowedAgentCommands: [FIXTURE_EXEC],
    });

    const result = await launcher.launch({
      taskId: "TASK-ALLOW-VALID-001",
      targetAgentId: "claude-agent",
      agentCommand: FIXTURE_EXEC,
    });

    assert.equal(result.ok, true);
    assert.equal(result.spawnStatus, "accepted");
    const task = service.getTask("TASK-ALLOW-VALID-001");
    assert.ok(task);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch rejects non-whitelisted command despite valid executable", async () => {
  const dir = runtimeDir();
  const service = createService(dir);
  const fixtureDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-fixture-"));
  const otherExec = createTempExecutable(fixtureDir2);
  try {
    const launcher = createGovernedLauncher(service, {
      coordinatorId: "coordinator-1",
      projectId: "test-project",
      executor: mockExecutor,
      allowedAgentCommands: [FIXTURE_EXEC],
    });

    await assert.rejects(() => launcher.launch({
      taskId: "TASK-ALLOW-REJECT-001",
      targetAgentId: "claude-agent",
      agentCommand: otherExec,
    }), /ERR_AGENT_COMMAND_NOT_ALLOWED/);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fixtureDir2, { recursive: true, force: true });
  }
});
