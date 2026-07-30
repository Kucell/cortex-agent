"use strict";

// Private child supervisor for governed launches. Its receipt contains only
// lifecycle phase/timestamps/stable result codes; never command, prompt,
// output, path, session, or credentials.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CoordinationApplicationService } = require("./coordination/application-service");
const { createAgentReporterFromContext } = require("./agent-reporter");

const contextFile = process.argv[2];
const receiptFile = process.argv[3];
function write(receipt) { fs.writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 }); }
function now() { return new Date().toISOString(); }

let context;
try { context = JSON.parse(fs.readFileSync(contextFile, "utf8")); }
catch { write({ phase: "spawn_failed", code: "CONTEXT_INVALID", timestamp: now() }); process.exit(1); }

let child;
try {
  child = spawn(context.agentCommand, context.agentArgs || [], {
    cwd: context.repository && context.repository.worktreeId || undefined,
    stdio: "ignore",
    env: { ...process.env, CORTEX_LAUNCH_CONTEXT: contextFile },
  });
} catch { write({ phase: "spawn_failed", code: "SPAWN_FAILED", timestamp: now() }); process.exit(1); }

let started = false;
let handoffReported = false;
function reportExitState(resultCode) {
  let outcome = "RECEIPT_ONLY";
  let service = null;
  try {
    const root = context.repository && context.repository.worktreeId;
    service = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"));
    const reporter = createAgentReporterFromContext(service);
    const task = service.getTask(context.taskId);
    if (task && !["READY_FOR_REVIEW", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"].includes(task.state)) {
      const eventType = (resultCode === "EXIT_ZERO" || resultCode === "TIMEOUT") ? "task.blocked" : "task.failed";
      const report = reporter.report(eventType, { message: eventType === "task.blocked" ? "Agent exited or timed out without explicit handoff" : "Agent process exited abnormally", deliveryId: `child-exit:${context.launchId}` });
      outcome = report.ok ? (eventType === "task.blocked" ? "REPORTED_BLOCKED" : "REPORTED_FAILED") : "REPORT_REJECTED";
    } else outcome = "ALREADY_HANDED_OFF";
  } catch { outcome = "REPORT_UNAVAILABLE"; }
  finally { if (service) service.close(); }
  return outcome;
}
const watchdog = setTimeout(() => {
  if (handoffReported) return;
  const outcome = reportExitState("TIMEOUT");
  handoffReported = outcome === "REPORTED_BLOCKED";
  write({ phase: "timed_out", code: "TERMINAL_TIMEOUT", outcome, timestamp: now() });
}, Number.isSafeInteger(context.terminalTimeoutMs) && context.terminalTimeoutMs > 0 ? context.terminalTimeoutMs : 300000);
watchdog.unref();
const timer = setTimeout(() => {
  if (!started) { started = true; write({ phase: "started", code: "CHILD_ALIVE", timestamp: now() }); }
}, 1000);
child.once("error", () => { clearTimeout(timer); write({ phase: "spawn_failed", code: "SPAWN_FAILED", timestamp: now() }); process.exit(1); });
child.once("exit", (code, signal) => {
  clearTimeout(timer);
  clearTimeout(watchdog);
  const resultCode = code === 0 && !signal ? "EXIT_ZERO" : "EXIT_ABNORMAL";
  if (!handoffReported) {
    const outcome = reportExitState(resultCode);
    write({ phase: "exited", code: resultCode, outcome, timestamp: now() });
  }
  process.exit(0);
});
