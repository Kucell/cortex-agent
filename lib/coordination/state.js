"use strict";

// ─── Coordination State Machine Reducer (T-ACN-004) ────────────────────────
// Deterministic reducer that advances a CoordinationTask state by applying a
// single validated coordination event. Pure: (state, event) -> state. No I/O,
// no wall-clock timestamps (all time comes from the event), no Math.random.
//
// Responsibilities (CP-1, see P-001 §5, §6.3, §14.5):
//   * revision / lastSequence bookkeeping (snapshot CAS + idempotency).
//   * idempotent replay: same event never produces a second state transition.
//   * illegal transition -> fail closed, state unchanged (§5.3).
//   * sequence gap / out-of-order -> fail closed, never guess state (§6.3).
//   * previousState mismatch (stale/concurrent event) -> fail closed (§14.5).
//   * ABSENT only allows task.created.
//   * task.completed protects Run.phase (assertCompletedSyncToRun, §15.3).
//
// Zero external dependencies. Reuses the frozen contract (T-ACN-002) and error
// codes (T-ACN-002). Does NOT import journal/lease/CLI modules.

const {
  SCHEMA_VERSION,
  STATES,
  createTaskState,
  validateEvent,
  validateTaskState,
  assertValidTransition,
  assertAbsentState,
  assertCompletedSyncToRun,
  isCriticalEventType,
} = require("./contract");
const { CoordinationError } = require("./errors");

// ─── Liveness / bookkeeping event types ─────────────────────────────────────
// Events that may legally carry previousState === currentState (a no-op state
// change) and only mutate bookkeeping fields (progress, heartbeat, evidence).
// Any other same-state event is rejected as an illegal transition (fail closed).

const LIVENESS_EVENT_TYPES = new Set([
  "task.heartbeat",
  "task.progress",
  "artifact.ready",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractAssignee(event) {
  if (event.targets && event.targets.length && event.targets[0] && event.targets[0].actorId) {
    return event.targets[0].actorId;
  }
  if (event.producer && event.producer.actorId) {
    return event.producer.actorId;
  }
  return null;
}

function appendUnique(list, items) {
  const out = Array.isArray(list) ? list.slice() : [];
  const seen = new Set(out);
  for (const item of items) {
    if (!seen.has(item)) {
      out.push(item);
      seen.add(item);
    }
  }
  return out;
}

// Build the initial task state from a task.created event.
// Deterministic: all timestamps come from the event, never wall-clock.
function createInitialState(event) {
  const task = createTaskState({
    taskId: event.taskId,
    projectId: event.projectId,
    parentTaskId: event.parentTaskId,
    correlationId: event.correlationId,
    state: event.currentState,
    assignee: null,
    createdBy: event.producer.actorId,
    ownership: event.fileOwnership && event.fileOwnership.length ? event.fileOwnership.slice() : [],
    requestedAction: null,
    evidenceRefs: [],
    pendingCriticalEvents: [],
    operationId: event.operationId || null,
    operationAttempt: event.operationAttempt != null ? event.operationAttempt : null,
    producerSequences: {},
  });
  const ts = event.timestamp || task.createdAt;
  task.createdAt = ts;
  task.updatedAt = ts;
  task.revision = 1;
  task.lastSequence = event.sequence;
  task.producerSequences[event.producer.actorId] = event.sequence;
  task.lastEventId = event.eventId;
  task.lastEventAt = ts;
  task.progress = event.progress || null;
  task.heartbeatDueAt = null;
  task.lastHeartbeatAt = null;
  return task;
}

// Apply a validated, transition-legal event to a state. Pure.
function applyEventToState(state, event, isInitial) {
  const ts = event.timestamp || (state ? state.updatedAt : new Date().toISOString());
  const next = isInitial ? createInitialState(event) : { ...state };

  // state transition (event.currentState already validated as a legal target)
  next.state = event.currentState;

  // revision + lastSequence
  next.revision = isInitial ? 1 : (next.revision || 0) + 1;
  next.lastSequence = event.sequence;
  next.producerSequences = { ...(next.producerSequences || {}) };
  next.producerSequences[event.producer.actorId] = event.sequence;
  next.updatedAt = ts;
  next.lastEventId = event.eventId;
  next.lastEventAt = ts;

  // progress payload (mirror; Run.phase protection handled separately)
  if (event.progress) next.progress = event.progress;

  // heartbeat liveness
  if (event.eventType === "task.heartbeat") {
    next.heartbeatDueAt = event.expiresAt || null;
    next.lastHeartbeatAt = ts;
  }

  // assignee lifecycle
  if (event.eventType === "task.assigned") {
    next.assignee = extractAssignee(event);
  } else if (event.eventType === "task.taken_over") {
    next.assignee = (event.producer && event.producer.actorId) || next.assignee;
  } else if (event.eventType === "task.cancelled") {
    next.assignee = null;
  }

  // file ownership lifecycle
  const acquires = event.eventType === "task.assigned"
    || event.eventType === "ownership.acquired"
    || event.eventType === "task.accepted"
    || event.eventType === "task.taken_over";
  const releases = event.eventType === "ownership.released" || event.eventType === "task.cancelled";
  if (acquires && event.fileOwnership && event.fileOwnership.length) {
    next.ownership = event.fileOwnership.slice();
  } else if (releases) {
    next.ownership = [];
  }

  // requested action
  if (event.eventType === "task.input_required") {
    next.requestedAction = event.requestedAction || null;
  } else if (event.eventType === "task.progress") {
    // input/blocker resolved -> clear requested action
    next.requestedAction = null;
  }

  // evidence refs (append-only, deduped)
  if ((event.eventType === "task.ready_for_review" || event.eventType === "artifact.ready")
      && event.evidence && event.evidence.length) {
    const refs = event.evidence.map((e) => e.ref).filter(Boolean);
    next.evidenceRefs = appendUnique(next.evidenceRefs, refs);
  }

  // pending critical events (append-only; ACK pruning is the consumer's job)
  if (isCriticalEventType(event.eventType)) {
    next.pendingCriticalEvents = appendUnique(next.pendingCriticalEvents, [event.eventId]);
  }

  // operation identity
  if (event.operationId) next.operationId = event.operationId;
  if (event.operationAttempt != null) next.operationAttempt = event.operationAttempt;

  // correlation
  if (event.correlationId) next.correlationId = event.correlationId;

  return next;
}

// ─── Reducer ────────────────────────────────────────────────────────────────
//
// reduce(state, event, options) -> {
//   state, applied, duplicate, ignored, eventId, sequence, fromState, toState, revision
// }
//
// state:   current task state, or null/undefined for ABSENT (before task.created).
// event:   a coordination event (validated envelope; see options.validateEnvelope).
// options: { validateEnvelope: true|false }
//
// Fail-closed throws (state is NEVER mutated on throw):
//   ERR_INVALID_EVENT / ERR_INVALID_EVENT_TYPE  - bad envelope or sequence type
//   ERR_SEQUENCE_GAP                            - sequence > lastSequence + 1
//   ERR_ABSENT_NO_EVENT                         - non-task.created from ABSENT
//   ERR_REVISION_MISMATCH                       - event.previousState != actual state
//   ERR_COMPLETED_RUN_PHASE_PROTECTED           - task.completed carries progress.phase
//   ERR_INVALID_TRANSITION / ERR_EVENT_NOT_LEGAL / ERR_MISSING_EVIDENCE /
//   ERR_MISSING_REQUESTED_ACTION                - illegal or incomplete transition
//
// Idempotent no-op (returns existing state, applied=false, duplicate=true):
//   event.sequence <= state.lastSequence  (replay / out-of-order older event)

function reduce(state, event, options = {}) {
  if (event === null || event === undefined || typeof event !== "object") {
    throw new CoordinationError("ERR_INVALID_EVENT", { details: { reason: "event must be an object" } });
  }
  if (options.validateEnvelope !== false) {
    validateEvent(event);
  }

  const isInitial = state === null || state === undefined;
  const actualState = isInitial ? null : state.state;

  // sequence type guard (fail closed on non-numeric sequence)
  if (typeof event.sequence !== "number" || !Number.isFinite(event.sequence)) {
    throw new CoordinationError("ERR_INVALID_EVENT", {
      details: { reason: "sequence must be a finite number", sequence: event.sequence, taskId: event.taskId },
    });
  }

  const actorId = event.producer && event.producer.actorId;
  const producerSequences = isInitial ? {} : (state.producerSequences || {});
  const lastSeq = producerSequences[actorId] || 0;

  // idempotent replay: sequence already applied -> no side effects, allow ACK (§14.5)
  if (event.sequence <= lastSeq) {
    return {
      state,
      applied: false,
      duplicate: true,
      ignored: false,
      eventId: event.eventId,
      sequence: event.sequence,
      fromState: actualState,
      toState: event.currentState,
      revision: isInitial ? 0 : state.revision,
    };
  }

  // sequence gap: fail closed, do not guess intermediate state (§6.3, §14.5)
  if (event.sequence > lastSeq + 1) {
    throw new CoordinationError("ERR_SEQUENCE_GAP", {
      details: {
        taskId: event.taskId,
        expected: lastSeq + 1,
        actual: event.sequence,
        lastSequence: lastSeq,
      },
    });
  }

  // state authority
  if (isInitial) {
    // ABSENT only allows task.created
    assertAbsentState(event.eventType);
  } else {
    // event must have been computed against the current state; stale -> reconcile
    const declaredPrev = event.previousState === undefined ? null : event.previousState;
    if (declaredPrev !== actualState) {
      throw new CoordinationError("ERR_REVISION_MISMATCH", {
        details: {
          taskId: event.taskId,
          actualState,
          declaredPreviousState: declaredPrev,
          eventId: event.eventId,
          reason: "event previousState does not match current state",
        },
      });
    }
  }

  // Run.phase protection: COMPLETED sync to Run may only append, never overwrite phase (§15.3)
  assertCompletedSyncToRun(event);

  // transition validation
  const fromState = actualState;
  const toState = event.currentState;
  const sameState = fromState === toState;
  if (sameState) {
    // no-op state change: only liveness/bookkeeping types allowed (fail closed otherwise)
    if (!LIVENESS_EVENT_TYPES.has(event.eventType)) {
      throw new CoordinationError("ERR_INVALID_TRANSITION", {
        details: {
          from: fromState,
          to: toState,
          eventType: event.eventType,
          reason: "same-state event not allowed for this event type",
        },
      });
    }
  } else {
    const tvOpts = {
      evidenceRefs: (event.evidence && event.evidence.length)
        ? event.evidence.map((e) => e.ref)
        : undefined,
      requestedAction: event.requestedAction || undefined,
    };
    assertValidTransition(fromState, toState, event.eventType, tvOpts);
  }

  // apply (pure)
  const next = applyEventToState(state, event, isInitial);
  // ensure the produced state is structurally valid
  validateTaskState(next);

  return {
    state: next,
    applied: true,
    duplicate: false,
    ignored: false,
    eventId: event.eventId,
    sequence: event.sequence,
    fromState,
    toState,
    revision: next.revision,
    sameState,
  };
}

// ─── Replay ─────────────────────────────────────────────────────────────────
//
// replay(events, options) -> { state, log }
//
// Reduces a sequence of events from ABSENT. Deterministic. Duplicates within
// the stream are no-ops (idempotent). A gap throws ERR_SEQUENCE_GAP (fail
// closed) — recovery from a gapped journal must not guess state.

function replay(events, options = {}) {
  if (!Array.isArray(events)) {
    throw new CoordinationError("ERR_INVALID_EVENT", {
      details: { reason: "replay expects an array of events" },
    });
  }
  let state = null;
  const log = [];
  for (const event of events) {
    const result = reduce(state, event, options);
    if (result.applied) state = result.state;
    log.push({
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.eventType,
      applied: result.applied,
      duplicate: result.duplicate,
      revision: result.revision,
    });
  }
  return { state, log };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  STATES,
  LIVENESS_EVENT_TYPES,
  reduce,
  replay,
  createInitialState,
  applyEventToState,
  extractAssignee,
};
