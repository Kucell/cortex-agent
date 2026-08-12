"use strict";

// ─── Cross-Project Event Bridge — Producer Side (P-006 Capability A) ─────────
//
// P-003 Phase 1 (66ff922) shipped the **consumer** side: validate + sync + inbox.
// P-006 Capability A adds the **producer** side: a safe API and CLI to write
// outbox events with schema validation, atomic file writes, and rate limiting.
//
// File layout (mirrors inbox-store):
//   <root>/.agent-runtime/cross-project/outbox/<source_project_id>/<event-id>.json
//
// Public API:
//   • outboxPath(root, sourceProjectId)              → absolute path
//   • ensureOutboxDir(root, sourceProjectId)         → mkdirp, idempotent
//   • writeEvent(root, opts)                         → { ok, file, event_id }
//                                                       or { ok: false, errors[] }
//   • readEvents(root, { source_project_id, since? })→ [{ event_id, ... }]
//   • deleteEvent(root, sourceProjectId, eventId)    → { ok }
//   • generateEventId(scope, sequence?)              → "BR-EVT-<scope>-<seq>"
//
// Schema validation: reuses validateBridgeEvent from bridge-event-schema.js.
// Rate limit: defaults to 1000 events / mission / day (configurable via opts).
//
// Source: P-006 §3.1 Capability A + §5 Module API.

const fs = require("node:fs");
const path = require("node:path");

const { validateBridgeEvent } = require("./bridge-event-schema");

const DEFAULT_RATE_LIMIT_PER_DAY = 1000;

function outboxDirFor(root) {
  return path.join(path.resolve(root), ".agent-runtime", "cross-project", "outbox");
}

function outboxPath(root, sourceProjectId) {
  return path.join(outboxDirFor(root), sourceProjectId);
}

function outboxFile(root, sourceProjectId, eventId) {
  return path.join(outboxPath(root, sourceProjectId), `${eventId}.json`);
}

function ensureOutboxDir(root, sourceProjectId) {
  const dir = outboxPath(root, sourceProjectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateEventId(scope, sequence) {
  const safeScope = String(scope || "anon").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  if (typeof sequence === "number") {
    return `BR-EVT-${safeScope}-${String(sequence).padStart(3, "0")}`;
  }
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `BR-EVT-${safeScope}-${ts}-${rnd}`;
}

function nowRfc3339() {
  return new Date().toISOString();
}

function checkRateLimit(root, sourceProjectId, opts) {
  const limit = (opts && opts.rate_limit_per_day) || DEFAULT_RATE_LIMIT_PER_DAY;
  const dir = outboxPath(root, sourceProjectId);
  if (!fs.existsSync(dir)) return { ok: true, count: 0 };
  const since = Date.now() - 24 * 60 * 60 * 1000;
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs >= since) count += 1;
    } catch { /* ignore */ }
  }
  if (count >= limit) {
    return { ok: false, errors: [`rate limit exceeded: ${count}/${limit} events in last 24h`] };
  }
  return { ok: true, count };
}

function writeEvent(root, options) {
  const opts = options || {};
  if (!opts.event_type) return { ok: false, errors: ["event_type is required"] };
  if (!opts.summary || typeof opts.summary !== "object" || Array.isArray(opts.summary)) {
    return { ok: false, errors: ["summary must be an object"] };
  }
  if (!opts.source_project_id) return { ok: false, errors: ["source_project_id is required"] };

  const event_id = opts.bridge_event_id || generateEventId(opts.event_id_scope || opts.event_type);
  const event = {
    bridge_event_id: event_id,
    source_project_id: opts.source_project_id,
    event_type: opts.event_type,
    summary: opts.summary,
    correlation_group: opts.correlation_group || undefined,
    propagated_at: opts.propagated_at || nowRfc3339(),
  };
  // strip undefined
  for (const k of Object.keys(event)) if (event[k] === undefined) delete event[k];

  const validation = validateBridgeEvent(event);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const rate = checkRateLimit(root, opts.source_project_id, opts);
  if (!rate.ok) return { ok: false, errors: rate.errors };

  ensureOutboxDir(root, opts.source_project_id);
  const target = outboxFile(root, opts.source_project_id, event_id);
  if (fs.existsSync(target) && !opts.overwrite) {
    return { ok: false, errors: [`event already exists: ${event_id}`] };
  }
  // atomic write: tmp + rename
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(event, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, target);
  } catch (cause) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, errors: [`write failed: ${cause.message}`] };
  }
  return { ok: true, file: target, event_id, event };
}

function readEvents(root, options) {
  const opts = options || {};
  if (!opts.source_project_id) return { ok: false, errors: ["source_project_id is required"] };
  const dir = outboxPath(root, opts.source_project_id);
  if (!fs.existsSync(dir)) return { ok: true, events: [] };
  const since = opts.since ? new Date(opts.since).getTime() : 0;
  const events = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (since && stat.mtimeMs < since) continue;
      const raw = fs.readFileSync(file, "utf8");
      const obj = JSON.parse(raw);
      events.push(obj);
    } catch { /* skip corrupt */ }
  }
  events.sort((a, b) => String(a.propagated_at).localeCompare(String(b.propagated_at)));
  return { ok: true, events };
}

function deleteEvent(root, sourceProjectId, eventId) {
  const file = outboxFile(root, sourceProjectId, eventId);
  if (!fs.existsSync(file)) return { ok: false, errors: ["not found"] };
  try {
    fs.unlinkSync(file);
    return { ok: true };
  } catch (cause) {
    return { ok: false, errors: [`delete failed: ${cause.message}`] };
  }
}

module.exports = {
  outboxDirFor,
  outboxPath,
  outboxFile,
  ensureOutboxDir,
  generateEventId,
  writeEvent,
  readEvents,
  deleteEvent,
};
