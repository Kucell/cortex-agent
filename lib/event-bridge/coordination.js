"use strict";

const {
  canonicalEventId,
  createRef,
  normalizeCortexEvent,
} = require("../../packages/protocol/src/index.js");
const { validateEvent } = require("../coordination/contract.js");

function normalizeCoordinationEvent(event, options = {}) {
  validateEvent(event);

  const sessionId = event.producer && event.producer.sessionId
    ? event.producer.sessionId
    : null;
  const evidenceRefs = Array.isArray(event.evidence)
    ? event.evidence.map((item) => item.ref).filter(Boolean)
    : [];

  return normalizeCortexEvent({
    event_id: canonicalEventId("coordination", event.eventId),
    type: `coordination.${event.eventType}`,
    occurred_at: event.timestamp,
    source: {
      kind: "coordination",
      source_event_id: event.eventId,
      producer_id: event.producer.actorId,
      producer_kind: event.producer.kind,
      project_ref: createRef("project", event.projectId),
      host_ref: options.host_ref || null,
      runtime_ref: options.runtime_ref || null,
    },
    correlation: {
      mission_id: options.mission_id || null,
      milestone_id: options.milestone_id || null,
      task_id: event.taskId,
      operation_id: event.operationId || null,
      correlation_id: event.correlationId,
      run_ref: options.run_ref || null,
      session_ref: sessionId ? createRef("session", sessionId) : null,
      workspace_ref: options.workspace_ref || null,
    },
    sequence: {
      stream_id: `coordination:${event.taskId}:${event.producer.actorId}`,
      value: event.sequence,
    },
    causation_id: options.causation_id || null,
    payload: {
      previous_state: event.previousState,
      current_state: event.currentState,
      operation_attempt: event.operationAttempt || null,
      parent_task_id: event.parentTaskId || null,
    },
    evidence_refs: evidenceRefs,
    redacted: true,
  });
}

module.exports = {
  normalizeCoordinationEvent,
};
