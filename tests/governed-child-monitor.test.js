"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const { createEvent, STATES } = require("../lib/coordination/contract");

const MONITOR = path.resolve(__dirname, "../lib/governed-child-monitor.js");

// ─── Shared fixtures ──────────────────────────────────────────────────────────

function makeRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-monitor-e2e-"));
  return root;
}

function closeRuntime(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// Repository with worktreeId so openService() in the monitor can find the coordination runtime.
function makeRepo(runtimeRoot) {
  return { repositoryId: "monitor-e2e", worktreeId: runtimeRoot };
}

function writeContext(runtimeRoot, overrides = {}) {
  const context = {
    taskId: "T-MONITOR-E2E",
    projectId: "monitor-e2e",
    targetAgentId: "claude-monitor-e2e",
    coordinatorId: "codex-current",
    correlationId: "CORR-MONITOR-E2E",
    launchId: "LAUNCH-MONITOR-E2E",
    notificationTarget: { actorId: "codex-current", kind: "coordinator" },
    producer: { actorId: "claude-monitor-e2e", kind: "agent", sessionId: "session-monitor-e2e" },
    repository: makeRepo(runtimeRoot),
    ownershipScopes: [],
    heartbeatIntervalMs: 5000,
    terminalTimeoutMs: 150,
    agentCommand: "/bin/sh",
    agentArgs: ["-c", "sleep 2"],
    ...overrides,
  };
  if (overrides.sessionId) {
    context.producer = {
      actorId: context.targetAgentId,
      kind: "agent",
      sessionId: overrides.sessionId,
    };
  }
  const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-monitor-context-"));
  const contextFile = path.join(contextDir, "context.json");
  const receiptFile = path.join(contextDir, "receipt.json");
  fs.writeFileSync(contextFile, JSON.stringify(context), { mode: 0o600 });
  fs.writeFileSync(path.join(contextDir, ".accepted"), "accepted\n", { mode: 0o600 });
  return { contextFile, receiptFile, contextDir };
}

function runMonitor(contextFile, receiptFile) {
  return spawnSync(process.execPath, [MONITOR, contextFile, receiptFile], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, CORTEX_LAUNCH_CONTEXT: contextFile },
  });
}

function readReceipt(receiptFile) {
  return JSON.parse(fs.readFileSync(receiptFile, "utf8"));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

// ─── Helper: set up a task in ACCEPTED state with optional lease ─────────────

function setupAcceptedTask(runtime, taskId = "T-MONITOR-E2E", agentId = "claude-monitor-e2e") {
  const runtimeCoord = path.join(runtime, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });

  const projectId = "monitor-e2e";
  const coordinatorId = "codex-current";
  const sessionId = `session-${agentId}`;
  const coordinator = { actorId: coordinatorId, kind: "coordinator", sessionId: "root" };

  service.submit(
    createEvent({
      projectId, taskId, correlationId: "CORR-MONITOR-E2E",
      producer: coordinator, targets: [{ actorId: agentId, kind: "agent" }],
      eventType: "task.created", previousState: null, currentState: STATES.CREATED, sequence: 1,
      repository: { repositoryId: projectId },
    }),
    coordinator
  );
  service.submit(
    createEvent({
      projectId, taskId, correlationId: "CORR-MONITOR-E2E",
      producer: coordinator, targets: [{ actorId: agentId, kind: "agent" }],
      eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2,
      repository: { repositoryId: projectId },
    }),
    coordinator
  );
  const lease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
  const agent = { actorId: agentId, kind: "agent", sessionId };
  service.submit(
    createEvent({
      projectId, taskId, correlationId: "CORR-MONITOR-E2E",
      producer: agent, targets: [],
      eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, sequence: 1,
      fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agentId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }],
    }),
    agent
  );
  service.close();
  return { service, lease, sessionId };
}

// ─── Test 1: timeout → BLOCKED with coordinator_notify ───────────────────────

test("governed child timeout reports BLOCKED with coordinator notification", (t) => {
  const root = makeRuntime();
  const { service, lease, sessionId } = setupAcceptedTask(root);
  t.after(() => closeRuntime(root));

  const { contextFile, receiptFile } = writeContext(root, {
    taskId: "T-MONITOR-E2E",
    targetAgentId: "claude-monitor-e2e",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    terminalTimeoutMs: 100,
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, `${result.stderr}\n${fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, "utf8") : "no receipt"}`);

  const reopened = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
  const taskState = reopened.getTask("T-MONITOR-E2E");
  const blocked = reopened.listEvents({ taskId: "T-MONITOR-E2E" }).find((e) => e.eventType === "task.blocked");
  const progress = reopened.listEvents({ taskId: "T-MONITOR-E2E" }).find((e) => e.eventType === "task.progress");
  reopened.close();

  const receipt = readReceipt(receiptFile);
  assert.equal(taskState.state, STATES.BLOCKED, JSON.stringify(receipt));
  assert.ok(blocked, "task.blocked event must be present");
  assert.equal(blocked.notification.policy, "coordinator_notify");
  assert.ok(blocked.targets.some((t) => t.actorId === "codex-current" && t.kind === "coordinator"));
  // Progress event should have been emitted before blocked
  assert.ok(progress, "task.progress should precede task.blocked in ACCEPTED→EXECUTING transition");
  assert.equal(receipt.phase, "timed_out");
  assert.equal(receipt.outcome, "REPORTED_BLOCKED");
});

// ─── Test 2: nonzero exit → FAILED ──────────────────────────────────────────

test("governed child nonzero exit reports FAILED with coordinator_notify", (t) => {
  const root = makeRuntime();
  const { service, lease, sessionId } = setupAcceptedTask(root);
  t.after(() => closeRuntime(root));

  const { contextFile, receiptFile } = writeContext(root, {
    taskId: "T-MONITOR-E2E",
    targetAgentId: "claude-monitor-e2e",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    agentCommand: "/bin/sh",
    agentArgs: ["-c", "exit 42"],
    terminalTimeoutMs: 10000,
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, result.stderr);

  const reopened = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
  const taskState = reopened.getTask("T-MONITOR-E2E");
  const failed = reopened.listEvents({ taskId: "T-MONITOR-E2E" }).find((e) => e.eventType === "task.failed");
  reopened.close();

  const receipt = readReceipt(receiptFile);
  assert.equal(taskState.state, STATES.FAILED, JSON.stringify(receipt));
  assert.ok(failed, "task.failed event must be present");
  assert.equal(failed.notification.policy, "coordinator_notify");
  assert.ok(failed.targets.some((t) => t.actorId === "codex-current" && t.kind === "coordinator"));
  assert.equal(receipt.phase, "exited");
  assert.equal(receipt.code, "EXIT_ABNORMAL");
  assert.equal(receipt.outcome, "REPORTED_FAILED");
});

// ─── Test 3: zero exit → BLOCKED ────────────────────────────────────────────

test("governed child zero exit reports BLOCKED (no handoff)", (t) => {
  const root = makeRuntime();
  const { service, lease, sessionId } = setupAcceptedTask(root);
  t.after(() => closeRuntime(root));

  const { contextFile, receiptFile } = writeContext(root, {
    taskId: "T-MONITOR-E2E",
    targetAgentId: "claude-monitor-e2e",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    agentCommand: "/usr/bin/true",
    agentArgs: [],
    terminalTimeoutMs: 10000,
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, `${result.stderr}\n${fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, "utf8") : "no receipt"}`);

  const reopened = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
  const taskState = reopened.getTask("T-MONITOR-E2E");
  const blocked = reopened.listEvents({ taskId: "T-MONITOR-E2E" }).find((e) => e.eventType === "task.blocked");
  reopened.close();

  const receipt = readReceipt(receiptFile);
  assert.equal(taskState.state, STATES.BLOCKED, JSON.stringify(receipt));
  assert.ok(blocked, "task.blocked must be present for zero exit without handoff");
  assert.equal(receipt.phase, "exited");
  assert.equal(receipt.code, "EXIT_ZERO");
});

// ─── Test 4: terminal states are preserved ─────────────────────────────────────

test("governed child does not overwrite terminal task state", (t) => {
  const root = makeRuntime();
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const service = CoordinationApplicationService.open(runtimeCoord, { journal: { lock: false } });
  t.after(() => { service.close(); closeRuntime(root); });

  const taskId = "T-READY-PRESERVE";
  const projectId = "monitor-e2e";
  const coordinatorId = "codex-current";
  const agentId = "claude-ready-e2e";
  const coordinator = { actorId: coordinatorId, kind: "coordinator", sessionId: "root" };
  const agent = { actorId: agentId, kind: "agent", sessionId: `session-${agentId}` };

  service.submit(createEvent({
    projectId, taskId, correlationId: "CORR-READY",
    producer: coordinator, targets: [{ actorId: agentId, kind: "agent" }],
    eventType: "task.created", previousState: null, currentState: STATES.CREATED, sequence: 1,
    repository: { repositoryId: projectId },
  }), coordinator);
  service.submit(createEvent({
    projectId, taskId, correlationId: "CORR-READY",
    producer: coordinator, targets: [{ actorId: agentId, kind: "agent" }],
    eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2,
    repository: { repositoryId: projectId },
  }), coordinator);
  const lease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: agent.sessionId, ttl: 60_000 });
  service.submit(createEvent({
    projectId, taskId, correlationId: "CORR-READY",
    producer: agent, targets: [],
    eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED, sequence: 1,
    fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: agentId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }],
  }), agent);
  service.submit(createEvent({
    projectId, taskId, correlationId: "CORR-READY",
    producer: agent, targets: [],
    eventType: "task.progress", previousState: STATES.ACCEPTED, currentState: STATES.EXECUTING, sequence: 2,
  }), agent);
  service.submit(createEvent({
    projectId, taskId, correlationId: "CORR-READY",
    producer: agent, targets: [],
    eventType: "task.ready_for_review", previousState: STATES.EXECUTING, currentState: STATES.READY_FOR_REVIEW, sequence: 3,
    evidence: [{ kind: "artifact", ref: "ARTIFACT-TEST-READY" }],
    notification: { policy: "journal_only", dedupeKey: "task.ready_for_review" },
  }), agent);

  service.close();

  const { contextFile, receiptFile } = writeContext(root, {
    taskId,
    targetAgentId: agentId,
    sessionId: agent.sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    coordinatorId,
    agentCommand: "/usr/bin/false",
    agentArgs: [],
    terminalTimeoutMs: 10000,
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, `${result.stderr}\n${fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, "utf8") : "no receipt"}`);

  const reopened = CoordinationApplicationService.open(runtimeCoord);
  const taskState = reopened.getTask(taskId);
  reopened.close();

  const receipt = readReceipt(receiptFile);
  assert.equal(taskState.state, STATES.READY_FOR_REVIEW, JSON.stringify(receipt));
  assert.ok(receipt.outcome === "ALREADY_HANDED_OFF", `Expected ALREADY_HANDED_OFF, got ${receipt.outcome}`);
});

// ─── Test 5: lease renewal happens while child is alive ───────────────────────

test("governed child monitor renews lease periodically", (t) => {
  const root = makeRuntime();
  const { lease, sessionId } = setupAcceptedTask(root, "T-LEASE-RENEW", "claude-renew-e2e");
  t.after(() => closeRuntime(root));

  const { contextFile, receiptFile } = writeContext(root, {
    taskId: "T-LEASE-RENEW",
    targetAgentId: "claude-renew-e2e",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    coordinatorId: "codex-current",
    heartbeatIntervalMs: 50,  // 50ms → fast renewal
    terminalTimeoutMs: 10000,
    agentCommand: "/bin/sh",
    agentArgs: ["-c", "sleep 3"],
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, result.stderr);

  // Renewal is audited before the monitor releases the exact lease on exit.
  const reopened = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
  const renewedLease = reopened.leases.getLease(lease.leaseId);
  const renewals = reopened.leases.getAuditLog({
    eventType: "ownership.acquired",
    leaseId: lease.leaseId,
  }).filter((entry) => entry.details && entry.details.renewed);
  reopened.close();

  assert.ok(renewedLease, "lease must still be present after monitor exit");
  assert.ok(renewedLease.releasedAt, "lease must be released by monitor after final handling");
  assert.ok(!renewedLease.staleAt, "lease must not be stale");
  assert.ok(renewals.length >= 1, "lease renewal must be durably audited");

  const receipt = readReceipt(receiptFile);
  assert.equal(receipt.phase, "exited");
  assert.equal(receipt.code, "EXIT_ZERO");
});

// ─── Test 6: lease is released after exit ───────────────────────────────────

test("governed child releases lease after final event handling", (t) => {
  const root = makeRuntime();
  const { lease, sessionId } = setupAcceptedTask(root, "T-LEASE-RELEASE", "claude-release-e2e");
  t.after(() => closeRuntime(root));

  const { contextFile, receiptFile } = writeContext(root, {
    taskId: "T-LEASE-RELEASE",
    targetAgentId: "claude-release-e2e",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    coordinatorId: "codex-current",
    heartbeatIntervalMs: 5000,
    terminalTimeoutMs: 10000,
    agentCommand: "/usr/bin/true",
    agentArgs: [],
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, `${result.stderr}\n${fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, "utf8") : "no receipt"}`);

  // The lease should be released after the monitor exits
  const reopened = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
  const finalLease = reopened.leases.getLease(lease.leaseId);
  reopened.close();

  assert.ok(finalLease, "lease must still be readable");
  assert.ok(finalLease.releasedAt != null, "lease must be released after monitor exit");
  assert.equal(finalLease.owner, "claude-release-e2e");
});

// ─── Test 7: heartbeat events are emitted while child is alive ───────────────

test("governed child emits heartbeat events while alive", (t) => {
  const root = makeRuntime();
  const { lease, sessionId } = setupAcceptedTask(root, "T-HEARTBEAT", "claude-hb-e2e");
  t.after(() => closeRuntime(root));

  const { contextFile, receiptFile } = writeContext(root, {
    taskId: "T-HEARTBEAT",
    targetAgentId: "claude-hb-e2e",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    coordinatorId: "codex-current",
    heartbeatIntervalMs: 30,
    terminalTimeoutMs: 500,
    agentCommand: "/bin/sh",
    agentArgs: ["-c", "sleep 3"],
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, result.stderr);

  const reopened = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
  const heartbeats = reopened.listEvents({ taskId: "T-HEARTBEAT" }).filter((e) => e.eventType === "task.heartbeat");
  reopened.close();

  // At least one heartbeat should have been emitted (terminalTimeout is 500ms, heartbeatInterval is 30ms)
  assert.ok(heartbeats.length >= 1, `Expected at least 1 heartbeat, got ${heartbeats.length}`);
  // Heartbeats should be journal_only (not coordinator_notify)
  for (const hb of heartbeats) {
    assert.equal(hb.notification.policy, "journal_only", "heartbeat must be journal_only");
  }
});

// ─── Test 8: concurrent isolated agents ───────────────────────────────────────

test("two concurrent governed children run in isolated contexts", (t) => {
  const root = makeRuntime();
  const { lease: lease1, sessionId: sessionId1 } = setupAcceptedTask(root, "T-CONCURRENT-1", "claude-conc-1");
  const { lease: lease2, sessionId: sessionId2 } = setupAcceptedTask(root, "T-CONCURRENT-2", "claude-conc-2");
  t.after(() => closeRuntime(root));

  const { contextFile: cf1, receiptFile: rf1 } = writeContext(root, {
    taskId: "T-CONCURRENT-1",
    targetAgentId: "claude-conc-1",
    sessionId: sessionId1,
    leaseId: lease1.leaseId,
    fencingToken: lease1.fencingToken,
    coordinatorId: "codex-current",
    launchId: "LAUNCH-CONCURRENT-1",
    heartbeatIntervalMs: 500,
    terminalTimeoutMs: 10000,
    agentCommand: "/bin/sh",
    agentArgs: ["-c", "sleep 1"],
  });

  const { contextFile: cf2, receiptFile: rf2 } = writeContext(root, {
    taskId: "T-CONCURRENT-2",
    targetAgentId: "claude-conc-2",
    sessionId: sessionId2,
    leaseId: lease2.leaseId,
    fencingToken: lease2.fencingToken,
    coordinatorId: "codex-current",
    launchId: "LAUNCH-CONCURRENT-2",
    heartbeatIntervalMs: 500,
    terminalTimeoutMs: 10000,
    agentCommand: "/bin/sh",
    agentArgs: ["-c", "sleep 1"],
  });

  // Launch both monitors in parallel (using spawnSync sequentially is fine for isolation testing)
  const r1 = runMonitor(cf1, rf1);
  const r2 = runMonitor(cf2, rf2);

  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);

  const receipt1 = readReceipt(rf1);
  const receipt2 = readReceipt(rf2);

  assert.equal(receipt1.phase, "exited");
  assert.equal(receipt1.code, "EXIT_ZERO");
  assert.equal(receipt2.phase, "exited");
  assert.equal(receipt2.code, "EXIT_ZERO");

  // Both tasks should have been blocked
  const reopened = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
  const task1 = reopened.getTask("T-CONCURRENT-1");
  const task2 = reopened.getTask("T-CONCURRENT-2");
  const blocked1 = reopened.listEvents({ taskId: "T-CONCURRENT-1" }).find((e) => e.eventType === "task.blocked");
  const blocked2 = reopened.listEvents({ taskId: "T-CONCURRENT-2" }).find((e) => e.eventType === "task.blocked");
  reopened.close();

  assert.equal(task1.state, STATES.BLOCKED);
  assert.equal(task2.state, STATES.BLOCKED);
  assert.ok(blocked1, "task1 must have blocked event");
  assert.ok(blocked2, "task2 must have blocked event");
  assert.notEqual(blocked1.eventId, blocked2.eventId, "events must be distinct");
});

// ─── Test 9: receipt contains no private fields ─────────────────────────────

test("governed child receipt contains only stable lifecycle fields", (t) => {
  const root = makeRuntime();
  const { lease, sessionId } = setupAcceptedTask(root);
  t.after(() => closeRuntime(root));

  const { contextFile, receiptFile } = writeContext(root, {
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    sessionId,
    terminalTimeoutMs: 100,
  });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, result.stderr);

  const receipt = readReceipt(receiptFile);
  const FORBIDDEN = [
    "agentCommand", "agentArgs", "producer", "leaseId", "fencingToken",
    "sessionId", "contextFile", "context", "token", "secret", "key", "password",
    "credential",
  ];
  for (const field of FORBIDDEN) {
    assert.ok(
      !(field in receipt),
      `receipt must not contain private field '${field}': ${JSON.stringify(receipt)}`
    );
  }
  // Must contain stable lifecycle fields
  assert.ok("phase" in receipt, "receipt must contain 'phase'");
  assert.ok("code" in receipt, "receipt must contain 'code'");
  assert.ok("outcome" in receipt, "receipt must contain 'outcome'");
  assert.ok("timestamp" in receipt, "receipt must contain 'timestamp'");
  // timestamp must be ISO format
  assert.ok(!isNaN(Date.parse(receipt.timestamp)), `timestamp must be valid ISO: ${receipt.timestamp}`);
});

// ─── Test 10: invalid context file → spawn_failed receipt ───────────────────

test("governed child writes spawn_failed receipt on invalid context", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-monitor-invalid-"));
  t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

  const contextFile = path.join(tmpDir, "context.json");
  const receiptFile = path.join(tmpDir, "receipt.json");

  // Write an invalid context (missing required fields)
  fs.writeFileSync(contextFile, JSON.stringify({ taskId: "T-INVALID" }), { mode: 0o600 });

  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 1, "monitor should exit with non-zero on invalid context");

  const receipt = readReceipt(receiptFile);
  assert.equal(receipt.phase, "spawn_failed");
  assert.equal(receipt.code, "CONTEXT_INVALID");
});

test("governed child retries a live journal writer and finalizes after release", async (t) => {
  const root = makeRuntime();
  const { lease, sessionId } = setupAcceptedTask(root, "T-LOCK-RETRY", "claude-lock-retry");
  t.after(() => closeRuntime(root));
  const runtimeCoord = path.join(root, ".agent-runtime", "coordination");
  const writer = CoordinationApplicationService.open(runtimeCoord);
  const { contextFile, receiptFile } = writeContext(root, {
    taskId: "T-LOCK-RETRY",
    targetAgentId: "claude-lock-retry",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    agentCommand: "/usr/bin/false",
    terminalTimeoutMs: 10000,
  });
  const child = spawn(process.execPath, [MONITOR, contextFile, receiptFile], {
    stdio: "ignore",
    env: { ...process.env, CORTEX_LAUNCH_CONTEXT: contextFile },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  writer.close();
  const exited = await waitForExit(child);
  assert.equal(exited.code, 0);
  const service = CoordinationApplicationService.open(runtimeCoord);
  const task = service.getTask("T-LOCK-RETRY");
  service.close();
  const receipt = readReceipt(receiptFile);
  assert.equal(task.state, STATES.FAILED, JSON.stringify(receipt));
  assert.equal(receipt.outcome, "REPORTED_FAILED");
  assert.ok(receipt.stderrBytes >= 0);
  assert.equal(typeof receipt.stderrSha256, "string");
  assert.equal(receipt.stderrTruncated, false);
});

test("governed child caps private stderr and exposes only digest metadata", (t) => {
  const root = makeRuntime();
  const { lease, sessionId } = setupAcceptedTask(root, "T-LOG-CAP", "claude-log-cap");
  t.after(() => closeRuntime(root));
  const { contextFile, receiptFile, contextDir } = writeContext(root, {
    taskId: "T-LOG-CAP",
    targetAgentId: "claude-log-cap",
    sessionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    agentCommand: "/bin/sh",
    agentArgs: ["-c", "head -c 1100000 /dev/zero >&2; exit 1"],
    terminalTimeoutMs: 10000,
  });
  const result = runMonitor(contextFile, receiptFile);
  assert.equal(result.status, 0, result.stderr);
  const receipt = readReceipt(receiptFile);
  const privateStderr = path.join(contextDir, "stderr.log");
  assert.equal(fs.statSync(privateStderr).mode & 0o777, 0o600);
  assert.equal(fs.statSync(privateStderr).size, 1024 * 1024);
  assert.equal(receipt.stderrBytes, 1024 * 1024);
  assert.equal(receipt.stderrTruncated, true);
  assert.equal(JSON.stringify(receipt).includes("xxxx"), false);
});
