"use strict";

const { normalizeCortexEvent, CortexEventError } = require("./events");

const TIMELINE_CURSOR_SCHEMA_VERSION = "1";
const CURSOR_KEYS = new Set(["schema_version", "stream_id", "position", "event_id"]);

function normalizeTimelineCursor(input) {
  if (input == null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CortexEventError("ERR_TIMELINE_CURSOR_INVALID", {});
  }
  for (const key of Object.keys(input)) {
    if (!CURSOR_KEYS.has(key)) {
      throw new CortexEventError("ERR_TIMELINE_CURSOR_FIELD_UNKNOWN", { key });
    }
  }
  const schemaVersion = input.schema_version == null
    ? TIMELINE_CURSOR_SCHEMA_VERSION
    : String(input.schema_version);
  if (schemaVersion !== TIMELINE_CURSOR_SCHEMA_VERSION) {
    throw new CortexEventError("ERR_TIMELINE_CURSOR_SCHEMA_VERSION", {
      received: schemaVersion,
    });
  }
  if (typeof input.stream_id !== "string" || !input.stream_id.trim()) {
    throw new CortexEventError("ERR_TIMELINE_CURSOR_STREAM", {});
  }
  if (typeof input.position !== "string" || !input.position.trim()) {
    throw new CortexEventError("ERR_TIMELINE_CURSOR_POSITION", {});
  }
  if (input.event_id != null && (typeof input.event_id !== "string" || !input.event_id.trim())) {
    throw new CortexEventError("ERR_TIMELINE_CURSOR_EVENT", {});
  }
  return Object.freeze({
    schema_version: TIMELINE_CURSOR_SCHEMA_VERSION,
    stream_id: input.stream_id.trim(),
    position: input.position.trim(),
    event_id: input.event_id == null ? null : input.event_id.trim(),
  });
}

function analyzeCortexTimeline(eventInputs, options = {}) {
  if (!Array.isArray(eventInputs)) {
    throw new CortexEventError("ERR_TIMELINE_EVENTS_INVALID", {});
  }
  const events = [];
  const duplicates = [];
  const seen = new Set();
  const lastByStream = new Map(Object.entries(options.initial_sequences || {}));
  const gaps = [];

  for (const raw of eventInputs) {
    const event = normalizeCortexEvent(raw);
    if (seen.has(event.event_id)) {
      duplicates.push(event.event_id);
      continue;
    }
    seen.add(event.event_id);
    events.push(event);

    if (!event.sequence) continue;
    const stream = event.sequence.stream_id;
    const current = event.sequence.value;
    if (lastByStream.has(stream)) {
      const previous = Number(lastByStream.get(stream));
      if (current !== previous + 1) {
        gaps.push(Object.freeze({
          stream_id: stream,
          previous,
          expected: previous + 1,
          actual: current,
          kind: current <= previous ? "regression" : "gap",
          event_id: event.event_id,
        }));
      }
    }
    lastByStream.set(stream, current);
  }

  return Object.freeze({
    events: Object.freeze(events),
    duplicate_event_ids: Object.freeze(duplicates),
    gaps: Object.freeze(gaps),
    reconciliation_required: gaps.length > 0,
    stream_positions: Object.freeze(
      Object.fromEntries([...lastByStream.entries()].map(([key, value]) => [key, Number(value)])),
    ),
  });
}

function createTimelinePage(input = {}) {
  const analysis = analyzeCortexTimeline(input.events || [], {
    initial_sequences: input.initial_sequences || {},
  });
  return Object.freeze({
    events: analysis.events,
    cursor: normalizeTimelineCursor(input.cursor),
    next_cursor: normalizeTimelineCursor(input.next_cursor),
    duplicate_event_ids: analysis.duplicate_event_ids,
    gaps: analysis.gaps,
    reconciliation: Object.freeze({
      required: analysis.reconciliation_required,
      reason: analysis.reconciliation_required ? "sequence_gap_or_regression" : null,
    }),
    stream_positions: analysis.stream_positions,
  });
}

module.exports = {
  TIMELINE_CURSOR_SCHEMA_VERSION,
  normalizeTimelineCursor,
  analyzeCortexTimeline,
  createTimelinePage,
};
