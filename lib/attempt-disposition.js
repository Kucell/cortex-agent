"use strict";

// ─── Attempt Disposition (T-ACN-019 / P-005) ─────────────────────────────────
//
// Deterministic, read-only derivation of an *execution attempt* observation
// on top of an existing Coordination Task state. P-005 keeps the public Task
// state machine fail-closed and adds a parallel observation layer so a host
// heartbeat can stop polling a Task whose execution attempt is already over.
//
// Vocabulary (P-005 §3 / §4):
//
//   attempt_active             — child / lease / agent still alive; keep observing
//   attempt_review_ready       — Task already has READY_FOR_REVIEW + evidence
//   attempt_attention_required — Task is BLOCKED / FAILED / INPUT_REQUIRED and the
//                                 child has exited with the lease released
//   attempt_closed             — Task is terminal (COMPLETED / CANCELLED) or a
//                                 reconciliation / handoff has been recorded
//   attempt_inconsistent       — Task state, lease state, registry, or receipt
//                                 contradict each other and must not be silently
//                                 promoted to a normal closure
//
// The disposition is *derived*, never written to the coordination journal.
// The same inputs must always yield the same output; the only allowed side
// effect is for the caller to write `monitoring_terminal=true` to its private
// monitor receipt, which terminates the host's recurring poll without
// mutating the Task state machine.
//
// Privacy contract (P-005 §4 / launch-governed-agent.md):
//   - Inputs MUST be the small, scrubbed public projections (Task state, lease
//     observability flags, last receipt code). They MUST NOT include the
//     private launch context, agentCommand, agentArgs, leaseId, fencingToken,
//     sessionId, prompt, response, or path bodies.
//   - Outputs MUST stay redacted. `monitoring_terminal` only carries the
//     boolean signal; callers append stable `attempt_disposition` and
//     `observed_at` fields to their monitor receipt.

const TERMINAL_TASK_STATES = Object.freeze({
  COMPLETED: true,
  CANCELLED: true,
});

const REVIEW_READY_TASK_STATES = Object.freeze({
  READY_FOR_REVIEW: true,
});

const ATTENTION_TASK_STATES = Object.freeze({
  BLOCKED: true,
  FAILED: true,
  WAITING_FOR_INPUT: true,
});

const HANDOFF_TASK_STATES = Object.freeze({
  READY_FOR_REVIEW: true,
  COMPLETED: true,
  CANCELLED: true,
});

const ATTEMPT_DISPOSITIONS = Object.freeze([
  "attempt_active",
  "attempt_review_ready",
  "attempt_attention_required",
  "attempt_closed",
  "attempt_inconsistent",
]);

const ATTEMPT_DISPOSITION_SET = new Set(ATTEMPT_DISPOSITIONS);

function isPlainString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeTaskState(input) {
  if (!input || typeof input !== "object") return null;
  return isPlainString(input.state) ? input.state : null;
}

function normalizeLeaseState(input) {
  if (!input || typeof input !== "object") {
    return Object.freeze({ active: false, released: true, stale: true, present: false });
  }
  return Object.freeze({
    active: input.active === true,
    released: input.released === true,
    stale: input.stale === true,
    present: input.present === true,
    fencingToken: Number.isInteger(input.fencingToken) ? input.fencingToken : null,
  });
}

function normalizeAgentActivity(input) {
  if (!input || typeof input !== "object") {
    return Object.freeze({ active: false, observed: false });
  }
  return Object.freeze({
    active: input.active === true,
    observed: input.observed === true,
  });
}

function normalizeReceiptCode(input) {
  if (!isPlainString(input)) return null;
  return input;
}

function nowIso(clock) {
  if (typeof clock === "function") {
    const value = clock();
    if (isPlainString(value)) return value;
  }
  return new Date().toISOString();
}

// ─── Public projection ──────────────────────────────────────────────────────

function deriveAttemptDisposition(input = {}) {
  const taskState = normalizeTaskState(input.taskState);
  const leaseState = normalizeLeaseState(input.leaseState);
  const agentActivity = normalizeAgentActivity(input.agentActivity);
  const receiptCode = normalizeReceiptCode(input.receiptCode);
  const handoffRecorded = input.handoffRecorded === true;
  const reconciliationRecorded = input.reconciliationRecorded === true;

  // Inconsistency first — never mask a governance conflict as a benign closure.
  const leaseAndTaskConflict = taskState === "ACCEPTED" && leaseState.present && leaseState.stale
    || taskState === "ACCEPTED" && leaseState.present && leaseState.active === false
    || taskState === "EXECUTING" && leaseState.present && leaseState.active === false
    || taskState === "EXECUTING" && agentActivity.active === true && leaseState.present === false;
  if (leaseAndTaskConflict) {
    return Object.freeze({
      disposition: "attempt_inconsistent",
      monitoringTerminal: true,
      reconciliationRequired: true,
      notify: true,
      observedAt: nowIso(input.clock),
      reason: "lease/task/agent state conflict",
    });
  }

  if (REVIEW_READY_TASK_STATES[taskState] || handoffRecorded) {
    return Object.freeze({
      disposition: "attempt_review_ready",
      monitoringTerminal: true,
      reconciliationRequired: false,
      notify: true,
      observedAt: nowIso(input.clock),
      reason: handoffRecorded ? "handoff recorded" : "task already in review-ready state",
    });
  }

  if (TERMINAL_TASK_STATES[taskState] || reconciliationRecorded) {
    return Object.freeze({
      disposition: "attempt_closed",
      monitoringTerminal: true,
      reconciliationRequired: false,
      notify: true,
      observedAt: nowIso(input.clock),
      reason: reconciliationRecorded ? "reconciliation recorded" : "task already terminal",
    });
  }

  // A Task in an attention state (BLOCKED / FAILED / WAITING_FOR_INPUT) is
  // never silently "active": it must either be reconciled or be marked
  // inconsistent. P-005 §5.2 explicitly forbids writing the Task when an
  // active owner or fencing drift still exists, so we promote that case to
  // `attempt_inconsistent` instead of returning `attempt_active`.
  if (ATTENTION_TASK_STATES[taskState]) {
    const activeOwnerLingering = agentActivity.active === true
      && leaseState.active === true
      && leaseState.released === false;
    if (activeOwnerLingering) {
      return Object.freeze({
        disposition: "attempt_inconsistent",
        monitoringTerminal: true,
        reconciliationRequired: true,
        notify: true,
        observedAt: nowIso(input.clock),
        reason: `task ${taskState} with a lingering active owner — fenced reconciliation required`,
      });
    }
    return Object.freeze({
      disposition: "attempt_attention_required",
      monitoringTerminal: true,
      reconciliationRequired: true,
      notify: true,
      observedAt: nowIso(input.clock),
      reason: `task ${taskState} with no live attempt observation (receipt=${receiptCode || "unknown"})`,
    });
  }

  if (leaseState.active === false && leaseState.present === false
      && (taskState === "ACCEPTED" || taskState === "EXECUTING" || taskState === "TESTING")) {
    return Object.freeze({
      disposition: "attempt_attention_required",
      monitoringTerminal: true,
      reconciliationRequired: true,
      notify: true,
      observedAt: nowIso(input.clock),
      reason: "execution attempt ended without explicit handoff",
    });
  }

  return Object.freeze({
    disposition: "attempt_active",
    monitoringTerminal: false,
    reconciliationRequired: false,
    notify: false,
    observedAt: nowIso(input.clock),
    reason: "execution attempt is still active",
  });
}

// ─── Read-only projection for the Management API / dashboard ─────────────────
//
// Reads ONLY through the CoordinationApplicationService public surface. It
// composes the existing Task state + lease state + agent activity into a
// single Attempt projection. It does NOT mutate the journal, lease store,
// snapshot, or any other durable state.

function buildAttemptProjection(service, taskId, options = {}) {
  if (!service || typeof service.getTask !== "function") {
    return { ok: false, code: "ERR_SERVICE_UNAVAILABLE" };
  }
  if (typeof taskId !== "string" || taskId.length === 0) {
    return { ok: false, code: "ERR_TASK_ID_REQUIRED" };
  }
  const taskState = service.getTask(taskId);
  if (!taskState) {
    return { ok: false, code: "ERR_TASK_NOT_FOUND" };
  }
  let lastEventType = null;
  let handoffRecorded = false;
  let reconciliationRecorded = false;
  if (typeof service.listEvents === "function") {
    const events = service.listEvents({ taskId });
    if (Array.isArray(events) && events.length > 0) {
      lastEventType = events[events.length - 1].eventType || null;
      handoffRecorded = events.some((event) => event && event.eventType === "task.ready_for_review");
      reconciliationRecorded = events.some((event) => event
        && (event.eventType === "task.testing"
          || (event.message && typeof event.message === "string"
            && /reconcil/i.test(event.message))));
    }
  }

  let leaseProjection = { active: false, released: true, stale: false, present: false, fencingToken: null };
  if (service.leases) {
    const scope = `task:${taskId}`;
    let activeLease = null;
    if (typeof service.leases.listActiveLeases === "function") {
      const active = service.leases.listActiveLeases({ scope });
      if (Array.isArray(active) && active.length > 0) activeLease = active[0];
    }
    if (!activeLease && typeof service.leases.listByScope === "function") {
      const scoped = service.leases.listByScope(scope);
      if (Array.isArray(scoped)) {
        activeLease = scoped.find((lease) => lease && lease.releasedAt == null && lease.staleAt == null) || null;
      }
    }
    if (activeLease) {
      leaseProjection = {
        active: true,
        released: false,
        stale: false,
        present: true,
        fencingToken: Number.isInteger(activeLease.fencingToken) ? activeLease.fencingToken : null,
      };
    } else if (typeof service.leases.listByScope === "function") {
      const scoped = service.leases.listByScope(scope);
      if (Array.isArray(scoped) && scoped.length > 0) {
        const released = scoped.find((lease) => lease && lease.releasedAt);
        const stale = scoped.find((lease) => lease && lease.staleAt);
        leaseProjection = {
          active: false,
          released: Boolean(released),
          stale: Boolean(stale),
          present: true,
          fencingToken: null,
        };
      }
    }
  }

  const agentActivity = taskState.assignee
    ? {
        active: leaseProjection.active === true,
        observed: leaseProjection.active === true,
      }
    : { active: false, observed: false };

  const disposition = deriveAttemptDisposition({
    taskState: { state: taskState.state },
    leaseState: leaseProjection,
    agentActivity,
    handoffRecorded,
    reconciliationRecorded,
    clock: options.clock,
  });

  return Object.freeze({
    ok: true,
    taskId,
    taskState: taskState.state,
    leaseState: leaseProjection,
    lastEventType,
    handoffRecorded,
    reconciliationRecorded,
    disposition: disposition.disposition,
    monitoringTerminal: disposition.monitoringTerminal,
    reconciliationRequired: disposition.reconciliationRequired,
    observedAt: disposition.observedAt,
  });
}

module.exports = {
  ATTEMPT_DISPOSITIONS,
  ATTEMPT_DISPOSITION_SET,
  TERMINAL_TASK_STATES,
  ATTENTION_TASK_STATES,
  HANDOFF_TASK_STATES,
  deriveAttemptDisposition,
  buildAttemptProjection,
};