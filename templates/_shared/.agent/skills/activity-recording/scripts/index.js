#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const agentRoot = path.join(root, ".agent");
const activityRoot = path.join(agentRoot, "activities");
const eventRoot = path.join(activityRoot, "events");
const receiptRoot = path.join(activityRoot, "receipts");
const indexFile = path.join(activityRoot, "index.json");
const lockDirectory = path.join(activityRoot, ".write.lock");
const args = process.argv.slice(2);

const ACTIVITY_KINDS = new Set(["intent", "execution", "change", "validation", "decision", "coordination", "runtime", "knowledge", "external"]);
const CAPTURE_MODES = new Set(["automatic", "workflow_required", "imported", "reconciled", "manual"]);
const AVAILABILITY = new Set(["available", "unavailable", "failed", "stale"]);
const RECEIPT_KINDS = new Set(["capture", "import", "reconciliation", "delivery", "commit_intent", "commit_result"]);
const EVENT_KEYS = new Set(["schema_version", "activity_id", "activity_kind", "capture_mode", "project_id", "task_id", "mission_id", "run_id", "session_id", "operation_id", "workspace_id", "source", "source_revision", "observed_at", "occurred_at", "actor", "summary", "changed_path_refs", "evidence_refs", "log_cursor_refs", "completeness", "confidence", "availability", "dedupe_key", "parent_activity_id", "receipt_ref"]);
const RECEIPT_KEYS = new Set(["schema_version", "receipt_id", "receipt_kind", "source", "source_revision", "capture_mode", "observed_at", "activity_refs", "gaps", "evidence_refs", "availability", "redaction", "dedupe_key", "commit_identity", "intent_receipt_ref"]);
const SENSITIVE_PATTERN = /(password|secret|token|api[_-]?key|credential|authorization)\s*[:=]\s*\S+|bearer\s+[A-Za-z0-9._-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|full prompt|complete user instructions|clipboard contents?|session cookie|browser session|raw terminal|stdout payload/i;

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function fail(code, message, details = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message, details } }, null, 2)}\n`);
  process.exitCode = 1;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function exclusiveWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.linkSync(temporary, file);
  } finally {
    fs.unlinkSync(temporary);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLock(callback) {
  fs.mkdirSync(activityRoot, { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.mkdirSync(lockDirectory);
      try {
        return callback();
      } finally {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      sleep(10);
    }
  }
  throw new Error("activity writer lock timeout");
}

function rejectUnknownKeys(value, allowed, field, errors) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) errors.push(`${field}.${key} is not allowed`);
  }
}

function rejectSensitive(value, field, errors) {
  if (typeof value === "string" && SENSITIVE_PATTERN.test(value)) errors.push(`${field} contains sensitive or unredacted content`);
}

function requireString(value, field, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${field} must be a non-empty string`);
}

function requireArray(value, field, errors) {
  if (!Array.isArray(value)) errors.push(`${field} must be an array`);
}

function requireStringArray(value, field, errors, pattern = null) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  const seen = new Set();
  value.forEach((entry, index) => {
    if (typeof entry !== "string") errors.push(`${field}[${index}] must be a string`);
    if (typeof entry === "string" && pattern && !pattern.test(entry)) errors.push(`${field}[${index}] has an invalid format`);
    if (seen.has(entry)) errors.push(`${field} must contain unique items`);
    seen.add(entry);
  });
}

function requireNullableString(value, field, errors, pattern = null) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string or null`);
    return;
  }
  if (pattern && !pattern.test(value)) errors.push(`${field} has an invalid format`);
}

function requireDate(value, field, errors, nullable = false) {
  if (nullable && value === null) return;
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  if (!match || Number.isNaN(Date.parse(value))) {
    errors.push(`${field} must be an RFC 3339 date-time`);
    return;
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    errors.push(`${field} must contain a valid calendar date-time`);
  }
}

function rejectSensitivePayload(value, field, errors) {
  if (typeof value === "string") {
    rejectSensitive(value, field, errors);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitivePayload(entry, `${field}[${index}]`, errors));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) rejectSensitivePayload(entry, `${field}.${key}`, errors);
  }
}

function requireFields(value, fields, errors) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value || {}, field)) errors.push(`${field} is required`);
  }
}

function validateEvent(value) {
  const errors = [];
  requireFields(value, ["schema_version", "activity_id", "activity_kind", "capture_mode", "project_id", "source", "source_revision", "observed_at", "occurred_at", "actor", "summary", "evidence_refs", "log_cursor_refs", "completeness", "confidence", "availability", "dedupe_key"], errors);
  rejectUnknownKeys(value, EVENT_KEYS, "event", errors);
  if (value?.schema_version !== 1) errors.push("schema_version must be 1");
  if (!/^ACT-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value?.activity_id || "")) errors.push("activity_id is invalid");
  if (!ACTIVITY_KINDS.has(value?.activity_kind)) errors.push("activity_kind is invalid");
  if (!CAPTURE_MODES.has(value?.capture_mode)) errors.push("capture_mode is invalid");
  requireString(value?.project_id, "project_id", errors);
  requireString(value?.source, "source", errors);
  requireString(value?.source_revision, "source_revision", errors);
  requireDate(value?.observed_at, "observed_at", errors);
  requireDate(value?.occurred_at, "occurred_at", errors, true);
  if (!value?.actor || !["user", "agent", "workflow", "system", "external"].includes(value.actor.type)) errors.push("actor.type is invalid");
  rejectUnknownKeys(value?.actor, new Set(["type", "id"]), "actor", errors);
  requireString(value?.actor?.id, "actor.id", errors);
  requireString(value?.summary, "summary", errors);
  if (typeof value?.summary === "string" && value.summary.length > 1000) errors.push("summary must be at most 1000 characters");
  requireStringArray(value?.changed_path_refs || [], "changed_path_refs", errors);
  requireStringArray(value?.evidence_refs, "evidence_refs", errors);
  requireStringArray(value?.log_cursor_refs, "log_cursor_refs", errors);
  for (const field of ["task_id", "mission_id", "run_id", "session_id", "operation_id", "workspace_id", "receipt_ref"]) requireNullableString(value?.[field], field, errors);
  requireNullableString(value?.parent_activity_id, "parent_activity_id", errors, /^ACT-/);
  if (!["complete", "partial", "unknown"].includes(value?.completeness)) errors.push("completeness is invalid");
  if (!["observed", "reported", "inferred"].includes(value?.confidence)) errors.push("confidence is invalid");
  if (!AVAILABILITY.has(value?.availability)) errors.push("availability is invalid");
  requireString(value?.dedupe_key, "dedupe_key", errors);
  rejectSensitivePayload(value, "event", errors);
  return errors;
}

function validateReceipt(value) {
  const errors = [];
  requireFields(value, ["schema_version", "receipt_id", "receipt_kind", "source", "source_revision", "capture_mode", "observed_at", "activity_refs", "gaps", "evidence_refs", "availability", "redaction", "dedupe_key"], errors);
  rejectUnknownKeys(value, RECEIPT_KEYS, "receipt", errors);
  if (value?.schema_version !== 1) errors.push("schema_version must be 1");
  if (!/^AR-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value?.receipt_id || "")) errors.push("receipt_id is invalid");
  if (!RECEIPT_KINDS.has(value?.receipt_kind)) errors.push("receipt_kind is invalid");
  requireString(value?.source, "source", errors);
  requireString(value?.source_revision, "source_revision", errors);
  if (!CAPTURE_MODES.has(value?.capture_mode)) errors.push("capture_mode is invalid");
  requireDate(value?.observed_at, "observed_at", errors);
  requireStringArray(value?.activity_refs, "activity_refs", errors, /^ACT-/);
  requireStringArray(value?.gaps, "gaps", errors);
  requireStringArray(value?.evidence_refs, "evidence_refs", errors);
  if (!AVAILABILITY.has(value?.availability)) errors.push("availability is invalid");
  requireString(value?.dedupe_key, "dedupe_key", errors);
  if (!["passed", "failed", "not_applicable"].includes(value?.redaction?.status)) errors.push("redaction.status is invalid");
  if (value?.redaction?.status === "failed") errors.push("redaction.status failed cannot be persisted");
  rejectUnknownKeys(value?.redaction, new Set(["status", "ruleset"]), "redaction", errors);
  requireNullableString(value?.redaction?.ruleset, "redaction.ruleset", errors);
  requireNullableString(value?.commit_identity, "commit_identity", errors);
  requireNullableString(value?.intent_receipt_ref, "intent_receipt_ref", errors, /^AR-/);
  if (value?.receipt_kind === "commit_result" && value?.availability === "available") {
    requireString(value?.commit_identity, "commit_identity", errors);
    requireString(value?.intent_receipt_ref, "intent_receipt_ref", errors);
  }
  rejectSensitivePayload(value, "receipt", errors);
  return errors;
}

function listRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ file: path.join(directory, name), value: readJson(path.join(directory, name)) }));
}

function buildIndex() {
  const events = listRecords(eventRoot).map(({ file, value }) => ({
    activity_id: value.activity_id,
    path: path.relative(root, file),
    activity_kind: value.activity_kind,
    capture_mode: value.capture_mode,
    source: value.source,
    source_revision: value.source_revision,
    observed_at: value.observed_at,
    availability: value.availability,
    dedupe_key: value.dedupe_key
  }));
  const receipts = listRecords(receiptRoot).map(({ file, value }) => ({
    receipt_id: value.receipt_id,
    path: path.relative(root, file),
    receipt_kind: value.receipt_kind,
    source: value.source,
    source_revision: value.source_revision,
    observed_at: value.observed_at,
    availability: value.availability,
    dedupe_key: value.dedupe_key
  }));
  return { schema_version: 1, events, receipts, updated_at: new Date().toISOString() };
}

function rebuildIndexUnlocked() {
  if (process.env.CORTEX_ACTIVITY_FAIL_INDEX === "1") throw new Error("simulated index failure");
  const index = buildIndex();
  atomicWrite(indexFile, index);
  return index;
}

function rebuildIndex() {
  return withLock(rebuildIndexUnlocked);
}

function ensureUniqueDedupe(kind, value) {
  const directory = kind === "event" ? eventRoot : receiptRoot;
  const idField = kind === "event" ? "activity_id" : "receipt_id";
  const conflict = listRecords(directory).find(({ value: existing }) => existing.dedupe_key === value.dedupe_key && existing[idField] !== value[idField]);
  if (conflict) throw new Error(`dedupe_key already belongs to ${conflict.value[idField]}`);
}

function append(kind, value) {
  const errors = kind === "event" ? validateEvent(value) : validateReceipt(value);
  if (errors.length) throw new Error(errors.join("; "));
  return withLock(() => {
    ensureUniqueDedupe(kind, value);
    const id = kind === "event" ? value.activity_id : value.receipt_id;
    const directory = kind === "event" ? eventRoot : receiptRoot;
    const file = path.join(directory, `${id}.json`);
    if (fs.existsSync(file)) {
      const existing = readJson(file);
      if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`${id} is immutable and already exists with different content`);
      return { file, idempotent: true, index: rebuildIndexUnlocked() };
    }
    exclusiveWrite(file, value);
    return { file, idempotent: false, index: rebuildIndexUnlocked() };
  });
}

function parsePayload() {
  const raw = option("--payload-json");
  if (!raw) throw new Error("--payload-json is required");
  return JSON.parse(raw);
}

function validateAll() {
  const issues = [];
  for (const { file, value } of listRecords(eventRoot)) {
    for (const error of validateEvent(value)) issues.push({ path: path.relative(root, file), error });
  }
  for (const { file, value } of listRecords(receiptRoot)) {
    for (const error of validateReceipt(value)) issues.push({ path: path.relative(root, file), error });
  }
  return issues;
}

function main() {
  try {
    const [resource, action] = args;
    if (resource === "init") {
      fs.mkdirSync(eventRoot, { recursive: true });
      fs.mkdirSync(receiptRoot, { recursive: true });
      output({ ok: true, action: "init", index: rebuildIndex() });
      return;
    }
    if (resource === "event" && action === "append") {
      const result = append("event", parsePayload());
      output({ ok: true, action: "event append", path: path.relative(root, result.file), idempotent: result.idempotent });
      return;
    }
    if (resource === "receipt" && action === "append") {
      const result = append("receipt", parsePayload());
      output({ ok: true, action: "receipt append", path: path.relative(root, result.file), idempotent: result.idempotent });
      return;
    }
    if (resource === "rebuild-index") {
      output({ ok: true, action: "rebuild-index", index: rebuildIndex() });
      return;
    }
    if (resource === "validate") {
      const issues = validateAll();
      output({ ok: issues.length === 0, action: "validate", issues });
      if (issues.length) process.exitCode = 1;
      return;
    }
    fail("unsupported_command", "Use init, event append, receipt append, rebuild-index, or validate");
  } catch (error) {
    fail("activity_recording_failed", error.message);
  }
}

main();
