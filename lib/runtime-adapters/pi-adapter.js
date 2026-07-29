"use strict";

// ─── Pi Read-only Boundary Adapter (MS-004 / P-003) ────────────────────────
//
// Optional adapter that maps Pi-shaped session/turn/tool events to the
// frozen RBE (Runtime Boundary Event) envelope. Cortex does NOT depend on
// Pi being installed — this module is a pure contract mapper that is loaded
// unconditionally. The actual integration lives in integrations/pi (kept
// outside the core) and is not part of MS-004.
//
// Absent-safe contract:
//   1. Importing this module never throws.
//   2. No external `require` to Pi internals — the module depends only on
//      Node.js built-ins and the existing boundary-event + capability-
//      contract modules.
//   3. `detectPi()` probes a configurable binary path (default `pi` on PATH
//      or `PI_BINARY`) and returns a capability descriptor; missing Pi
//      returns an `unsupported` descriptor, never throws.
//   4. `mapPiEventToBoundaryEvent()` accepts an already-validated Pi-shaped
//      input and produces a frozen RBE; bad input throws a typed error.
//
// The adapter never holds Pi state, never writes files, and never makes
// network calls. It is a deterministic mapper for evidence purposes only.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const boundaryEvent = require("./boundary-event");
const capabilityContract = require("./capability-contract");

const PI_ADAPTER_ID = "pi";
const PI_VENDOR = "earendil-works";
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

class PiAdapterError extends Error {
  constructor(code, details) {
    super(`[pi-adapter:${code}] ${JSON.stringify(details || {})}`);
    this.name = "PiAdapterError";
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

// Deterministic event_id derived from session_ref + kind + counter.
// Kept inside the RBE prefix and the bounded identifier alphabet.
function deriveEventId(parts) {
  const safe = parts.map((p) => String(p == null ? "anon" : p).replace(/[^A-Za-z0-9._-]/g, "_")).join("-");
  return `${boundaryEvent.RUNTIME_BOUNDARY_EVENT_ID_PREFIX}${safe}`;
}

function mapPiEventToBoundaryEvent(input, options) {
  if (!plain(input)) throw new PiAdapterError("ERR_INPUT_INVALID", {});
  if (!nonEmptyString(input.kind)) throw new PiAdapterError("ERR_KIND_REQUIRED", {});
  if (!nonEmptyString(input.event)) throw new PiAdapterError("ERR_EVENT_REQUIRED", {});
  if (!nonEmptyString(input.ts)) throw new PiAdapterError("ERR_TS_REQUIRED", {});

  const correlation = plain(input.correlation) ? input.correlation : {};
  const decision = plain(input.decision) ? input.decision : null;
  const capability = nonEmptyString(input.capability);
  const sessionRef = safeIdentifier(input.sessionId, boundaryEvent.MAX_HOST_SESSION_REF_LENGTH);

  const type = resolveEventType(input.kind, input.event);
  if (!type) throw new PiAdapterError("ERR_EVENT_TYPE_MAPPING", { kind: input.kind, event: input.event });

  const eventId = deriveEventId([sessionRef || "session", input.kind, input.event, input.seq == null ? "0" : input.seq]);
  if (eventId.length > boundaryEvent.MAX_EVENT_ID_LENGTH) {
    throw new PiAdapterError("ERR_EVENT_ID_TOO_LONG", { length: eventId.length });
  }

  const candidate = {
    schema_version: boundaryEvent.RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
    event_id: eventId,
    type,
    at: input.ts,
    host: {
      adapter_id: PI_ADAPTER_ID,
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

// Capability detection is intentionally best-effort: Pi missing ⇒ unsupported.
function detectPi(options) {
  const opts = options || {};
  const binary = opts.binary || process.env.PI_BINARY || "pi";
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
    host: { adapter_id: PI_ADAPTER_ID, vendor: PI_VENDOR, version },
    detected_at: new Date().toISOString(),
    capabilities: {
      "session.boundary": { level: "native", source: "extension-api" },
      "turn.boundary": { level: "native", source: "extension-api" },
      "message.boundary": { level: "adapter", source: "runtime-trace" },
      "tool.before.observe": { level: "native", source: "extension-api" },
      "tool.before.block": { level: "native", source: "extension-api" },
      "tool.update": { level: "native", source: "extension-api" },
      "context.render.observe": { level: "explicit", source: "manifest-claim" },
    },
  });
  return Object.freeze({ available: true, descriptor: detected, binary: resolved, version });
}

function buildAbsentDescriptor() {
  return {
    schema_version: capabilityContract.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    host: { adapter_id: PI_ADAPTER_ID, vendor: PI_VENDOR, version: "absent" },
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

// mapMany stays pure and deterministic: callers pass a stable event order.
function mapMany(events, options) {
  if (!Array.isArray(events)) throw new PiAdapterError("ERR_INPUT_NOT_ARRAY", {});
  return events.map((event) => mapPiEventToBoundaryEvent(event, options));
}

module.exports = {
  PI_ADAPTER_ID,
  PI_VENDOR,
  PiAdapterError,
  detectPi,
  mapPiEventToBoundaryEvent,
  mapMany,
};