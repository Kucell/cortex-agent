"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REPORTING_MODES,
  createAdapterDescriptor,
} = require("../lib/coordination/adapter-core");
const {
  buildExplicitReport,
  createClaudeAdapter,
  createLaunchContext,
  hookEventType,
} = require("../lib/coordination/claude-adapter");
const {
  createCodexAdapter,
  recoverCoordinator,
  shouldWake,
} = require("../lib/coordination/codex-adapter");

function launchInput(overrides = {}) {
  return {
    taskId: "TASK-010",
    correlationId: "CORR-010",
    projectId: "cortex-agent",
    repository: {
      repositoryId: "cortex-agent",
      worktreeId: "acn-adapters",
      branch: "codex/acn-adapters",
      baselineCommit: "460bf88",
    },
    ownershipScopes: ["lib/coordination/adapters"],
    acceptanceCriteria: ["focused tests pass"],
    forbiddenActions: ["do not push"],
    allowedTools: ["node"],
    heartbeatIntervalMs: 30000,
    terminalTimeoutMs: 300000,
    notificationPolicy: "coordinator_notify",
    ...overrides,
  };
}

function event(eventType, overrides = {}) {
  return {
    eventId: `CE-${eventType.replace(/\./g, "-")}`,
    taskId: "TASK-010",
    eventType,
    currentState: "READY_FOR_REVIEW",
    notification: { policy: "coordinator_notify" },
    message: "adapter task needs attention",
    evidence: [{ kind: "validation", ref: "report:focused-tests" }],
    ...overrides,
  };
}

test("adapter descriptor is vendor-independent and capability-only", () => {
  const descriptor = createAdapterDescriptor({
    adapterId: "generic-agent",
    vendor: "local",
    capabilities: { hooks: false, explicitCli: true },
  });
  assert.deepEqual(descriptor.capabilities, {
    hooks: false,
    explicitCli: true,
  });
  assert.equal("command" in descriptor, false);
  assert.equal("pid" in descriptor, false);
});

test("launch context contains stable identity and repository-relative scopes", () => {
  const context = createLaunchContext(launchInput());
  assert.equal(context.taskId, "TASK-010");
  assert.deepEqual(context.ownershipScopes, ["lib/coordination/adapters"]);
  assert.equal("prompt" in context, false);
  assert.equal("cwd" in context, false);
  assert.equal("pid" in context, false);
});

test("launch context rejects absolute paths and secret-like text", () => {
  assert.throws(() => createLaunchContext(launchInput({
    ownershipScopes: ["/workspace/private.js"],
  })), /repository-relative|private runtime data/);
  assert.throws(() => createLaunchContext(launchInput({
    acceptanceCriteria: [`${"token"}=${"value"}`],
  })), /private runtime data/);
  assert.throws(() => createLaunchContext(launchInput({
    acceptanceCriteria: ["connect to 192.0.2.10"],
  })), /private runtime data/);
});

test("Claude uses hooks when available and always exposes explicit fallback", () => {
  const adapter = createClaudeAdapter({
    hooks: true,
    explicitCli: true,
    processBoundaryEvidence: true,
  });
  const report = adapter.buildReport("task.testing", {
    event: { eventType: "task.testing" },
  });
  assert.equal(adapter.reportingMode, REPORTING_MODES.HOOK);
  assert.equal(report.hookName, "TestStart");
  assert.equal(report.fallback.executable, "cortex-agent");
  assert.deepEqual(report.fallback.args.slice(0, 2), ["task", "test"]);
});

test("Claude falls back to explicit CLI when hooks are unavailable", () => {
  const adapter = createClaudeAdapter({ hooks: false });
  assert.equal(adapter.reportingMode, REPORTING_MODES.EXPLICIT_CLI);
  assert.equal(hookEventType("PermissionRequest"), "task.input_required");
  assert.equal(hookEventType("UnknownHook"), null);
});

test("Claude uses explicit CLI for events without a corresponding hook", () => {
  const adapter = createClaudeAdapter({ hooks: true, explicitCli: true });
  const report = adapter.buildReport("task.heartbeat", {
    event: { eventType: "task.heartbeat" },
  });
  assert.equal(report.mode, REPORTING_MODES.EXPLICIT_CLI);
  assert.equal(report.hookName, null);
});

test("explicit report is argv data and rejects unsupported events", () => {
  const report = buildExplicitReport("task.heartbeat", {
    event: { eventType: "task.heartbeat" },
  });
  assert.equal(report.executable, "cortex-agent");
  assert.equal(typeof report.args, "object");
  assert.throws(() => buildExplicitReport("task.completed", {
    taskId: "TASK-010",
    actorId: "claude-worker",
  }), /unsupported report event/);
});

test("Claude explicit fallback carries a bounded auth context for owned work", () => {
  const report = buildExplicitReport("task.progress", {
    event: {
      eventType: "task.progress",
      producer: {
        actorId: "claude-worker",
        kind: "agent",
        sessionId: "SESSION-010",
      },
    },
    authContext: {
      actorId: "claude-worker",
      kind: "agent",
      sessionId: "SESSION-010",
    },
  });
  const marker = report.args.indexOf("--auth-context-json");
  assert.ok(marker > 0);
  assert.deepEqual(JSON.parse(report.args[marker + 1]), {
    actorId: "claude-worker",
    kind: "agent",
    sessionId: "SESSION-010",
  });
  assert.throws(() => buildExplicitReport("task.progress", {
    event: {
      eventType: "task.progress",
      producer: { actorId: "claude-worker", kind: "agent" },
    },
    authContext: {
      actorId: "other-agent",
      kind: "agent",
      sessionId: "SESSION-010",
    },
  }), /match event producer/);
});

test("Claude exit evidence never guesses FAILED or completion", () => {
  const adapter = createClaudeAdapter({
    hooks: false,
    processBoundaryEvidence: true,
  });
  const boundary = adapter.recordExitBoundary({
    taskId: "TASK-010",
    sessionId: "SESSION-010",
    exitCode: 0,
    terminalStateReported: false,
    evidenceRefs: [{ kind: "log_cursor", ref: "cursor:final" }],
  });
  assert.equal(boundary.cleanExit, true);
  assert.equal(boundary.terminalStateReported, false);
  assert.equal("state" in boundary, false);
  assert.equal("pid" in boundary, false);
});

test("heartbeat and ordinary progress never wake Codex", () => {
  assert.equal(shouldWake(event("task.heartbeat")), false);
  assert.equal(shouldWake(event("task.progress")), false);
});

test("critical events wake with structured context but no side effects", async () => {
  const requests = [];
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    deliver: async (request) => requests.push(request),
  });
  const result = await adapter.wake(event("task.ready_for_review"));
  assert.equal(result.status, "delivered");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].autoApprove, false);
  assert.equal(requests[0].executeSideEffects, false);
  assert.equal("command" in requests[0], false);
});

test("Codex requires structured-context capability before waking", async () => {
  let called = false;
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: false,
    deliver: async () => {
      called = true;
    },
  });
  const result = await adapter.wake(event("task.failed"));
  assert.equal(result.status, "deferred");
  assert.equal(called, false);
});

test("Codex rejects unsafe event context at the adapter boundary", async () => {
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    deliver: async () => {},
  });
  await assert.rejects(
    adapter.wake(event("task.failed", { message: "connect to 192.0.2.10" })),
    { key: "ERR_INVALID_EVENT" },
  );
});

test("unavailable Codex wakeup defers critical delivery to journal recovery", async () => {
  const adapter = createCodexAdapter({
    threadWakeup: false,
    structuredContext: true,
  });
  const result = await adapter.wake(event("task.failed"));
  assert.deepEqual(result, {
    status: "deferred",
    eventId: "CE-task-failed",
  });
});

test("recovery presents pending critical events before fresh events", async () => {
  const order = [];
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    deliver: async (request) => order.push(request.eventId),
  });
  const pending = event("task.input_required", {
    eventId: "CE-pending",
    currentState: "WAITING_FOR_INPUT",
    requestedAction: {
      kind: "provide_input",
      decisionRef: "D-ACN-input",
      waitpointRef: "WP-ACN-input",
    },
  });
  const fresh = event("task.ready_for_review", { eventId: "CE-fresh" });
  const result = await recoverCoordinator(adapter, {
    pendingCriticalEvents: [pending],
    newEvents: [fresh, pending],
    ackedEventIds: [],
  });
  assert.deepEqual(order, ["CE-pending", "CE-fresh"]);
  assert.deepEqual(result.delivered, ["CE-pending", "CE-fresh"]);
});

test("recovery does not redeliver acknowledged events or ACK automatically", async () => {
  const order = [];
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    deliver: async (request) => order.push(request.eventId),
  });
  const result = await recoverCoordinator(adapter, {
    pendingCriticalEvents: [event("task.failed", { eventId: "CE-acked" })],
    newEvents: [],
    ackedEventIds: ["CE-acked"],
  });
  assert.deepEqual(order, []);
  assert.deepEqual(result.delivered, []);
  assert.equal("acked" in result, false);
});
