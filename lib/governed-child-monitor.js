"use strict";

// Private supervisor for governed launches. Public receipts intentionally contain
// only stable lifecycle fields; private context, output, paths, and lease data stay
// inside the governed runtime.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CoordinationApplicationService } = require("./coordination/application-service");
const { createAgentReporterFromContext } = require("./agent-reporter");

const contextFile = process.argv[2];
const receiptFile = process.argv[3];
const acceptanceSignalFile = path.join(path.dirname(contextFile), ".accepted");

function now() {
  return new Date().toISOString();
}

function writeReceipt(phase, code, outcome) {
  const receipt = { phase, code, timestamp: now() };
  if (outcome) receipt.outcome = outcome;
  fs.writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
}

function failContext() {
  writeReceipt("spawn_failed", "CONTEXT_INVALID");
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
    return CoordinationApplicationService.open(
      path.join(runtimeRoot, ".agent-runtime", "coordination")
    );
  } catch {
    return null;
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
  const service = openService();
  if (!service) return "RELEASE_UNAVAILABLE";
  try {
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

function reportFinal(resultCode) {
  if (!acceptanceSignaled()) return "WAITING_FOR_ACCEPTANCE";
  const service = openService();
  if (!service) return "SERVICE_UNAVAILABLE";
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

let child;
try {
  child = spawn(context.agentCommand, context.agentArgs || [], {
    cwd: runtimeRoot,
    stdio: "ignore",
    env: { ...process.env, CORTEX_LAUNCH_CONTEXT: contextFile },
  });
} catch {
  writeReceipt("spawn_failed", "SPAWN_FAILED");
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
  const service = openService();
  if (!service) return;
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

function settle(phase, code, attempt = 0) {
  if (settled) return;
  stopTimers();
  const outcome = reportFinal(code);
  if (outcome === "WAITING_FOR_ACCEPTANCE" && attempt < 100) {
    setTimeout(() => settle(phase, code, attempt + 1), 50);
    return;
  }
  settled = true;
  releaseLease(code.toLowerCase());
  writeReceipt(phase, code, outcome);
  process.exit(0);
}

child.once("error", () => {
  if (settled) return;
  settled = true;
  stopTimers();
  releaseLease("spawn-failed");
  writeReceipt("spawn_failed", "SPAWN_FAILED");
  process.exit(1);
});

child.once("exit", (code, signal) => {
  settle("exited", code === 0 && !signal ? "EXIT_ZERO" : "EXIT_ABNORMAL");
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
  settle("timed_out", "TERMINAL_TIMEOUT");
}, terminalTimeoutMs);
watchdogTimer.unref();
