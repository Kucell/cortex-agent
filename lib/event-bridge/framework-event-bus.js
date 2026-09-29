"use strict";

const {
  canonicalEventId,
  createRef,
  normalizeCortexEvent,
} = require("../../packages/protocol/src/index.js");
const { validateEvent } = require("../event-bus/event-types.js");

const TYPE_MAP = Object.freeze({
  subagent_spawned: "agent.subagent.spawned",
  subagent_progress: "agent.subagent.progress",
  subagent_completed: "agent.subagent.completed",
  subagent_failed: "agent.subagent.failed",
  subagent_cancelled: "agent.subagent.cancelled",
  handoff_ready: "handoff.ready",
  decision_resolved: "decision.resolved",
  waitpoint_released: "waitpoint.released",
});

function customType(name) {
  const raw = String(name || "").slice("custom:".length).toLowerCase();
  const body = raw
    .replace(/[^a-z0-9-]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  return body ? `extension.custom.${body}` : "extension.custom.event";
}

function canonicalFrameworkType(name) {
  if (TYPE_MAP[name]) return TYPE_MAP[name];
  if (typeof name === "string" && name.startsWith("custom:")) return customType(name);
  const error = new Error(`Unsupported Framework Event Bus type: ${name}`);
  error.code = "ERR_FRAMEWORK_EVENT_TYPE";
  throw error;
}

function nonGlobal(value) {
  return value && value !== "global" && value !== "host" ? value : null;
}

function normalizeFrameworkEvent(event, options = {}) {
  const validation = validateEvent(event);
  if (!validation.valid) {
    const error = new Error(`Invalid Framework Event Bus event: ${validation.errors.join("; ")}`);
    error.code = "ERR_FRAMEWORK_EVENT_INVALID";
    error.details = { errors: validation.errors };
    throw error;
  }

  const parentRunId = nonGlobal(event.correlation.parent_run_id);
  const sessionId = event.producer.session_id || null;
  const sequence = Number.isSafeInteger(options.sequence)
    ? {
        stream_id: options.stream_id || `framework:${event.bus_id}`,
        value: options.sequence,
      }
    : null;

  return normalizeCortexEvent({
    event_id: canonicalEventId("framework", event.event_id),
    type: canonicalFrameworkType(event.event_name),
    occurred_at: event.occurred_at,
    source: {
      kind: "framework",
      source_event_id: event.event_id,
      producer_id: event.producer.producer_id,
      producer_kind: event.producer.producer_kind,
      project_ref: options.project_ref || null,
      host_ref: options.host_ref || null,
      runtime_ref: options.runtime_ref || null,
    },
    correlation: {
      mission_id: nonGlobal(event.correlation.mission_id),
      trace_id: nonGlobal(event.correlation.subagent_id),
      run_ref: parentRunId ? createRef("run", parentRunId) : null,
      session_ref: sessionId ? createRef("session", sessionId) : null,
      correlation_id: options.correlation_id || null,
    },
    sequence,
    causation_id: event.correlation.causation_id
      ? canonicalEventId("framework", event.correlation.causation_id)
      : null,
    payload: { ...event.payload },
    evidence_refs: options.evidence_refs || [],
    redacted: options.redacted === true,
  });
}

module.exports = {
  TYPE_MAP,
  canonicalFrameworkType,
  normalizeFrameworkEvent,
};
