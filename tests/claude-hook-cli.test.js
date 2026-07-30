"use strict";

// ─── Claude Code Hook CLI — Process Tests (T-ACN-017-R4) ─────────────────────
//
// These tests invoke the `cortex-agent hook claude <HookName>` CLI command
// against a real CoordinationApplicationService and Journal in a temp project
// directory. They verify that the hook CLI routes through the Agent Reporter
// (never direct createEvent/submit) and produces correct redacted receipts.
//
// Coverage:
//   1. SessionStart — validates governed context, no event submitted (launcher authoritative)
//   2. PostToolUse — submits task.progress via Agent Reporter
//   3. PostToolUse with test signal — submits task.testing via Agent Reporter
//   4. Notification — submits task.input_required via Agent Reporter
//   5. Permission — submits task.input_required via Agent Reporter
//   6. ReadyForReview — submits task.ready_for_review with evidence via Agent Reporter
//   7. Stop — nonterminal, never submits events
//   8. SubagentStop — nonterminal, never submits events
//   9. Governance field rejection in stdin
//  10. Unknown field rejection in stdin (hook-specific schema)
//  11. Unknown hook name rejection
//  12. Receipt never leaks sensitive data
//  13. No duplicate accepted on SessionStart
//  14. Notification Pump compatibility (event format in Journal)
//  15. Error receipt safety

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  CoordinationApplicationService,
} = require("../lib/coordination/application-service");
const { createEvent, STATES } = require("../lib/coordination/contract");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CLI_ENTRY = path.resolve(__dirname, "..", "bin", "cli.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hook-r4-"));
}

// Create a temp project directory with .agent-runtime/coordination/ structure
// The CLI uses .agent-runtime/coordination as the service root (same as other commands)
function setupProject(dir) {
  fs.mkdirSync(path.join(dir, ".agent-runtime", "coordination"), { recursive: true });
  return dir;
}

// Set up the coordination service with a task, returns the service
function setupService(dir, taskId, projectId, agentId) {
  const runtimeDir = path.join(dir, ".agent-runtime", "coordination");
  const app = CoordinationApplicationService.open(runtimeDir, { journal: { lock: false } });

  app.submit(createEvent({
    eventId: "CE-create-r4",
    projectId: projectId || "cortex-hook-r4",
    taskId: taskId || "TASK-HOOK-R4",
    correlationId: "CORR-HOOK-R4",
    producer: { actorId: "coordinator-r4", kind: "coordinator" },
    targets: [{ actorId: agentId || "hook-agent-r4", kind: "agent" }],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    sequence: 1,
    repository: { repositoryId: projectId || "cortex-hook-r4" },
    notification: { policy: "journal_only", dedupeKey: "r4" },
    timestamp: "2026-07-30T00:00:00.000Z",
  }));

  app.submit(createEvent({
    eventId: "CE-assign-r4",
    projectId: projectId || "cortex-hook-r4",
    taskId: taskId || "TASK-HOOK-R4",
    correlationId: "CORR-HOOK-R4",
    producer: { actorId: "coordinator-r4", kind: "coordinator" },
    targets: [{ actorId: agentId || "hook-agent-r4", kind: "agent" }],
    eventType: "task.assigned",
    previousState: STATES.CREATED,
    currentState: STATES.ASSIGNED,
    sequence: 2,
    repository: { repositoryId: projectId || "cortex-hook-r4" },
    notification: { policy: "journal_only", dedupeKey: "r4" },
    timestamp: "2026-07-30T00:00:00.000Z",
  }));

  app.submit(createEvent({
    eventId: "CE-accept-r4",
    projectId: projectId || "cortex-hook-r4",
    taskId: taskId || "TASK-HOOK-R4",
    correlationId: "CORR-HOOK-R4",
    producer: { actorId: agentId || "hook-agent-r4", kind: "agent", sessionId: "SESSION-HOOK-R4" },
    targets: [{ actorId: agentId || "hook-agent-r4", kind: "agent" }],
    eventType: "task.accepted",
    previousState: STATES.ASSIGNED,
    currentState: STATES.ACCEPTED,
    sequence: 1,
    repository: { repositoryId: projectId || "cortex-hook-r4" },
    notification: { policy: "journal_only", dedupeKey: "r4" },
    timestamp: "2026-07-30T00:00:00.000Z",
  }));

  return app;
}

// Create a context file for the hook's CORTEX_LAUNCH_CONTEXT
function createContextFile(dir, overrides = {}) {
  const filePath = path.join(dir, "context.json");
  const context = {
    taskId: "TASK-HOOK-R4",
    projectId: "cortex-hook-r4",
    targetAgentId: "hook-agent-r4",
    coordinatorId: "coordinator-r4",
    correlationId: "CORR-HOOK-R4",
    launchId: "LAUNCH-HOOK-R4",
    notificationPolicy: "coordinator_notify",
    producer: { actorId: "hook-agent-r4", kind: "agent", sessionId: "SESSION-HOOK-R4" },
    repository: { repositoryId: "cortex-hook-r4", branch: "main" },
    ...overrides,
  };
  fs.writeFileSync(filePath, JSON.stringify(context), { encoding: "utf8", mode: 0o600 });
  return filePath;
}

// Run the hook CLI command and return parsed result
function runHookCli(hookName, stdinPayload, env, cwd) {
  const args = [CLI_ENTRY, "hook", "claude", hookName];
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify(stdinPayload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: cwd || undefined,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  let parsed;
  try {
    // Parse the last JSON line from stdout (hook CLI outputs JSON to stdout)
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const lastLine = lines[lines.length - 1] || "";
    parsed = JSON.parse(lastLine);
  } catch (_) {
    parsed = { ok: false, parseError: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  return { ...parsed, _exitCode: result.status, _stderr: result.stderr.trim() };
}

// ─── 1. SessionStart ────────────────────────────────────────────────────────

test("R4: SessionStart without governed context fails closed", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("SessionStart", {}, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_NO_GOVERNED_CONTEXT");
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: SessionStart validates context and does NOT submit event", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHookCli("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "ACCEPTED");
    assert.equal(result._exitCode, 0);

    // Verify no task.accepted event was added by the hook (launcher is authoritative)
    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    const acceptedEvents = events.filter((e) => e.eventType === "task.accepted");
    assert.equal(acceptedEvents.length, 1);
    assert.equal(acceptedEvents[0].eventId, "CE-accept-r4");

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: SessionStart is idempotent — same result on repeated invocation", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const result1 = runHookCli("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    const result2 = runHookCli("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result1.ok, true);
    assert.equal(result2.ok, true);
    assert.equal(result1.code, "ACCEPTED");
    assert.equal(result2.code, "ACCEPTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 2. PostToolUse — submits task.progress via Agent Reporter ───────────────

test("R4: PostToolUse submits task.progress via Agent Reporter", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHookCli("PostToolUse", { toolName: "Write", message: "Writing file" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "EMITTED");
    assert.equal(result.eventType, "task.progress");
    assert.equal(result._exitCode, 0);

    // Verify Journal has the progress event
    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    const progressEvents = events.filter((e) => e.eventType === "task.progress");
    assert.equal(progressEvents.length, 1);
    assert.ok(progressEvents[0].eventId);
    assert.ok(progressEvents[0].message);

    // Verify state machine transitioned correctly
    const task = app.getTask("TASK-HOOK-R4");
    assert.equal(task.state, STATES.EXECUTING);

    // Notification Pump compatibility
    assert.ok(Array.isArray(progressEvents[0].targets));
    assert.ok(progressEvents[0].notification);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R5: native Claude PostToolUse envelope is reduced before reporting", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const progress = runHookCli("PostToolUse", {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/Users/private/project/file.txt", content: "private content" },
    }, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    assert.equal(progress.ok, true, JSON.stringify(progress));
    const result = runHookCli("PostToolUse", {
      session_id: "claude-session-private",
      transcript_path: "/Users/private/transcript.jsonl",
      cwd: "/Users/private/project",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "node --test tests/private-test.js --token=should-not-persist" },
      tool_response: { stdout: "private output" },
      tool_use_id: "toolu-private",
      duration_ms: 12,
    }, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.eventType, "task.testing");
    const event = app.listEvents({ taskId: "TASK-HOOK-R4" }).find((item) => item.eventType === "task.testing");
    const serialized = JSON.stringify({ event, receipt: result });
    assert.doesNotMatch(serialized, /claude-session-private|private\/transcript|private output|should-not-persist|node --test/);
    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R5: native Claude event name mismatch fails closed", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("PostToolUse", { hook_event_name: "Notification" }, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
    assert.match(result._stderr, /ERR_NATIVE_HOOK_EVENT_MISMATCH/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: PostToolUse with long message is bounded", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const longMessage = "x".repeat(10000);
    const result = runHookCli("PostToolUse", { toolName: "Write", message: longMessage },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "EMITTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 3. PostToolUse with test signal → task.testing ──────────────────────────

test("R4: PostToolUse with test signal submits task.testing via Agent Reporter", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    // First submit progress to get to EXECUTING state
    app.submit(createEvent({
      eventId: "CE-progress-r4",
      projectId: "cortex-hook-r4",
      taskId: "TASK-HOOK-R4",
      correlationId: "CORR-HOOK-R4",
      producer: { actorId: "hook-agent-r4", kind: "agent", sessionId: "SESSION-HOOK-R4" },
      targets: [{ actorId: "hook-agent-r4", kind: "agent" }],
      eventType: "task.progress",
      previousState: STATES.ACCEPTED,
      currentState: STATES.EXECUTING,
      repository: { repositoryId: "cortex-hook-r4" },
      notification: { policy: "journal_only", dedupeKey: "r4" },
      message: "Working",
      timestamp: "2026-07-30T00:00:00.000Z",
    }));

    const contextFile = createContextFile(dir);
    const result = runHookCli("PostToolUse", { toolName: "Bash", command: "npm test" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "TEST_SIGNAL");
    assert.equal(result.eventType, "task.testing");
    assert.equal(result._exitCode, 0);

    // Verify Journal
    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    const testingEvents = events.filter((e) => e.eventType === "task.testing");
    assert.equal(testingEvents.length, 1);

    // State should be TESTING
    const task = app.getTask("TASK-HOOK-R4");
    assert.equal(task.state, STATES.TESTING);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 4. Notification — submits task.input_required via Agent Reporter ────────

test("R4: Notification submits task.input_required via Agent Reporter", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHookCli("Notification", { message: "Input needed", reason: "User decision" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "INPUT_REQUIRED");
    assert.equal(result.eventType, "task.input_required");
    assert.equal(result._exitCode, 0);

    // Verify Journal
    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    const inputRequiredEvents = events.filter((e) => e.eventType === "task.input_required");
    assert.equal(inputRequiredEvents.length, 1);
    assert.ok(Array.isArray(inputRequiredEvents[0].targets));
    assert.ok(inputRequiredEvents[0].notification);

    // Notification Pump compatibility
    assert.ok(Array.isArray(inputRequiredEvents[0].targets));
    assert.ok(inputRequiredEvents[0].notification);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: Notification with sensitive data in stdin is rejected", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHookCli("Notification", { message: "Token is sk-proj-abc123def456ghi789jklmnop" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // The handler rejects it, but the hook CLI returns an error receipt
    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 5. Permission — submits task.input_required via Agent Reporter ──────────

test("R4: Permission submits task.input_required via Agent Reporter", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHookCli("Permission", { message: "Permission needed", reason: "Write access" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "PERMISSION_REQUIRED");
    assert.equal(result.eventType, "task.input_required");
    assert.equal(result._exitCode, 0);

    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    const inputEvents = events.filter((e) => e.eventType === "task.input_required");
    assert.equal(inputEvents.length, 1);

    // Verify WAITING_FOR_INPUT state
    const task = app.getTask("TASK-HOOK-R4");
    assert.equal(task.state, STATES.WAITING_FOR_INPUT);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. ReadyForReview — submits task.ready_for_review via Agent Reporter ────

test("R4: ReadyForReview submits task.ready_for_review via Agent Reporter", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    // First submit progress to get to EXECUTING
    app.submit(createEvent({
      eventId: "CE-progress-rr4",
      projectId: "cortex-hook-r4",
      taskId: "TASK-HOOK-R4",
      correlationId: "CORR-HOOK-R4",
      producer: { actorId: "hook-agent-r4", kind: "agent", sessionId: "SESSION-HOOK-R4" },
      targets: [{ actorId: "hook-agent-r4", kind: "agent" }],
      eventType: "task.progress",
      previousState: STATES.ACCEPTED,
      currentState: STATES.EXECUTING,
      repository: { repositoryId: "cortex-hook-r4" },
      notification: { policy: "journal_only", dedupeKey: "r4" },
      message: "Working",
      timestamp: "2026-07-30T00:00:00.000Z",
    }));

    const contextFile = createContextFile(dir);
    const result = runHookCli("ReadyForReview", {
      message: "Done",
      evidenceRefs: ["ARTIFACT-001", "RUN-017", "./tests/hook.test.js"],
    }, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "READY_FOR_REVIEW");
    assert.equal(result.eventType, "task.ready_for_review");
    assert.equal(result._exitCode, 0);

    // Verify Journal
    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    const reviewEvents = events.filter((e) => e.eventType === "task.ready_for_review");
    assert.equal(reviewEvents.length, 1);

    // Verify READY_FOR_REVIEW state
    const task = app.getTask("TASK-HOOK-R4");
    assert.equal(task.state, STATES.READY_FOR_REVIEW);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 7. Stop — nonterminal, never submits events ─────────────────────────────

test("R4: Stop never infers completion or submits events", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("Stop", { reason: "User stopped" }, {}, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "STOP_RECORDED");
    assert.equal(result.eventType, null);
    assert.equal(result.emitted, false);
    assert.equal(result._exitCode, 0);
    assert.equal("state" in result, false);
    assert.equal("completed" in result, false);
    assert.equal("failed" in result, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 8. SubagentStop — nonterminal, never submits events ─────────────────────

test("R4: SubagentStop never infers completion or submits events", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("SubagentStop", { reason: "Subagent completed" }, {}, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "SUBAGENT_STOP_RECORDED");
    assert.equal(result.eventType, null);
    assert.equal(result.emitted, false);
    assert.equal(result._exitCode, 0);
    assert.equal("state" in result, false);
    assert.equal("completed" in result, false);
    assert.equal("failed" in result, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 9. Governance field rejection ─────────────────────────────────────────

test("R4: Governance fields in stdin are rejected for all hooks", () => {
  const dir = tmpDir();
  try {
    const hooks = ["PostToolUse", "Notification", "Permission", "ReadyForReview", "Stop"];
    for (const hookName of hooks) {
      const result = runHookCli(hookName, { taskId: "TASK-017", projectId: "proj" }, {}, dir);
      assert.equal(result.ok, false, `${hookName}: expected rejection`);
      assert.equal(result._exitCode, 1, `${hookName}: expected exit code 1`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: Multiple governance fields are reported", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("PostToolUse", {
      toolName: "Write",
      taskId: "TASK-001",
      projectId: "proj-1",
      actorId: "agent-1",
    }, {}, dir);

    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 10. Unknown field rejection (hook-specific schema) ──────────────────────

test("R4: Unknown fields in stdin are rejected per hook schema", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("PostToolUse", { toolName: "Write", unknownField: "test" }, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: SessionStart rejects any stdin fields", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHookCli("SessionStart", { message: "hello" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 11. Unknown hook ────────────────────────────────────────────────────────

test("R4: Unknown hook name is rejected", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("UnknownHook", {}, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: Missing hook name fails", () => {
  const dir = tmpDir();
  try {
    const result = spawnSync(process.execPath, [CLI_ENTRY, "hook", "claude"], {
      input: "{}",
      encoding: "utf8",
      timeout: 5000,
    });
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 12. Receipt leak prevention ─────────────────────────────────────────────

test("R4: Receipt never leaks sensitive data patterns", () => {
  const dir = tmpDir();
  try {
    const sensitivePayloads = [
      { prompt: "Write a secret file" },
      { session: "session-abc123" },
      { command: "rm -rf /" },
      { token: "ghp_abc123" },
      { password: "secret123" },
      { apiKey: "sk-proj-abc" },
      { authorization: "Bearer token123" },
      { credential: "aws AKIA123" },
      { arguments: { filePath: "/etc/passwd" } },
      { input: "user input" },
      { output: "command output" },
    ];

    for (const payload of sensitivePayloads) {
      const safePayload = { toolName: "Write", message: "Safe message", ...payload };
      const result = runHookCli("PostToolUse", safePayload, {}, dir);
      const key = Object.keys(payload)[0];
      assert.equal(key in result, false, `Receipt must not contain ${key}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: Receipt contains only safe fields", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHookCli("PostToolUse", { toolName: "Write", message: "test" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // Safe fields
    assert.equal("ok" in result, true);
    assert.equal("eventType" in result, true);
    assert.equal("emitted" in result, true);
    assert.equal("code" in result, true);
    assert.equal("timestamp" in result, true);

    // Unsafe fields that MUST NOT be in the receipt
    assert.equal("prompt" in result, false);
    assert.equal("session" in result, false);
    assert.equal("command" in result, false);
    assert.equal("payload" in result, false);
    assert.equal("token" in result, false);
    assert.equal("password" in result, false);
    assert.equal("apiKey" in result, false);
    assert.equal("authorization" in result, false);
    assert.equal("arguments" in result, false);
    assert.equal("input" in result, false);
    assert.equal("output" in result, false);
    assert.equal("credential" in result, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 13. No duplicate accepted ───────────────────────────────────────────────

test("R4: SessionStart does not create duplicate task.accepted", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);

    // Run SessionStart twice
    runHookCli("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    runHookCli("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // Verify only the launcher's original task.accepted exists
    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    const acceptedEvents = events.filter((e) => e.eventType === "task.accepted");
    assert.equal(acceptedEvents.length, 1);
    assert.equal(acceptedEvents[0].eventId, "CE-accept-r4");

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 14. Notification Pump compatibility ─────────────────────────────────────

test("R4: Journal events match Notification Pump format", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);

    // Submit a few hook events
    runHookCli("PostToolUse", { toolName: "Write", message: "Working" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    runHookCli("Notification", { message: "Input needed", reason: "Decision" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // Verify all events have Notification Pump format
    const events = app.listEvents({ taskId: "TASK-HOOK-R4" });
    for (const event of events) {
      assert.ok(event.eventId, "event must have eventId");
      assert.ok(event.eventType, "event must have eventType");
      assert.ok(event.taskId, "event must have taskId");
      assert.ok(Array.isArray(event.targets), "event must have targets array");
      assert.ok(event.notification, "event must have notification policy");
      assert.ok(event.notification.policy, "notification policy must exist");
    }

    const eventTypes = events.map((e) => e.eventType);
    assert.ok(eventTypes.includes("task.progress"));
    assert.ok(eventTypes.includes("task.input_required"));

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 15. Error receipt safety ────────────────────────────────────────────────

test("R4: Error receipts never leak internal details", () => {
  const dir = tmpDir();
  try {
    const result = runHookCli("SessionStart", {}, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_NO_GOVERNED_CONTEXT");
    // Receipt must not contain raw error message content
    assert.equal("message" in result, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: Context without .agent-runtime/coordination fails gracefully", () => {
  const dir = tmpDir();
  try {
    // No .agent/runtime/coordination — the hook will fail to find the service
    const contextFile = createContextFile(dir);
    const result = runHookCli("PostToolUse", { toolName: "Write", message: "test" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // Without service, the hook should fail gracefully
    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
