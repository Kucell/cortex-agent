"use strict";

const fs = require("node:fs");
const { createAgentReporterFromContext, readLaunchContext } = require("./agent-reporter");

const FINAL_STATES = new Set([
  "INPUT_REQUIRED", "READY_FOR_REVIEW", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED",
]);

function readPrivateReceipt(receiptFile) {
  const stat = fs.statSync(receiptFile);
  if (stat.mode & 0o077) throw new Error("INSECURE_RECEIPT");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  if (!receipt || typeof receipt.code !== "string") throw new Error("INVALID_RECEIPT");
  return receipt;
}

function reconcileGovernedLaunch(service, options = {}) {
  const context = readLaunchContext(options.contextFile);
  if (!context) return { ok: false, code: "CONTEXT_INVALID" };
  let receipt;
  try {
    receipt = readPrivateReceipt(options.receiptFile);
  } catch (error) {
    return { ok: false, code: error.message || "RECEIPT_INVALID" };
  }
  const task = service.getTask(context.taskId);
  if (!task) return { ok: false, code: "TASK_NOT_FOUND" };

  let outcome = "ALREADY_FINAL";
  if (!FINAL_STATES.has(task.state)) {
    const reporter = createAgentReporterFromContext(service, { contextFile: options.contextFile });
    if (task.state === "ACCEPTED" || task.state === "STALE" || task.state === "TAKEN_OVER") {
      const progress = reporter.report("task.progress", {
        message: "Recovered governed launch before finalization",
        deliveryId: `reconcile-progress:${context.launchId}`,
        notificationPolicy: "journal_only",
      });
      if (!progress.ok && progress.code !== "ERR_DUPLICATE_DELIVERY") {
        return { ok: false, code: progress.code || "PROGRESS_REJECTED" };
      }
    }
    const eventType = receipt.code === "EXIT_ABNORMAL" || receipt.code === "SPAWN_FAILED"
      ? "task.failed" : "task.blocked";
    const final = reporter.report(eventType, {
      message: eventType === "task.failed"
        ? "Recovered governed child abnormal exit"
        : "Recovered governed child exit without handoff",
      deliveryId: `reconcile-final:${context.launchId}:${eventType}`,
      notificationPolicy: "coordinator_notify",
    });
    if (!final.ok && final.code !== "ERR_DUPLICATE_DELIVERY") {
      return { ok: false, code: final.code || "FINAL_REJECTED" };
    }
    outcome = eventType === "task.failed" ? "REPORTED_FAILED" : "REPORTED_BLOCKED";
  }

  let leaseOutcome = "NOT_PRESENT";
  try {
    const lease = service.leases && service.leases.getLease(context.leaseId);
    if (lease && !lease.releasedAt && !lease.staleAt) {
      service.releaseOwnership(context.leaseId, {
        actorId: context.producer.sessionId,
        evidence: [`reconcile-${String(receipt.code).toLowerCase()}`],
      });
      leaseOutcome = "RELEASED";
    } else if (lease && lease.releasedAt) {
      leaseOutcome = "ALREADY_RELEASED";
    } else if (lease && lease.staleAt) {
      leaseOutcome = "ALREADY_STALE";
    }
  } catch (error) {
    leaseOutcome = error && (error.key || error.code) || "RELEASE_FAILED";
  }

  return {
    ok: true,
    taskId: context.taskId,
    outcome,
    leaseOutcome,
    receiptCode: receipt.code,
  };
}

module.exports = { reconcileGovernedLaunch };
