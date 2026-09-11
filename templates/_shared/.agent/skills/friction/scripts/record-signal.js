"use strict";

// record-signal.js — friction signal contract CLI (P-003 / M-003A).
// Zero external dependencies; self-contained so the skill ships to user projects.
// Node >=14. Usage:
//   node record-signal.js --project <root> --session <S-id> --host <host>
//        --type <signal> --observability <level>
//        [--count N] [--evidence-ref ref] [--redaction aggregate_only|full]
//   node record-signal.js --read --project <root>

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Closed vocabulary (must mirror lib/runtime-adapters/capability-contract.js).
const SIGNAL_TYPES = Object.freeze(["tool_denied", "tool_failed", "tool_retried", "user_interrupted", "user_correction", "lifecycle_stop"]);
const OBSERVABILITY = Object.freeze(["observed", "derived", "not_observed", "not_supported"]);
const REDACTION = Object.freeze(["aggregate_only", "full"]);
const EVENT_DIR = ".agent/runtime-evidence/friction";
const EVENT_FILE = "signals.jsonl";
const TYPE_SET = new Set(SIGNAL_TYPES);
const OBS_SET = new Set(OBSERVABILITY);
const RED_SET = new Set(REDACTION);

// REDACTION GUARD: no prompt, user message, command/tool argument, tool output,
// credential, file content, or free-form correction text may ever enter an event.
const KNOWN_KEYS = new Set(["schema_version", "signal_id", "session_id", "host", "type", "observability", "count", "occurred_at", "evidence_ref", "redaction"]);
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name) {
  return process.argv.indexOf(name) >= 0;
}

function asStr(v, where, max) {
  if (typeof v !== "string" || v.length === 0) throw new Error("ERR_FIELD_INVALID: " + where);
  if (v.length > max) throw new Error("ERR_FIELD_TOO_LONG: " + where);
  return v;
}

function generateId() {
  const rnd = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return "FS-" + rnd;
}

function validateEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ERR_EVENT_NOT_OBJECT");
  for (const k of Object.keys(input)) {
    if (!KNOWN_KEYS.has(k)) throw new Error("ERR_UNKNOWN_FIELD: " + k);
  }
  if (input.schema_version !== "1") throw new Error("ERR_SCHEMA_VERSION_UNKNOWN");
  const signalId = input.signal_id === undefined ? generateId() : asStr(input.signal_id, "signal_id", 128);
  if (!signalId.startsWith("FS-")) throw new Error("ERR_SIGNAL_ID_PREFIX_MISSING");
  const sessionId = asStr(input.session_id, "session_id", 128);
  const host = asStr(input.host, "host", 64);
  const type = asStr(input.type, "type", 32);
  if (!TYPE_SET.has(type)) throw new Error("ERR_SIGNAL_TYPE_UNKNOWN: " + type);
  const observability = asStr(input.observability, "observability", 32);
  if (!OBS_SET.has(observability)) throw new Error("ERR_OBSERVABILITY_UNKNOWN: " + observability);
  if (typeof input.count !== "number" || !Number.isFinite(input.count) || !Number.isInteger(input.count) || input.count <= 0) {
    throw new Error("ERR_COUNT_INVALID");
  }
  const occurredAt = asStr(input.occurred_at, "occurred_at", 64);
  if (!ISO_REGEX.test(occurredAt)) throw new Error("ERR_TIMESTAMP_INVALID");
  const evidenceRef = input.evidence_ref === undefined ? "" : asStr(input.evidence_ref, "evidence_ref", 256);
  const redaction = asStr(input.redaction, "redaction", 32);
  if (!RED_SET.has(redaction)) throw new Error("ERR_REDACTION_UNKNOWN: " + redaction);
  return { schema_version: "1", signal_id: signalId, session_id: sessionId, host, type, observability, count: input.count, occurred_at: occurredAt, evidence_ref: evidenceRef, redaction };
}

function signalFile(root) {
  return path.join(root, EVENT_DIR, EVENT_FILE);
}

function main() {
  const root = arg("--project");
  if (!root) {
    console.error("usage: record-signal.js --project <root> --session <S-id> --host <host> --type <signal> --observability <level> [--count N] [--evidence-ref ref] [--redaction aggregate_only|full]");
    console.error("       record-signal.js --read --project <root>");
    process.exit(2);
  }
  const file = signalFile(root);
  if (has("--read")) {
    let skipped = 0;
    const events = [];
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch (_) { skipped += 1; }
      }
    }
    process.stdout.write(JSON.stringify({ path: file, skipped, count: events.length, events }, null, 2) + "\n");
    return;
  }
  const session = arg("--session");
  const host = arg("--host");
  const type = arg("--type");
  const observability = arg("--observability");
  const countArg = arg("--count");
  const evidenceRef = arg("--evidence-ref");
  const redaction = arg("--redaction") || "aggregate_only";
  if (!session || !host || !type || !observability) {
    console.error("missing required args");
    process.exit(2);
  }
  const event = validateEvent({
    schema_version: "1",
    session_id: session,
    host,
    type,
    observability,
    count: countArg === undefined ? 1 : Number(countArg),
    occurred_at: new Date().toISOString(),
    evidence_ref: evidenceRef,
    redaction,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ ok: true, signal_id: event.signal_id, path: file }, null, 2) + "\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + "\n");
  process.exit(1);
}
