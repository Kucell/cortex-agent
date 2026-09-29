"use strict";

const { isRef } = require("./refs");

const CORTEX_EVENT_SCHEMA_VERSION = "1";
const CORTEX_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const SOURCE_KINDS = Object.freeze([
  "framework",
  "coordination",
  "runtime",
  "project",
  "extension",
  "control",
]);

const TOP_KEYS = new Set([
  "schema_version",
  "event_id",
  "type",
  "occurred_at",
  "source",
  "correlation",
  "sequence",
  "causation_id",
  "payload",
  "evidence_refs",
  "redacted",
]);

const SOURCE_KEYS = new Set([
  "kind",
  "source_event_id",
  "producer_id",
  "producer_kind",
  "project_ref",
  "host_ref",
  "runtime_ref",
]);

const CORRELATION_KEYS = new Set([
  "mission_id",
  "milestone_id",
  "task_id",
  "decision_id",
  "waitpoint_id",
  "operation_id",
  "trace_id",
  "correlation_id",
  "run_ref",
  "session_ref",
  "workspace_ref",
]);

const SEQUENCE_KEYS = new Set(["stream_id", "value"]);

class CortexEventError extends Error {
  constructor(code, details = {}) {
    super(`[cortex-event:${code}] ${JSON.stringify(details)}`);
    this.name = "CortexEventError";
    this.code = code;
    this.details = details;
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, known, where) {
  for (const key of Object.keys(value || {})) {
    if (!known.has(key)) {
      throw new CortexEventError("ERR_CORTEX_EVENT_FIELD_UNKNOWN", { where, key });
    }
  }
}

function requiredString(value, where) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_FIELD_INVALID", { where });
  }
  return value.trim();
}

function optionalString(value, where) {
  if (value == null) return null;
  return requiredString(value, where);
}

function timestamp(value) {
  const raw = requiredString(value, "occurred_at");
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new CortexEventError("ERR_CORTEX_EVENT_TIMESTAMP", { value });
  }
  return parsed.toISOString();
}

function optionalRef(value, kind, where) {
  if (value == null) return null;
  if (!isRef(value, kind)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_REF", { where, kind, value });
  }
  return value;
}

function normalizeSource(input) {
  if (!plain(input)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_SOURCE", {});
  }
  rejectUnknownKeys(input, SOURCE_KEYS, "source");
  if (!SOURCE_KINDS.includes(input.kind)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_SOURCE_KIND", { kind: input.kind });
  }
  return Object.freeze({
    kind: input.kind,
    source_event_id: requiredString(input.source_event_id, "source.source_event_id"),
    producer_id: optionalString(input.producer_id, "source.producer_id"),
    producer_kind: optionalString(input.producer_kind, "source.producer_kind"),
    project_ref: optionalRef(input.project_ref, "project", "source.project_ref"),
    host_ref: optionalRef(input.host_ref, "host", "source.host_ref"),
    runtime_ref: optionalRef(input.runtime_ref, "runtime", "source.runtime_ref"),
  });
}

function normalizeCorrelation(input) {
  if (input == null) input = {};
  if (!plain(input)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_CORRELATION", {});
  }
  rejectUnknownKeys(input, CORRELATION_KEYS, "correlation");
  const out = {
    mission_id: optionalString(input.mission_id, "correlation.mission_id"),
    milestone_id: optionalString(input.milestone_id, "correlation.milestone_id"),
    task_id: optionalString(input.task_id, "correlation.task_id"),
    decision_id: optionalString(input.decision_id, "correlation.decision_id"),
    waitpoint_id: optionalString(input.waitpoint_id, "correlation.waitpoint_id"),
    operation_id: optionalString(input.operation_id, "correlation.operation_id"),
    trace_id: optionalString(input.trace_id, "correlation.trace_id"),
    correlation_id: optionalString(input.correlation_id, "correlation.correlation_id"),
    run_ref: optionalRef(input.run_ref, "run", "correlation.run_ref"),
    session_ref: optionalRef(input.session_ref, "session", "correlation.session_ref"),
    workspace_ref: optionalRef(input.workspace_ref, "workspace", "correlation.workspace_ref"),
  };
  return Object.freeze(out);
}

function normalizeSequence(input) {
  if (input == null) return null;
  if (!plain(input)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_SEQUENCE", {});
  }
  rejectUnknownKeys(input, SEQUENCE_KEYS, "sequence");
  const value = input.value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CortexEventError("ERR_CORTEX_EVENT_SEQUENCE_VALUE", { value });
  }
  return Object.freeze({
    stream_id: requiredString(input.stream_id, "sequence.stream_id"),
    value,
  });
}

function normalizeCortexEvent(input) {
  if (!plain(input)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_INVALID", {});
  }
  rejectUnknownKeys(input, TOP_KEYS, "event");

  const schemaVersion = input.schema_version == null
    ? CORTEX_EVENT_SCHEMA_VERSION
    : String(input.schema_version);
  if (schemaVersion !== CORTEX_EVENT_SCHEMA_VERSION) {
    throw new CortexEventError("ERR_CORTEX_EVENT_SCHEMA_VERSION", {
      expected: CORTEX_EVENT_SCHEMA_VERSION,
      received: schemaVersion,
    });
  }

  const type = requiredString(input.type, "type");
  if (!CORTEX_EVENT_TYPE_PATTERN.test(type)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_TYPE", { type });
  }
  if (!plain(input.payload)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_PAYLOAD", {});
  }
  if (typeof input.redacted !== "boolean") {
    throw new CortexEventError("ERR_CORTEX_EVENT_REDACTION", {});
  }
  const evidence = input.evidence_refs == null ? [] : input.evidence_refs;
  if (!Array.isArray(evidence)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_EVIDENCE", {});
  }

  return Object.freeze({
    schema_version: CORTEX_EVENT_SCHEMA_VERSION,
    event_id: requiredString(input.event_id, "event_id"),
    type,
    occurred_at: timestamp(input.occurred_at),
    source: normalizeSource(input.source),
    correlation: normalizeCorrelation(input.correlation),
    sequence: normalizeSequence(input.sequence),
    causation_id: optionalString(input.causation_id, "causation_id"),
    payload: Object.freeze({ ...input.payload }),
    evidence_refs: Object.freeze(evidence.map((value, index) =>
      requiredString(value, `evidence_refs[${index}]`))),
    redacted: input.redacted,
  });
}

function canonicalEventId(sourceKind, sourceEventId) {
  const kind = requiredString(sourceKind, "sourceKind");
  if (!SOURCE_KINDS.includes(kind)) {
    throw new CortexEventError("ERR_CORTEX_EVENT_SOURCE_KIND", { kind });
  }
  return `${kind}:${requiredString(sourceEventId, "sourceEventId")}`;
}

module.exports = {
  CORTEX_EVENT_SCHEMA_VERSION,
  CORTEX_EVENT_TYPE_PATTERN,
  SOURCE_KINDS,
  CortexEventError,
  canonicalEventId,
  normalizeCortexEvent,
};
