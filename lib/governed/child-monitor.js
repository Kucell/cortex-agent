"use strict";

// Private supervisor for governed launches. Public receipts intentionally contain
// only stable lifecycle fields; private context, output, paths, and lease data stay
// inside the governed runtime.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CoordinationApplicationService } = require("../coordination/application-service.js");
const { createAgentReporterFromContext } = require("../agents/reporter");
const { classifyCoordinationError, fileDigest } = require("./launch-diagnostics");
const { deriveAttemptDisposition } = require("../attempt/disposition");
const { createNotificationHarness } = require("../coordination/notification-host.js");

const contextFile = process.argv[2];
const receiptFile = process.argv[3];
const acceptanceSignalFile = path.join(path.dirname(contextFile), ".accepted");
const stdoutFile = path.join(path.dirname(contextFile), "stdout.log");
const stderrFile = path.join(path.dirname(contextFile), "stderr.log");
const agentSpawnedFile = path.join(path.dirname(contextFile), ".agent-spawned");
const agentExitedFile = path.join(path.dirname(contextFile), ".agent-exited");
const MAX_PRIVATE_LOG_BYTES = 1024 * 1024;

function now() {
  return new Date().toISOString();
}

function writeReceipt(phase, code, outcome, details = {}) {
  const receipt = { phase, code, timestamp: now() };
  if (outcome) receipt.outcome = outcome;
  Object.assign(receipt, details);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
}

// ─── Attempt disposition envelope (T-ACN-019 / P-005) ─────────────────────
//
// The monitor always projects the same execution attempt one terminal time:
//   - attempt_disposition ∈ { attempt_active, attempt_review_ready,
//     attempt_attention_required, attempt_closed, attempt_inconsistent }
//   - monitoring_terminal ∈ { true, false } — when true, the host heartbeat
//     MUST stop polling this attempt and MUST persist its pause/disposition
//     receipt (P-005 §6).
//   - reconciliation_required ∈ { true, false } — only true when the
//     disposition explicitly requires fenced manual reconciliation.
//   - observed_at — RFC3339 timestamp captured at projection time.
//
// The projection is derived from the current Task state, the lease record,
// the agent activity and the freshly computed exit code. It is appended to
// the receipt ONCE per settled attempt; re-running the monitor with the same
// launchId+exit combination MUST NOT mutate the disposition again.
function projectAttemptDisposition(state) {
  if (!state || typeof state !== "object") return null;
  const taskState = state.taskState;
  const leaseState = state.leaseState;
  const agentActivity = state.agentActivity;
  const receiptCode = state.receiptCode;
  return deriveAttemptDisposition({
    taskState: taskState ? { state: taskState } : null,
    leaseState: leaseState || null,
    agentActivity: agentActivity || null,
    receiptCode,
  });
}

function observeLeaseState(service) {
  if (!service || !service.leases || typeof service.leases.getLease !== "function") {
    return Object.freeze({ active: false, released: true, stale: false, present: false });
  }
  const lease = service.leases.getLease(context.leaseId);
  if (!lease) return Object.freeze({ active: false, released: false, stale: false, present: false });
  return Object.freeze({
    active: !lease.releasedAt && !lease.staleAt && service.leases.isActive(lease) === true,
    released: Boolean(lease.releasedAt),
    stale: Boolean(lease.staleAt),
    present: true,
    fencingToken: Number.isInteger(lease.fencingToken) ? lease.fencingToken : null,
  });
}

function observeAgentActivity() {
  // The child process state is observed via the .agent-spawned / .agent-exited
  // sentinel files maintained by this monitor. The subprocess is the
  // canonical "agent activity" probe — no exit ⇒ active; exit ⇒ inactive.
  if (!fs.existsSync(agentSpawnedFile)) {
    return Object.freeze({ active: false, observed: false });
  }
  if (fs.existsSync(agentExitedFile)) {
    return Object.freeze({ active: false, observed: true });
  }
  return Object.freeze({ active: true, observed: true });
}

function applyAttemptDisposition(details, exitCode, receiptCode) {
  const opened = openService();
  let taskSnapshot = null;
  let leaseProjection = null;
  let agentActivity = observeAgentActivity();
  if (opened.ok) {
    try {
      taskSnapshot = taskState(opened.service);
    } catch (_) {
      taskSnapshot = null;
    } finally {
      opened.service.close();
    }
  }
  leaseProjection = (function readLease() {
    const serviceOpen = openService();
    if (!serviceOpen.ok) return null;
    try {
      return observeLeaseState(serviceOpen.service);
    } catch (_) {
      return null;
    } finally {
      serviceOpen.service.close();
    }
  })();
  const disposition = projectAttemptDisposition({
    taskState: taskSnapshot ? taskSnapshot.state : null,
    leaseState: leaseProjection,
    agentActivity,
    receiptCode,
  });
  if (!disposition) return details;
  const projected = Object.assign({}, details, {
    attempt_disposition: disposition.disposition,
    monitoring_terminal: disposition.monitoringTerminal === true,
    reconciliation_required: disposition.reconciliationRequired === true,
    observed_at: disposition.observedAt,
  });
  if (disposition.reason) projected.attempt_disposition_reason = disposition.reason;
  if (Number.isInteger(exitCode)) projected.attempt_exit_code = exitCode;
  return projected;
}

function failContext() {
  writeReceipt("spawn_failed", "CONTEXT_INVALID", null, {
    attempt_disposition: "attempt_inconsistent",
    monitoring_terminal: true,
    reconciliation_required: true,
    observed_at: now(),
    attempt_disposition_reason: "invalid launch context — cannot derive a consistent attempt",
  });
  process.exit(1);
}

let context;
try {
  context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
} catch {
  failContext();
}

const required = [
  "taskId", "projectId", "targetAgentId", "coordinatorId", "launchId",
  "leaseId", "fencingToken", "agentCommand",
];
if (!context || required.some((field) => context[field] === null || context[field] === undefined
    || context[field] === "")) {
  failContext();
}

const actorSessionId = context.producer && context.producer.sessionId;
const runtimeRoot = context.repository && context.repository.worktreeId;
if (!actorSessionId || !runtimeRoot || !Number.isInteger(context.fencingToken)) {
  failContext();
}

const HANDOFF_STATES = new Set([
  "INPUT_REQUIRED", "READY_FOR_REVIEW", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED",
]);
const heartbeatIntervalMs = Number.isSafeInteger(context.heartbeatIntervalMs)
  && context.heartbeatIntervalMs > 0 ? context.heartbeatIntervalMs : 30000;
const terminalTimeoutMs = Number.isSafeInteger(context.terminalTimeoutMs)
  && context.terminalTimeoutMs > 0 ? context.terminalTimeoutMs : 300000;
const leaseTtlMs = Math.max(heartbeatIntervalMs * 3, 60000);

function openService() {
  try {
    return { ok: true, service: CoordinationApplicationService.open(
      path.join(runtimeRoot, ".agent-runtime", "coordination")
    ) };
  } catch (error) {
    return { ok: false, error: classifyCoordinationError(error) };
  }
}

function taskState(service) {
  try {
    return service.getTask(context.taskId);
  } catch {
    return null;
  }
}

function acceptanceSignaled() {
  try {
    return fs.statSync(acceptanceSignalFile).isFile();
  } catch {
    return false;
  }
}

function releaseLease(reason) {
  const opened = openService();
  if (!opened.ok) return `RELEASE_UNAVAILABLE_${opened.error.code}`;
  const service = opened.service;
  try {
    // Journal the ownership release while the lease is still active. Once the
    // durable lease is released, normal owner authorization must reject this
    // event and the Task projection would retain an unreplayable stale owner.
    publishOwnershipReleased(service);
    service.releaseOwnership(context.leaseId, {
      actorId: actorSessionId,
      evidence: [`monitor-${reason}`],
    });
    return "RELEASED";
  } catch (error) {
    return error && (error.key || error.code) || "RELEASE_FAILED";
  } finally {
    service.close();
  }
}

// Synchronously publish an `ownership.released` event alongside the lease
// release so the journal's ownership slot follows the durable lease state.
// The previous Task state is preserved (we do not change the Task business
// state here), but `task.ownership` becomes `[]`, allowing subsequent fenced
// reconcilers to apply the bounded BLOCKED -> EXECUTING -> TESTING ->
// READY_FOR_REVIEW sequence without tripping the stale-lease check.
function publishOwnershipReleased(service) {
  try {
    const taskSnapshot = service.getTask(context.taskId);
    if (!taskSnapshot || !Array.isArray(taskSnapshot.ownership) || taskSnapshot.ownership.length === 0) return;
    const { createEvent } = require("../coordination/contract.js");
    const sessionId = context.producer && context.producer.sessionId ? context.producer.sessionId : actorSessionId;
    const actorId = context.targetAgentId || context.producer.actorId || actorSessionId;
    const event = createEvent({
      projectId: context.projectId,
      taskId: context.taskId,
      correlationId: context.correlationId || null,
      producer: { actorId, kind: "agent", sessionId },
      targets: [],
      eventType: "ownership.released",
      previousState: taskSnapshot.state,
      currentState: taskSnapshot.state,
      repository: { repositoryId: context.projectId },
      message: "Governed child monitor released its ownership reference",
    });
    service.submit(event, { actorId, kind: "agent", sessionId });
  } catch (_) {
    // The lease itself is already released; failing to journal the
    // ownership.released event must not change the monitor's outcome.
  }
}

function reportFinal(resultCode) {
  if (!acceptanceSignaled()) return "WAITING_FOR_ACCEPTANCE";
  const opened = openService();
  if (!opened.ok) return `SERVICE_UNAVAILABLE_${opened.error.code}_${opened.error.retryable ? "RETRYABLE" : "FINAL"}`;
  const service = opened.service;
  try {
    const current = taskState(service);
    if (!current) return "TASK_NOT_FOUND";
    if (HANDOFF_STATES.has(current.state)) return "ALREADY_HANDED_OFF";
    if (current.state === "ASSIGNED") return "WAITING_FOR_ACCEPTANCE";

    const reporter = createAgentReporterFromContext(service);
    if (current.state === "ACCEPTED") {
      const progress = reporter.report("task.progress", {
        message: "Governed child entered execution before monitor recovery",
        notificationPolicy: "journal_only",
        deliveryId: `monitor-progress:${context.launchId}`,
      });
      if (!progress.ok) return `PROGRESS_REJECTED_${progress.code || "UNKNOWN"}`;
    }

    const eventType = resultCode === "EXIT_ABNORMAL" ? "task.failed" : "task.blocked";
    const report = reporter.report(eventType, {
      message: eventType === "task.failed"
        ? "Governed child exited abnormally"
        : "Governed child exited without an explicit handoff",
      notificationPolicy: "coordinator_notify",
      deliveryId: `monitor-final:${context.launchId}:${eventType}`,
    });
    if (!report.ok) return `FINAL_REJECTED_${report.code || "UNKNOWN"}`;
    return eventType === "task.failed" ? "REPORTED_FAILED" : "REPORTED_BLOCKED";
  } catch (error) {
    return `FINAL_REJECTED_${error && (error.key || error.code) || "UNKNOWN"}`;
  } finally {
    service.close();
  }
}

async function deliverFinalNotification() {
  const delivery = context.notificationDelivery;
  if (!delivery) return { status: "disabled", degraded: false, reason: null };
  try {
    const harness = createNotificationHarness(runtimeRoot, {
      threadId: delivery.threadId,
      useEnvironment: false,
    });
    const resolved = await harness.resolvePump({
      action: "once",
      options: {
        adapter: delivery.adapter,
        consumer: delivery.consumer,
        target: context.notificationTarget,
        maxAttempts: 5,
      },
    });
    const report = await resolved.pump.runOnce();
    const degraded = Boolean(report.degraded || report.deferred || report.failed);
    return {
      status: degraded ? "degraded" : "delivered",
      degraded,
      reason: degraded && Array.isArray(report.reasons) ? report.reasons[0] || null : null,
    };
  } catch (error) {
    return {
      status: "degraded",
      degraded: true,
      reason: String(error && (error.code || error.key) || "ERR_NOTIFICATION_DELIVERY").slice(0, 128),
    };
  }
}

let child;
const privateLogs = {
  stdout: { fd: null, bytes: 0, truncated: false },
  stderr: { fd: null, bytes: 0, truncated: false },
};

function attachBoundedLog(stream, file, state) {
  state.fd = fs.openSync(file, "w", 0o600);
  stream.on("data", (chunk) => {
    const remaining = MAX_PRIVATE_LOG_BYTES - state.bytes;
    if (remaining <= 0) {
      state.truncated = true;
      return;
    }
    const portion = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    fs.writeSync(state.fd, portion);
    state.bytes += portion.length;
    if (portion.length < chunk.length) state.truncated = true;
  });
}

function closePrivateLogs() {
  for (const state of Object.values(privateLogs)) {
    if (state.fd === null) continue;
    try { fs.fsyncSync(state.fd); } catch { /* best effort */ }
    try { fs.closeSync(state.fd); } catch { /* best effort */ }
    state.fd = null;
  }
}

try {
  child = spawn(context.agentCommand, context.agentArgs || [], {
    cwd: runtimeRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CORTEX_LAUNCH_CONTEXT: contextFile },
  });
  attachBoundedLog(child.stdout, stdoutFile, privateLogs.stdout);
  attachBoundedLog(child.stderr, stderrFile, privateLogs.stderr);
  fs.writeFileSync(agentSpawnedFile, "spawned\n", { mode: 0o600, flag: "wx" });
} catch (spawnError) {
  closePrivateLogs();
  const errorMessage = spawnError && spawnError.message ? String(spawnError.message) : null;
  writeReceipt("spawn_failed", "SPAWN_FAILED", null, applyAttemptDisposition({
    leaseOutcome: "NOT_RELEASED",
    spawnErrorMessage: errorMessage ? errorMessage.slice(0, 128) : null,
  }, null, "SPAWN_FAILED"));
  process.exit(1);
}

let settled = false;
let heartbeatSequence = 0;
let heartbeatTimer = null;
let heartbeatStartTimer = null;
let watchdogTimer = null;

function stopTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (heartbeatStartTimer) clearTimeout(heartbeatStartTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  heartbeatTimer = null;
  heartbeatStartTimer = null;
  watchdogTimer = null;
}

function heartbeat() {
  if (settled || !acceptanceSignaled()) return;
  const opened = openService();
  if (!opened.ok) return;
  const service = opened.service;
  try {
    const current = taskState(service);
    if (!current || HANDOFF_STATES.has(current.state)) return;
    service.renewOwnership(context.leaseId, {
      actorId: actorSessionId,
      ttl: leaseTtlMs,
      evidence: ["monitor-heartbeat"],
    });
    const reporter = createAgentReporterFromContext(service);
    heartbeatSequence += 1;
    reporter.report("task.heartbeat", {
      message: "Governed child is alive",
      notificationPolicy: "journal_only",
      deliveryId: `monitor-heartbeat:${context.launchId}:${heartbeatSequence}`,
    });
  } catch {
    // Liveness reporting is best effort; final handling remains fail-closed.
  } finally {
    service.close();
  }
}

async function settle(phase, code, attempt = 0, exitDetails = {}) {
  if (settled) return;
  stopTimers();
  const outcome = reportFinal(code);
  const retryableService = outcome.includes("SERVICE_UNAVAILABLE_COOR")
    && outcome.endsWith("_RETRYABLE");
  const retryLimit = retryableService ? 10 : 100;
  if ((outcome === "WAITING_FOR_ACCEPTANCE" || retryableService) && attempt < retryLimit) {
    const delay = retryableService ? Math.min(50 * (2 ** Math.min(attempt, 4)), 800) : 50;
    setTimeout(() => { settle(phase, code, attempt + 1, exitDetails).catch(() => {}); }, delay);
    return;
  }
  settled = true;
  const notification = await deliverFinalNotification();
  const leaseOutcome = releaseLease(code.toLowerCase());
  const stderr = fileDigest(stderrFile);
  let details = {
    ...exitDetails,
    leaseOutcome,
    stderrBytes: stderr.bytes,
    stderrSha256: stderr.sha256,
    stdoutTruncated: privateLogs.stdout.truncated,
    stderrTruncated: privateLogs.stderr.truncated,
    notificationStatus: notification.status,
    notificationDegraded: notification.degraded,
  };
  if (notification.reason) details.notificationReason = notification.reason;
  if (outcome.includes("SERVICE_UNAVAILABLE_")) {
    details.serviceErrorCode = outcome.split("SERVICE_UNAVAILABLE_")[1].replace(/_(RETRYABLE|FINAL)$/, "");
  }
  details = applyAttemptDisposition(details, details.exitCode, code);
  writeReceipt(phase, code, outcome, details);
  process.exit(0);
}

child.once("error", () => {
  if (settled) return;
  settled = true;
  stopTimers();
  closePrivateLogs();
  try { fs.writeFileSync(agentExitedFile, "spawn_error\n", { mode: 0o600, flag: "wx" }); } catch {}
  releaseLease("spawn-failed");
  writeReceipt("spawn_failed", "SPAWN_FAILED", null, applyAttemptDisposition({
    leaseOutcome: "RELEASED",
  }, null, "SPAWN_FAILED"));
  process.exit(1);
});

child.once("close", (code, signal) => {
  closePrivateLogs();
  try { fs.writeFileSync(agentExitedFile, "exited\n", { mode: 0o600, flag: "wx" }); } catch {}
  settle(
    "exited",
    code === 0 && !signal ? "EXIT_ZERO" : "EXIT_ABNORMAL",
    0,
    { exitCode: Number.isInteger(code) ? code : null, signal: signal || null },
  ).catch(() => process.exit(1));
});

// Give the launcher a bounded window to durably record task.accepted after the
// monitor process has spawned. This avoids concurrent journal writers during
// the launch handshake and also handles children that exit immediately.
heartbeatStartTimer = setTimeout(() => {
  if (settled) return;
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
  heartbeatTimer.unref();
}, 250);
heartbeatStartTimer.unref();

watchdogTimer = setTimeout(() => {
  if (settled) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The final state is still recorded if the process disappeared concurrently.
  }
  settle("timed_out", "TERMINAL_TIMEOUT").catch(() => process.exit(1));
}, terminalTimeoutMs);
watchdogTimer.unref();
