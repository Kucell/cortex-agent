"use strict";

const {
  canonicalEventId,
  createRef,
  normalizeCortexEvent,
} = require("../../packages/protocol/src/index.js");
const {
  validateBoundaryEvent,
} = require("../runtime-adapters/boundary-event.js");

function normalizeRuntimeBoundaryEvent(input, options = {}) {
  const event = validateBoundaryEvent(input);
  const correlation = event.correlation || {};
  const runtimeRef = options.runtime_ref
    || createRef("runtime", `native:${event.host.adapter_id}`);

  return normalizeCortexEvent({
    event_id: canonicalEventId("runtime", event.event_id),
    type: `runtime.${event.type}`,
    occurred_at: event.at,
    source: {
      kind: "runtime",
      source_event_id: event.event_id,
      producer_id: event.host.adapter_id,
      producer_kind: "runtime-adapter",
      project_ref: options.project_ref || null,
      host_ref: options.host_ref || null,
      runtime_ref: runtimeRef,
    },
    correlation: {
      mission_id: options.mission_id || null,
      milestone_id: options.milestone_id || null,
      task_id: correlation.task_id || null,
      operation_id: correlation.operation_id || null,
      trace_id: correlation.trace_id || null,
      correlation_id: options.correlation_id || null,
      run_ref: correlation.run_id ? createRef("run", correlation.run_id) : null,
      session_ref: correlation.session_id
        ? createRef("session", correlation.session_id)
        : null,
      workspace_ref: options.workspace_ref || null,
    },
    sequence: Number.isSafeInteger(options.sequence)
      ? {
          stream_id: options.stream_id || `runtime:${runtimeRef}`,
          value: options.sequence,
        }
      : null,
    causation_id: options.causation_id || null,
    payload: {
      resource: event.resource,
      capability: event.capability,
      decision: event.decision,
    },
    evidence_refs: event.evidence_refs || [],
    redacted: true,
  });
}

module.exports = {
  normalizeRuntimeBoundaryEvent,
};
