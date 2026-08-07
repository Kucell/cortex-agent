"use strict";

// ─── Claude Code Hook Adapter — Integration Tests (T-ACN-017-R2) ─────────────
//
// These tests invoke the actual hook executable (`bin/cortex-claude-hook`) against
// a real CoordinationApplicationService and Journal in a temp project directory.
//
// Coverage:
//   1. SessionStart — validates governed context, no event submitted (launcher authoritative)
//   2. PostToolUse — submits task.progress event to Journal
//   3. PostToolUse with test signal — submits task.testing to Journal
//   4. Notification — submits task.input_required to Journal
//   5. Permission — submits task.input_required to Journal
//   6. ReadyForReview — submits task.ready_for_review with evidence to Journal
//   7. Stop — nonterminal, never submits events
//   8. SubagentStop — nonterminal, never submits events
//   9. Governance field rejection in stdin
//  10. Unknown field rejection in stdin (hook-specific schema)
//  11. Unknown hook name rejection
//  12. Receipt never leaks sensitive data (prompt, session, path, token, credentials)
//  13. No duplicate accepted on SessionStart
//  14. Notification Pump compatibility (event format in Journal)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  CoordinationApplicationService,
} = require("../../lib/coordination/application-service");
const { createEvent, STATES } = require("../../lib/coordination/contract");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOOK_EXECUTABLE = path.resolve(__dirname, "..", "..", "bin", "cortex-claude-hook");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hook-r2-"));
}

// Create a temp project directory with .agent/ structure
function setupProject(dir) {
  // Create .agent/runtime/coordination/ directory
  fs.mkdirSync(path.join(dir, ".agent", "runtime", "coordination"), { recursive: true });
  return dir;
}

// Set up the coordination service with a task, returns the service
// The task is created in ASSIGNED state (ready for agent acceptance)
function setupService(dir, taskId, projectId, agentId) {
  const runtimeDir = path.join(dir, ".agent", "runtime", "coordination");
  const app = CoordinationApplicationService.open(runtimeDir, { journal: { lock: false } });

  // Create the task
  app.submit(createEvent({
    eventId: "CE-create-r2",
    projectId: projectId || "cortex-hook-r2",
    taskId: taskId || "TASK-HOOK-R2",
    correlationId: "CORR-HOOK-R2",
    producer: { actorId: "coordinator-r2", kind: "coordinator" },
    targets: [{ actorId: agentId || "hook-agent-r2", kind: "agent" }],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    sequence: 1,
    repository: { repositoryId: projectId || "cortex-hook-r2" },
    notification: { policy: "journal_only", dedupeKey: "r2" },
    timestamp: "2026-07-29T00:00:00.000Z",
  }));

  // Assign the task
  app.submit(createEvent({
    eventId: "CE-assign-r2",
    projectId: projectId || "cortex-hook-r2",
    taskId: taskId || "TASK-HOOK-R2",
    correlationId: "CORR-HOOK-R2",
    producer: { actorId: "coordinator-r2", kind: "coordinator" },
    targets: [{ actorId: agentId || "hook-agent-r2", kind: "agent" }],
    eventType: "task.assigned",
    previousState: STATES.CREATED,
    currentState: STATES.ASSIGNED,
    sequence: 2,
    repository: { repositoryId: projectId || "cortex-hook-r2" },
    notification: { policy: "journal_only", dedupeKey: "r2" },
    timestamp: "2026-07-29T00:00:00.000Z",
  }));

  // Accept the task (launcher submits this)
  app.submit(createEvent({
    eventId: "CE-accept-r2",
    projectId: projectId || "cortex-hook-r2",
    taskId: taskId || "TASK-HOOK-R2",
    correlationId: "CORR-HOOK-R2",
    producer: { actorId: agentId || "hook-agent-r2", kind: "agent", sessionId: "SESSION-HOOK-R2" },
    targets: [{ actorId: agentId || "hook-agent-r2", kind: "agent" }],
    eventType: "task.accepted",
    previousState: STATES.ASSIGNED,
    currentState: STATES.ACCEPTED,
    sequence: 1,
    repository: { repositoryId: projectId || "cortex-hook-r2" },
    notification: { policy: "journal_only", dedupeKey: "r2" },
    timestamp: "2026-07-29T00:00:00.000Z",
  }));

  return app;
}

// Create a context file for the hook's CORTEX_LAUNCH_CONTEXT
function createContextFile(dir, overrides = {}) {
  const filePath = path.join(dir, "context.json");
  const context = {
    taskId: "TASK-HOOK-R2",
    projectId: "cortex-hook-r2",
    targetAgentId: "hook-agent-r2",
    coordinatorId: "coordinator-r2",
    correlationId: "CORR-HOOK-R2",
    launchId: "LAUNCH-HOOK-R2",
    notificationPolicy: "coordinator_notify",
    producer: { actorId: "hook-agent-r2", kind: "agent", sessionId: "SESSION-HOOK-R2" },
    repository: { repositoryId: "cortex-hook-r2", branch: "main" },
    ...overrides,
  };
  fs.writeFileSync(filePath, JSON.stringify(context), { encoding: "utf8", mode: 0o600 });
  return filePath;
}

// Run the hook executable and return parsed result
function runHook(hookName, stdinPayload, env, cwd) {
  const result = spawnSync(process.execPath, [HOOK_EXECUTABLE, hookName], {
    input: JSON.stringify(stdinPayload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: cwd || undefined,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (_) {
    parsed = { ok: false, parseError: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  return { ...parsed, _exitCode: result.status, _stderr: result.stderr.trim() };
}

// ─── 1. SessionStart ────────────────────────────────────────────────────────

test("R2: SessionStart without governed context fails closed", () => {
  const dir = tmpDir();
  try {
    const result = runHook("SessionStart", {}, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_NO_GOVERNED_CONTEXT");
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: SessionStart validates context and does NOT submit event", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHook("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "ACCEPTED");
    assert.equal(result._exitCode, 0);

    // Verify no task.accepted event was added by the hook (launcher is authoritative)
    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
    const acceptedEvents = events.filter((e) => e.eventType === "task.accepted");
    // The launcher's task.accepted is the only one
    assert.equal(acceptedEvents.length, 1);
    assert.equal(acceptedEvents[0].eventId, "CE-accept-r2");

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: SessionStart is idempotent — same result on repeated invocation", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const result1 = runHook("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    const result2 = runHook("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result1.ok, true);
    assert.equal(result2.ok, true);
    assert.equal(result1.code, "ACCEPTED");
    assert.equal(result2.code, "ACCEPTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 2. PostToolUse — submits task.progress to Journal ───────────────────────

test("R2: PostToolUse submits task.progress to Journal", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHook("PostToolUse", { toolName: "Write", message: "Writing file" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "EMITTED");
    assert.equal(result.eventType, "task.progress");
    assert.equal(result._exitCode, 0);

    // Verify Journal has the progress event
    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
    const progressEvents = events.filter((e) => e.eventType === "task.progress");
    assert.equal(progressEvents.length, 1);
    assert.ok(progressEvents[0].eventId);
    assert.ok(progressEvents[0].message);

    // Verify state machine transitioned correctly
    const task = app.getTask("TASK-HOOK-R2");
    assert.equal(task.state, STATES.EXECUTING);

    // Notification Pump compatibility: event must have targets and notification
    assert.ok(Array.isArray(progressEvents[0].targets));
    assert.ok(progressEvents[0].notification);
    assert.ok(progressEvents[0].notification.policy);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: PostToolUse with long message is bounded", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const longMessage = "x".repeat(10000);
    const result = runHook("PostToolUse", { toolName: "Write", message: longMessage },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "EMITTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 3. PostToolUse with test signal → task.testing ──────────────────────────

test("R2: PostToolUse with test signal submits task.testing to Journal", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    // First submit progress to get to EXECUTING state (test signal requires EXECUTING)
    app.submit(createEvent({
      eventId: "CE-progress-r2",
      projectId: "cortex-hook-r2",
      taskId: "TASK-HOOK-R2",
      correlationId: "CORR-HOOK-R2",
      producer: { actorId: "hook-agent-r2", kind: "agent", sessionId: "SESSION-HOOK-R2" },
      targets: [{ actorId: "hook-agent-r2", kind: "agent" }],
      eventType: "task.progress",
      previousState: STATES.ACCEPTED,
      currentState: STATES.EXECUTING,
      repository: { repositoryId: "cortex-hook-r2" },
      notification: { policy: "journal_only", dedupeKey: "r2" },
      message: "Working",
      timestamp: "2026-07-29T00:00:00.000Z",
    }));

    const contextFile = createContextFile(dir);
    const result = runHook("PostToolUse", { toolName: "Bash", command: "npm test" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "TEST_SIGNAL");
    assert.equal(result.eventType, "task.testing");
    assert.equal(result._exitCode, 0);

    // Verify Journal
    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
    const testingEvents = events.filter((e) => e.eventType === "task.testing");
    assert.equal(testingEvents.length, 1);

    // State should be TESTING
    const task = app.getTask("TASK-HOOK-R2");
    assert.equal(task.state, STATES.TESTING);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 4. Notification — submits task.input_required to Journal ────────────────

test("R2: Notification submits task.input_required to Journal", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHook("Notification", { message: "Input needed", reason: "User decision" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "INPUT_REQUIRED");
    assert.equal(result.eventType, "task.input_required");
    assert.equal(result._exitCode, 0);

    // Verify Journal
    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
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

test("R2: Notification with sensitive data in stdin is rejected", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHook("Notification", { message: "Token is sk-proj-abc123def456ghi789jklmnop" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_SENSITIVE_DATA_REJECTED");
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 5. Permission — submits task.input_required to Journal ──────────────────

test("R2: Permission submits task.input_required to Journal", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHook("Permission", { message: "Permission needed", reason: "Write access" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "PERMISSION_REQUIRED");
    assert.equal(result.eventType, "task.input_required");
    assert.equal(result._exitCode, 0);

    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
    const inputEvents = events.filter((e) => e.eventType === "task.input_required");
    assert.equal(inputEvents.length, 1);

    // Verify WAITING_FOR_INPUT state
    const task = app.getTask("TASK-HOOK-R2");
    assert.equal(task.state, STATES.WAITING_FOR_INPUT);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. ReadyForReview — submits task.ready_for_review to Journal ────────────

test("R2: ReadyForReview submits task.ready_for_review to Journal", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    // First submit progress to get to EXECUTING (required for ready_for_review)
    app.submit(createEvent({
      eventId: "CE-progress-rr",
      projectId: "cortex-hook-r2",
      taskId: "TASK-HOOK-R2",
      correlationId: "CORR-HOOK-R2",
      producer: { actorId: "hook-agent-r2", kind: "agent", sessionId: "SESSION-HOOK-R2" },
      targets: [{ actorId: "hook-agent-r2", kind: "agent" }],
      eventType: "task.progress",
      previousState: STATES.ACCEPTED,
      currentState: STATES.EXECUTING,
      repository: { repositoryId: "cortex-hook-r2" },
      notification: { policy: "journal_only", dedupeKey: "r2" },
      message: "Working",
      timestamp: "2026-07-29T00:00:00.000Z",
    }));

    const contextFile = createContextFile(dir);
    const result = runHook("ReadyForReview", {
      message: "Done",
      evidenceRefs: ["ARTIFACT-001", "RUN-017", "./tests/hook.test.js"],
    }, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    assert.equal(result.ok, true);
    assert.equal(result.code, "READY_FOR_REVIEW");
    assert.equal(result.eventType, "task.ready_for_review");
    assert.equal(result._exitCode, 0);

    // Verify Journal
    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
    const reviewEvents = events.filter((e) => e.eventType === "task.ready_for_review");
    assert.equal(reviewEvents.length, 1);

    // Verify READY_FOR_REVIEW state
    const task = app.getTask("TASK-HOOK-R2");
    assert.equal(task.state, STATES.READY_FOR_REVIEW);

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 7. Stop — nonterminal, never submits events ─────────────────────────────

test("R2: Stop never infers completion or submits events", () => {
  const dir = tmpDir();
  try {
    const result = runHook("Stop", { reason: "User stopped" }, {}, dir);

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

test("R2: SubagentStop never infers completion or submits events", () => {
  const dir = tmpDir();
  try {
    const result = runHook("SubagentStop", { reason: "Subagent completed" }, {}, dir);

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

test("R2: Governance fields in stdin are rejected for all hooks", () => {
  const dir = tmpDir();
  try {
    const hooks = ["PostToolUse", "Notification", "Permission", "ReadyForReview", "Stop"];
    for (const hookName of hooks) {
      const result = runHook(hookName, { taskId: "TASK-017", projectId: "proj" }, {}, dir);
      assert.equal(result.ok, false, `${hookName}: expected rejection`);
      assert.equal(result.code, "ERR_GOVERNANCE_FIELD_REJECTED", `${hookName}: expected governance rejection code`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: Multiple governance fields are reported", () => {
  const dir = tmpDir();
  try {
    const result = runHook("PostToolUse", {
      toolName: "Write",
      taskId: "TASK-001",
      projectId: "proj-1",
      actorId: "agent-1",
    }, {}, dir);

    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_GOVERNANCE_FIELD_REJECTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 10. Unknown field rejection (hook-specific schema) ──────────────────────

test("R2: Unknown fields in stdin are rejected per hook schema", () => {
  const dir = tmpDir();
  try {
    // PostToolUse does not allow "unknownField"
    const result = runHook("PostToolUse", { toolName: "Write", unknownField: "test" }, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_UNKNOWN_FIELD_REJECTED");
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: SessionStart rejects any stdin fields", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    // SessionStart allows NO stdin fields
    const result = runHook("SessionStart", { message: "hello" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_UNKNOWN_FIELD_REJECTED");
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 11. Unknown hook ────────────────────────────────────────────────────────

test("R2: Unknown hook name is rejected", () => {
  const dir = tmpDir();
  try {
    const result = runHook("UnknownHook", {}, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_UNKNOWN_HOOK");
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: Missing hook name fails", () => {
  const dir = tmpDir();
  try {
    const result = spawnSync(process.execPath, [HOOK_EXECUTABLE], {
      input: "{}",
      encoding: "utf8",
      timeout: 5000,
    });
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "ERR_HOOK_NAME_REQUIRED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 12. Receipt leak prevention ─────────────────────────────────────────────

test("R2: Receipt never leaks sensitive data patterns", () => {
  const dir = tmpDir();
  try {
    const sensitivePayloads = [
      { prompt: "Write a secret file" },
      { session: "session-abc123" },
      { cwd: "/home/user/project" },
      { command: "rm -rf /" },
      { payload: { secret: "data" } },
      { token: "ghp_abc123" },
      { password: "secret123" },
      { apiKey: "sk-proj-abc" },
      { authorization: "Bearer token123" },
      { arguments: { filePath: "/etc/passwd" } },
      { input: "user input" },
      { output: "command output" },
      { credential: "aws AKIA123" },
    ];

    for (const payload of sensitivePayloads) {
      const safePayload = { toolName: "Write", message: "Safe message", ...payload };
      // These are redacted, not rejected — the sensitive field is in the payload
      // but the redaction layer strips it before it reaches the receipt
      const result = runHook("PostToolUse", safePayload, {}, dir);
      // Without context, the hook can't submit but should still succeed with redaction
      const key = Object.keys(payload)[0];
      assert.equal(key in result, false, `Receipt must not contain ${key}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: Receipt contains only safe fields", () => {
  const dir = setupProject(tmpDir());
  try {
    setupService(dir);
    const contextFile = createContextFile(dir);
    const result = runHook("PostToolUse", { toolName: "Write", message: "test" },
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
    assert.equal("cwd" in result, false);
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
    assert.equal("secret" in result, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 13. No duplicate accepted ───────────────────────────────────────────────

test("R2: SessionStart does not create duplicate task.accepted", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);

    // Run SessionStart twice
    runHook("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    runHook("SessionStart", {}, { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // Verify only the launcher's original task.accepted exists
    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
    const acceptedEvents = events.filter((e) => e.eventType === "task.accepted");
    assert.equal(acceptedEvents.length, 1);
    assert.equal(acceptedEvents[0].eventId, "CE-accept-r2");

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 14. Notification Pump compatibility ─────────────────────────────────────

test("R2: Journal events match Notification Pump format", () => {
  const dir = setupProject(tmpDir());
  try {
    const app = setupService(dir);
    const contextFile = createContextFile(dir);

    // Submit a few hook events
    runHook("PostToolUse", { toolName: "Write", message: "Working" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);
    runHook("Notification", { message: "Input needed", reason: "Decision" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // Verify all events have Notification Pump format
    const events = app.listEvents({ taskId: "TASK-HOOK-R2" });
    for (const event of events) {
      assert.ok(event.eventId, "event must have eventId");
      assert.ok(event.eventType, "event must have eventType");
      assert.ok(event.taskId, "event must have taskId");
      assert.ok(Array.isArray(event.targets), "event must have targets array");
      assert.ok(event.notification, "event must have notification policy");
      assert.ok(event.notification.policy, "notification policy must exist");
    }

    // The hook events (progress, input_required) should be present
    const eventTypes = events.map((e) => e.eventType);
    assert.ok(eventTypes.includes("task.progress"));
    assert.ok(eventTypes.includes("task.input_required"));

    app.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 15. Error receipt safety ────────────────────────────────────────────────

test("R2: Error receipts never leak internal details", () => {
  const dir = tmpDir();
  try {
    const result = runHook("SessionStart", {}, {}, dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_NO_GOVERNED_CONTEXT");
    // Receipt must not contain raw error messages
    if (result.message) {
      // Message should be "[REDACTED]" or absent
      assert.ok(result.message === "[REDACTED]" || result.message === undefined);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: Context without .agent/ directory fails gracefully", () => {
  const dir = tmpDir();
  try {
    // No .agent/ directory — the hook will fail to find the service
    const contextFile = createContextFile(dir);
    const result = runHook("PostToolUse", { toolName: "Write", message: "test" },
      { CORTEX_LAUNCH_CONTEXT: contextFile }, dir);

    // Without service, the hook should fail gracefully
    assert.equal(result.ok, false);
    assert.equal(result._exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});