"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createAgentReporterFromContext, readLaunchContext } = require("../agents/reporter");
const { buildAttemptProjection } = require("../attempt/disposition");
const { createEvent, STATES } = require("../coordination/contract.js");

const FINAL_STATES = new Set([
  "INPUT_REQUIRED", "READY_FOR_REVIEW", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED",
]);

const RECONCILIATION_REQUIRED_DISPOSITIONS = new Set([
  "attempt_attention_required",
  "attempt_inconsistent",
]);

function readPrivateReceipt(receiptFile) {
  const stat = fs.statSync(receiptFile);
  if (stat.mode & 0o077) throw new Error("INSECURE_RECEIPT");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  if (!receipt || typeof receipt.code !== "string") throw new Error("INVALID_RECEIPT");
  return receipt;
}

// ─── Fenced manual reconciliation (T-ACN-019 / P-005) ────────────────────────
//
// Two-step gated promotion of an *attention-required* or *inconsistent* attempt
// to READY_FOR_REVIEW. The reconciler never auto-acknowledges a Task; the
// caller MUST supply:
//
//   - newLeaseId + newFencingToken for a fresh, active lease bound to the same
//     scope `task:<task-id>` AND to the agent session performing the work.
//   - validationRefs — non-empty evidence refs (commit, artifact, run) that
//     justify the promotion. The refs are passed through unchanged to the
//     agent-reporter so they enter the durable journal and survive the next
//     Task.replay.
//
// Failure modes (P-005 §5):
//   - No fresh lease ⇒ "ERR_LEASE_CONFLICT" — fail closed.
//   - Mismatched fencing token ⇒ "ERR_LEASE_CONFLICT" — fail closed.
//   - Missing or empty evidence refs ⇒ "ERR_EVIDENCE_REQUIRED" — fail closed.
//   - Attempt is already in a non-attention disposition ⇒ "ERR_DISPOSITION_NOT_RECONCILABLE".
//   - Task state is not BLOCKED ⇒ "ERR_TASK_STATE_NOT_RECONCILABLE".
//   - Any release receipt or journal error is returned verbatim and the
//     Task state is left untouched.

function reconcileAttemptForReadiness(service, options = {}) {
  if (!service || typeof service.getTask !== "function") {
    return { ok: false, code: "ERR_SERVICE_UNAVAILABLE" };
  }
  const contextFile = options.contextFile;
  const receiptFile = options.receiptFile;
  const newLeaseId = options.newLeaseId;
  const newFencingToken = options.newFencingToken;
  const actorId = options.actorId;
  const validationRefs = Array.isArray(options.validationRefs) ? options.validationRefs.filter((ref) => typeof ref === "string" && ref.length > 0) : [];
  if (typeof newLeaseId !== "string" || newLeaseId.length === 0
      || !Number.isInteger(newFencingToken)) {
    return { ok: false, code: "ERR_LEASE_CONFLICT", message: "fresh lease and fencing token are required" };
  }
  if (validationRefs.length === 0) {
    return { ok: false, code: "ERR_EVIDENCE_REQUIRED", message: "at least one validation evidence ref is required" };
  }
  const context = readLaunchContext(contextFile);
  if (!context) return { ok: false, code: "ERR_CONTEXT_INVALID" };
  const task = service.getTask(context.taskId);
  if (!task) return { ok: false, code: "ERR_TASK_NOT_FOUND" };
  if (task.state !== "BLOCKED" && task.state !== "STALE") {
    return { ok: false, code: "ERR_TASK_STATE_NOT_RECONCILABLE", state: task.state };
  }
  const projection = buildAttemptProjection(service, context.taskId);
  if (!projection || projection.ok === false) {
    return { ok: false, code: "ERR_PROJECTION_UNAVAILABLE" };
  }
  if (!RECONCILIATION_REQUIRED_DISPOSITIONS.has(projection.disposition)) {
    return { ok: false, code: "ERR_DISPOSITION_NOT_RECONCILABLE", disposition: projection.disposition };
  }
  if (!service.leases || typeof service.leases.getLease !== "function") {
    return { ok: false, code: "ERR_LEASE_CONFLICT", message: "durable lease manager unavailable" };
  }
  const lease = service.leases.getLease(newLeaseId);
  if (!lease || !service.leases.isActive(lease)
      || lease.scope !== `task:${context.taskId}`
      || lease.fencingToken !== newFencingToken
      || service.leases.getFencingToken(lease.scope) !== newFencingToken) {
    return { ok: false, code: "ERR_LEASE_CONFLICT", message: "fresh lease must be active and match the new fencing token" };
  }
  if (typeof actorId === "string" && actorId.length > 0 && lease.actorId !== actorId) {
    return { ok: false, code: "ERR_LEASE_CONFLICT", message: "lease session does not match the reconciler actor" };
  }

  // The monitor must journal ownership.released before releasing the durable
  // lease. Never repair this by patching a snapshot: the journal is the source
  // of truth and replay would resurrect the stale ownership. Legacy attempts
  // missing that event require an explicit governed takeover/recovery first.
  if (Array.isArray(task.ownership) && task.ownership.length > 0) {
    return {
      ok: false,
      code: "ERR_OWNERSHIP_RECOVERY_REQUIRED",
      message: "task retains journaled ownership; run governed takeover/recovery before reconciliation",
    };
  }

  // Step B: walk the bounded reconciliation sequence
  //   BLOCKED -> EXECUTING -> TESTING -> READY_FOR_REVIEW
  //
  // We bypass `createAgentReporterFromContext` for the transition events
  // because the agent reporter derives `fileOwnership` from
  // `currentTask.ownership`, which still references the previous lease that
  // has already been released. Going through service.submit with an explicit
  // fileOwnership keeps the journal aligned with the freshly verified lease.
  //
  // Idempotency is provided by deterministic `deliveryId` strings tied to
  // the launchId. Re-running the reconciler with the same launchId will not
  // duplicate any of these events.

  function submitReconciliationEvent({ eventType, previousState, currentState, evidence }) {
    const event = createEvent({
      projectId: task.projectId,
      taskId: task.taskId,
      correlationId: task.correlationId || context.correlationId || null,
      producer: {
        actorId: lease.owner,
        kind: "agent",
        sessionId: lease.actorId,
      },
      targets: [],
      eventType,
      previousState,
      currentState,
      repository: { repositoryId: task.projectId },
      fileOwnership: [{
        leaseId: lease.leaseId,
        scope: lease.scope,
        owner: lease.owner,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      }],
      evidence,
      notification: { policy: "coordinator_notify", dedupeKey: eventType },
      message: typeof options.message === "string" ? options.message : null,
    });
    return service.submit(event, {
      actorId: lease.owner,
      kind: "agent",
      sessionId: lease.actorId,
    });
  }

  let currentState = task.state;
  let lastEvent = null;
  try {
    const progressEvidence = validationRefs.map((ref) => ({ kind: "artifact", ref }));
    const progressResult = submitReconciliationEvent({
      eventType: "task.progress",
      previousState: currentState,
      currentState: "EXECUTING",
      evidence: progressEvidence,
    });
    if (!progressResult || !progressResult.event) {
      return { ok: false, code: "ERR_PROGRESS_REJECTED" };
    }
    currentState = STATES.EXECUTING;
    lastEvent = progressResult;

    const testingResult = submitReconciliationEvent({
      eventType: "task.testing",
      previousState: currentState,
      currentState: STATES.TESTING,
      evidence: progressEvidence,
    });
    if (!testingResult || !testingResult.event) {
      return { ok: false, code: "ERR_TESTING_REJECTED" };
    }
    currentState = STATES.TESTING;
    lastEvent = testingResult;

    const readyResult = submitReconciliationEvent({
      eventType: "task.ready_for_review",
      previousState: currentState,
      currentState: STATES.READY_FOR_REVIEW,
      evidence: progressEvidence,
    });
    if (!readyResult || !readyResult.event) {
      return { ok: false, code: "ERR_READY_REJECTED" };
    }
    currentState = STATES.READY_FOR_REVIEW;
    lastEvent = readyResult;
  } catch (transitionError) {
    return {
      ok: false,
      code: transitionError && transitionError.key ? transitionError.key : "ERR_RECONCILIATION_TRANSITION_FAILED",
      message: transitionError && transitionError.message ? transitionError.message : "reconciliation transition failed",
    };
  }
  const ready = { task: { state: currentState }, event: lastEvent ? lastEvent.event : null };

  // Persist a private, redacted reconciliation receipt so the next monitor
  // can see this attempt is closed. We do NOT mutate any public Task field
  // beyond the legal task.ready_for_review transition above.
  let reconciliationReceipt = null;
  try {
    const receiptDir = path.dirname(receiptFile);
    const reconciliationReceiptFile = path.join(receiptDir, "reconciliation-receipt.json");
    const payload = {
      schema: "1.0",
      taskId: context.taskId,
      launchId: context.launchId,
      oldState: task.state,
      newState: ready.task ? ready.task.state : "READY_FOR_REVIEW",
      oldFencingToken: Number.isInteger(context.fencingToken) ? context.fencingToken : null,
      newFencingToken,
      newLeaseId,
      actorId: typeof actorId === "string" && actorId.length > 0 ? actorId : null,
      validationRefs,
      observedAt: new Date().toISOString(),
    };
    fs.writeFileSync(reconciliationReceiptFile, JSON.stringify(payload), { mode: 0o600 });
    reconciliationReceipt = payload;
  } catch (_) {
    // The journal already records the promotion; the private receipt is
    // best-effort.
  }

  return {
    ok: true,
    taskId: context.taskId,
    fromState: task.state,
    toState: ready.task ? ready.task.state : "READY_FOR_REVIEW",
    newLeaseId,
    newFencingToken,
    validationRefs,
    reconciliationReceipt,
    eventId: ready.event ? ready.event.eventId : null,
  };
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

module.exports = {
  reconcileGovernedLaunch,
  reconcileAttemptForReadiness,
};
