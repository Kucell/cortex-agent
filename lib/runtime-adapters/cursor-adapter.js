"use strict";

// ─── Cursor Read-only Boundary Adapter (MS-011 / P-003 Phase 1-2) ───────────
//
// Optional adapter that maps Cursor-shaped session/turn/tool events to the
// frozen RBE envelope. Mirrors the Pi adapter contract (MS-004): absent-safe,
// never owning authorization, deterministic, frozen outputs.
//
// Absent-safe contract:
//   1. Importing this module never throws.
//   2. No external `require` to Cursor internals.
//   3. `detectCursor()` probes `cursor` binary or `CURSOR_BINARY`; missing
//      Cursor returns an `unsupported` capability descriptor, never throws.
//   4. `mapCursorEventToBoundaryEvent()` validates inputs and forwards them
//      through the frozen envelope validator; bad input throws a typed error.
//
// Cursor ships its events through a JSONL transcript file (`transcript.jsonl`)
// produced by the agent runner. We accept a single already-extracted event
// record; the integration layer is responsible for streaming.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const boundaryEvent = require("./boundary-event");
const capabilityContract = require("./capability-contract");

const CURSOR_ADAPTER_ID = "cursor";
const CURSOR_VENDOR = "cursor-sh";
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

class CursorAdapterError extends Error {
  constructor(code, details) {
    super(`[cursor-adapter:${code}] ${JSON.stringify(details || {})}`);
    this.name = "CursorAdapterError";
    this.code = code;
    this.details = details || {};
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function safeIdentifier(value, max = 128) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  if (!/^[A-Za-z0-9._:@-]+$/.test(value)) return null;
  return value;
}

function deriveEventId(parts) {
  const safe = parts.map((p) => String(p == null ? "anon" : p).replace(/[^A-Za-z0-9._-]/g, "_")).join("-");
  return `${boundaryEvent.RUNTIME_BOUNDARY_EVENT_ID_PREFIX}${safe}`;
}

function mapCursorEventToBoundaryEvent(input, options) {
  if (!plain(input)) throw new CursorAdapterError("ERR_INPUT_INVALID", {});
  if (!nonEmptyString(input.kind)) throw new CursorAdapterError("ERR_KIND_REQUIRED", {});
  if (!nonEmptyString(input.event)) throw new CursorAdapterError("ERR_EVENT_REQUIRED", {});
  if (!nonEmptyString(input.ts)) throw new CursorAdapterError("ERR_TS_REQUIRED", {});

  const correlation = plain(input.correlation) ? input.correlation : {};
  const decision = plain(input.decision) ? input.decision : null;
  const capability = nonEmptyString(input.capability);
  const sessionRef = safeIdentifier(input.sessionId, boundaryEvent.MAX_HOST_SESSION_REF_LENGTH);

  const type = resolveEventType(input.kind, input.event);
  if (!type) throw new CursorAdapterError("ERR_EVENT_TYPE_MAPPING", { kind: input.kind, event: input.event });

  const eventId = deriveEventId([sessionRef || "session", input.kind, input.event, input.seq == null ? "0" : input.seq]);
  if (eventId.length > boundaryEvent.MAX_EVENT_ID_LENGTH) {
    throw new CursorAdapterError("ERR_EVENT_ID_TOO_LONG", { length: eventId.length });
  }

  const candidate = {
    schema_version: boundaryEvent.RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
    event_id: eventId,
    type,
    at: input.ts,
    host: {
      adapter_id: CURSOR_ADAPTER_ID,
      ...(sessionRef ? { session_ref: sessionRef } : {}),
    },
    correlation: pickCorrelation(correlation),
    ...(input.kind === "tool" ? {
      resource: {
        kind: "tool",
        name: nonEmptyString(input.toolName) || "unknown",
        ...(nonEmptyString(input.resourceDigest) ? { target_digest: input.resourceDigest } : {}),
      },
      capability: capability || "tool.before.observe",
      decision: {
        result: decision && nonEmptyString(decision.result) ? decision.result : "unavailable",
        ...(decision && nonEmptyString(decision.authorization_ref) ? { authorization_ref: decision.authorization_ref } : {}),
        ...(decision && nonEmptyString(decision.reason) ? { reason: decision.reason } : {}),
      },
    } : {}),
    ...(Array.isArray(input.evidenceRefs) ? {
      evidence_refs: input.evidenceRefs
        .filter((ref) => nonEmptyString(ref))
        .slice(0, boundaryEvent.MAX_EVIDENCE_REFS),
    } : { evidence_refs: [] }),
  };

  return boundaryEvent.validateBoundaryEvent(candidate);
}

function resolveEventType(kind, event) {
  if (kind === "session" && (event === "start" || event === "end")) return `session.${event}`;
  if (kind === "turn" && (event === "start" || event === "end")) return `turn.${event}`;
  if (kind === "message" && (event === "start" || event === "update" || event === "end")) return `message.${event}`;
  if (kind === "tool" && (event === "before" || event === "after" || event === "update")) return `tool.${event}`;
  if (kind === "context" && (event === "discovered" || event === "selected" || event === "rendered" || event === "measured")) {
    return `context.${event}`;
  }
  return null;
}

function pickCorrelation(correlation) {
  const out = {};
  for (const key of ["task_id", "run_id", "session_id", "operation_id", "trace_id"]) {
    const value = safeIdentifier(correlation[key], boundaryEvent.MAX_CORRELATION_ID_LENGTH);
    if (value) out[key] = value;
  }
  return out;
}

function detectCursor(options) {
  const opts = options || {};
  const binary = opts.binary || process.env.CURSOR_BINARY || "cursor";
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;

  const descriptor = capabilityContract.validateCapabilityDescriptor(buildAbsentDescriptor());

  if (!binary || typeof binary !== "string") {
    return Object.freeze({ available: false, descriptor, reason: "no_binary" });
  }

  let resolved;
  try {
    resolved = safeWhich(binary);
  } catch (_) {
    resolved = null;
  }
  if (!resolved) {
    return Object.freeze({ available: false, descriptor, reason: "not_on_path" });
  }

  const probe = spawnSync(resolved, ["--version"], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) {
    return Object.freeze({ available: false, descriptor, reason: probe.error ? "spawn_failed" : "probe_failed" });
  }
  const version = parseVersion((probe.stdout || "").trim());
  if (!version) {
    return Object.freeze({ available: false, descriptor, reason: "unparseable_version" });
  }

  const detected = capabilityContract.validateCapabilityDescriptor({
    schema_version: capabilityContract.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: CURSOR_ADAPTER_ID, vendor: CURSOR_VENDOR, version },
    detected_at: new Date().toISOString(),
    capabilities: {
      "session.boundary": { level: "native", source: "extension-api" },
      "turn.boundary": { level: "native", source: "extension-api" },
      "message.boundary": { level: "adapter", source: "runtime-trace" },
      "tool.before.observe": { level: "native", source: "extension-api" },
      "tool.before.block": { level: "adapter", source: "runtime-trace" },
      "tool.update": { level: "native", source: "extension-api" },
      "context.render.observe": { level: "explicit", source: "manifest-claim" },
    },
  });
  return Object.freeze({ available: true, descriptor: detected, binary: resolved, version });
}

function buildAbsentDescriptor() {
  return {
    schema_version: capabilityContract.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: CURSOR_ADAPTER_ID, vendor: CURSOR_VENDOR, version: "absent" },
    detected_at: new Date().toISOString(),
    capabilities: {
      "session.boundary": { level: "unsupported", source: "not-exposed" },
      "turn.boundary": { level: "unsupported", source: "not-exposed" },
      "message.boundary": { level: "unsupported", source: "not-exposed" },
      "tool.before.observe": { level: "unsupported", source: "not-exposed" },
      "tool.before.block": { level: "unsupported", source: "not-exposed" },
      "tool.update": { level: "unsupported", source: "not-exposed" },
      "context.render.observe": { level: "unsupported", source: "not-exposed" },
    },
  };
}

function safeWhich(binary) {
  if (binary.indexOf(path.sep) !== -1) {
    return fs.existsSync(binary) ? binary : null;
  }
  const pathEnv = process.env.PATH || "";
  const parts = pathEnv.split(path.delimiter);
  for (const dir of parts) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseVersion(raw) {
  const match = raw.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.\-]+)?)/);
  return match ? match[1] : null;
}

function mapMany(events, options) {
  if (!Array.isArray(events)) throw new CursorAdapterError("ERR_INPUT_NOT_ARRAY", {});
  return events.map((event) => mapCursorEventToBoundaryEvent(event, options));
}

module.exports = {
  CURSOR_ADAPTER_ID,
  CURSOR_VENDOR,
  CursorAdapterError,
  detectCursor,
  mapCursorEventToBoundaryEvent,
  mapMany,
};