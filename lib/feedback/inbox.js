"use strict";

// ─── P-001 Feedback Immutable Inbox (F-002) ─────────────────────────────────
//
// Per-event layout:
//   <inboxRoot>/YYYY-MM-DD/<event_id>/event.json
//
// Write semantics (per `.agent/plans/proposals/projects/feedback-pipeline/
// proposals/P-001-collection-proposal.md` §5):
//   • Each event gets its own subdirectory; the directory creation is the
//     atomic claim point.
//   • The first `mkdir` with `recursive: false, mode 0o700` for the event-id
//     directory is the exclusive creation primitive (EEXIST = someone else
//     won; we retry with a new uuid up to N times).
//   • Inside the event-id directory we `open(... 'wx')` a temp file, write
//     the JSON, fsync and rename to `event.json`. The temp file is unlinked
//     on failure.
//   • Crash between mkdir and rename leaves a directory without event.json;
//     `readInbox` reports this as an `incomplete` diagnostic and never
//     fabricates content.
//   • Daily capacity is enforced by counting directories under YYYY-MM-DD/
//     before each write.
//   • Per-event byte cap is checked against the JSON payload size before
//     writing.
//   • Read paths: a corrupt JSON file inside an event directory is reported
//     as `corrupt` and skipped, never silently dropped. A directory with no
//     event.json but other files is reported as `incomplete`.
//
// Public API:
//   • inboxRootFor(root)                                 → absolute path
//   • appendEvent({ inboxRoot, event, byteLimit,
//                    dayCapacity, now })                  → { ok, path,
//                                                            fingerprint,
//                                                            eventId, ... }
//   • readInbox({ inboxRoot, options })                   → { events,
//                                                            diagnostics: {
//                                                              incomplete: [],
//                                                              corrupt: [],
//                                                              over_limit: [] } }
//   • summarize({ inboxRoot, options })                   → counts only,
//                                                            never reads files
//   • listEvents({ inboxRoot, filter })                   → array of events
//                                                            filtered by kind/
//                                                            severity/since
// All functions are pure with respect to inputs except `appendEvent` (writes)
// and the read paths (read files). Nothing mutates the user's payload.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactEventFields } = require("./redact");
const { validateEvent, computeFingerprint } = require("./event-schema");

const DEFAULT_MAX_EVENT_BYTES = 16384;
const DEFAULT_MAX_EVENTS_PER_DAY = 10000;
const DEFAULT_RETRY_COUNT = 3;

// ─── Path helpers ──────────────────────────────────────────────────────────

function inboxRootFor(root) {
  return path.join(path.resolve(root), ".agent", "feedback", "inbox");
}

function dayDirFor(inboxRoot, dateIso) {
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`inbox: invalid date ${JSON.stringify(dateIso)}`);
  }
  // YYYY-MM-DD in UTC for stability across machines.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return path.join(inboxRoot, `${yyyy}-${mm}-${dd}`);
}

function isEventId(value) {
  return typeof value === "string"
    && /^(?:fev_[0-9a-fA-F-]{8,128}|[0-9A-HJKMNP-TV-Z]{26})$/.test(value);
}

function newEventId() {
  return `fev_${crypto.randomUUID()}`;
}

// ─── Atomic event directory creation ───────────────────────────────────────

function tryClaimEventDir(dayDir, eventId, { mode = 0o700 } = {}) {
  const target = path.join(dayDir, eventId);
  try {
    fs.mkdirSync(target, { recursive: false, mode });
    return { ok: true, path: target };
  } catch (error) {
    if (error && error.code === "EEXIST") return { ok: false, code: "EEXIST" };
    return { ok: false, code: error && error.code ? error.code : "EUNKNOWN", error };
  }
}

function countEventsInDay(dayDir) {
  let entries;
  try {
    entries = fs.readdirSync(dayDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory() && isEventId(entry.name)) count += 1;
  }
  return count;
}

// ─── appendEvent ──────────────────────────────────────────────────────────

function appendEvent(options) {
  const {
    inboxRoot,
    event,
    byteLimit = DEFAULT_MAX_EVENT_BYTES,
    dayCapacity = DEFAULT_MAX_EVENTS_PER_DAY,
    retryCount = DEFAULT_RETRY_COUNT,
    redact = true,
  } = options || {};
  if (typeof inboxRoot !== "string" || inboxRoot.length === 0) {
    return { ok: false, code: "ARGS", reason: "inboxRoot is required" };
  }
  // Redact BEFORE any validation passes, per §8 (write-before-redact).
  let redactedInput = event;
  if (redact) {
    const { event: r } = redactEventFields(event);
    redactedInput = r;
  }
  // Validation runs on the redacted object so the schema's forbidden-field
  // checks still fire for any leftover PII markers.
  const validation = validateEvent(redactedInput, { adapterEnabled: true });
  if (!validation.ok) {
    return { ok: false, code: "SCHEMA", errors: validation.errors };
  }
  const normalized = validation.event;
  const payload = JSON.stringify(normalized, null, 2);
  const byteLen = Buffer.byteLength(payload, "utf8");
  if (byteLen > byteLimit) {
    return {
      ok: false,
      code: "OVER_LIMIT",
      bytes: byteLen,
      limit: byteLimit,
    };
  }
  const dayDir = dayDirFor(inboxRoot, normalized.occurred_at);
  // Ensure day dir exists. The day dir itself can be created by multiple
  // writers; the per-event subdir is the exclusive claim point.
  try {
    fs.mkdirSync(dayDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error && error.code !== "EEXIST") {
      return { ok: false, code: error.code || "EUNKNOWN", error };
    }
  }
  // Day capacity check BEFORE claiming any event-id dir.
  const dayCount = countEventsInDay(dayDir);
  if (dayCount >= dayCapacity) {
    return {
      ok: false,
      code: "DAY_CAPACITY_REACHED",
      day: path.basename(dayDir),
      capacity: dayCapacity,
      existing: dayCount,
    };
  }
  // Claim an event-id dir atomically. EEXIST means we collide; retry with
  // a fresh uuid (extremely rare, but the contract is explicit).
  let attempt = 0;
  let claimedDir = null;
  let lastCode = null;
  while (attempt < retryCount + 1) {
    const id = attempt === 0 ? normalized.event_id : newEventId();
    const claim = tryClaimEventDir(dayDir, id);
    if (claim.ok) {
      claimedDir = claim.path;
      normalized.event_id = id;
      normalized.fingerprint = computeFingerprint({
        schema_version: normalized.schema_version,
        kind: normalized.kind,
        diagnostic_code: normalized.diagnostic_code,
        title: normalized.title,
        source: normalized.source,
      });
      break;
    }
    lastCode = claim.code;
    attempt += 1;
  }
  if (!claimedDir) {
    return {
      ok: false,
      code: "EVENT_ID_COLLISION",
      retries: retryCount,
      lastCode,
    };
  }
  // Write the JSON inside the claimed dir.
  const target = path.join(claimedDir, "event.json");
  const temp = path.join(claimedDir, `.event.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    // fsync the directory so the rename survives a crash.
    const dirFd = fs.openSync(claimedDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    return {
      ok: false,
      code: error && error.code ? error.code : "EUNKNOWN",
      error,
      partialPath: claimedDir,
    };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* already closed */ }
    }
    try { fs.unlinkSync(temp); } catch (_) { /* renamed or absent */ }
  }
  return {
    ok: true,
    event_id: normalized.event_id,
    fingerprint: normalized.fingerprint,
    path: target,
    relative_path: path.relative(inboxRoot, target),
    bytes: byteLen,
  };
}

// ─── readInbox ─────────────────────────────────────────────────────────────

function safeReadJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, code: error && error.code ? error.code : "EUNKNOWN" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (_) {
    return { ok: false, code: "CORRUPT_JSON" };
  }
}

function listDayDirs(inboxRoot) {
  let entries;
  try {
    entries = fs.readdirSync(inboxRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readInbox(options) {
  const { inboxRoot, includeDays = null } = options || {};
  const out = { events: [], diagnostics: { incomplete: [], corrupt: [], over_limit: [] } };
  if (typeof inboxRoot !== "string") return out;
  let dayDirs;
  try {
    dayDirs = listDayDirs(inboxRoot);
  } catch (error) {
    out.diagnostics.readError = error.code || "EUNKNOWN";
    return out;
  }
  const filteredDays = typeof includeDays === "function"
    ? dayDirs.filter(includeDays)
    : dayDirs;
  for (const dayName of filteredDays) {
    const dayDir = path.join(inboxRoot, dayName);
    let entries;
    try {
      entries = fs.readdirSync(dayDir, { withFileTypes: true });
    } catch (error) {
      out.diagnostics.readError = error.code || "EUNKNOWN";
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isEventId(entry.name)) continue;
      const eventDir = path.join(dayDir, entry.name);
      const target = path.join(eventDir, "event.json");
      const read = safeReadJson(target);
      if (!read.ok) {
        if (read.code === "ENOENT") {
          // Crash between mkdir and rename — report and skip.
          out.diagnostics.incomplete.push({ day: dayName, event_id: entry.name, dir: eventDir });
        } else if (read.code === "CORRUPT_JSON") {
          out.diagnostics.corrupt.push({ day: dayName, event_id: entry.name, path: target });
        } else {
          out.diagnostics.corrupt.push({ day: dayName, event_id: entry.name, path: target, code: read.code });
        }
        continue;
      }
      // Validate the parsed JSON against the schema before exposing it. An
      // event that no longer passes the whitelist is treated as corrupt (we
      // never silently drop).
      const validation = validateEvent(read.value, { adapterEnabled: true });
      if (!validation.ok) {
        out.diagnostics.corrupt.push({ day: dayName, event_id: entry.name, path: target, errors: validation.errors });
        continue;
      }
      out.events.push({ day: dayName, event: validation.event, path: target });
    }
  }
  return out;
}

// ─── listEvents ────────────────────────────────────────────────────────────

function listEvents(options) {
  const { inboxRoot, kind, severity, since } = options || {};
  const read = readInbox({ inboxRoot });
  let sinceMs = null;
  if (typeof since === "string" && since.length > 0) {
    sinceMs = parseSince(since);
  }
  return read.events.filter((row) => {
    if (kind && row.event.kind !== kind) return false;
    if (severity && row.event.severity !== severity) return false;
    if (sinceMs !== null) {
      const ts = Date.parse(row.event.occurred_at);
      if (Number.isNaN(ts) || ts < sinceMs) return false;
    }
    return true;
  });
}

function parseSince(spec) {
  // Supported: "7d" / "24h" / "30m" / ISO date.
  const match = /^(\d+)([dhm])$/.exec(spec);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    const now = Date.now();
    if (unit === "d") return now - n * 24 * 60 * 60 * 1000;
    if (unit === "h") return now - n * 60 * 60 * 1000;
    if (unit === "m") return now - n * 60 * 1000;
  }
  const ts = Date.parse(spec);
  if (!Number.isNaN(ts)) return ts;
  return null;
}

// ─── summarize ─────────────────────────────────────────────────────────────

function summarize(options) {
  const { inboxRoot } = options || {};
  const out = {
    inboxRoot: typeof inboxRoot === "string" ? inboxRoot : null,
    days: 0,
    event_count: 0,
    by_kind: {},
    by_severity: {},
    diagnostics: { incomplete: 0, corrupt: 0 },
  };
  if (typeof inboxRoot !== "string") return out;
  let dayDirs;
  try {
    dayDirs = listDayDirs(inboxRoot);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      out.diagnostics.readError = error.code || "EUNKNOWN";
    }
    return out;
  }
  out.days = dayDirs.length;
  for (const dayName of dayDirs) {
    const read = readInbox({ inboxRoot, includeDays: (n) => n === dayName });
    out.event_count += read.events.length;
    out.diagnostics.incomplete += read.diagnostics.incomplete.length;
    out.diagnostics.corrupt += read.diagnostics.corrupt.length;
    for (const row of read.events) {
      out.by_kind[row.event.kind] = (out.by_kind[row.event.kind] || 0) + 1;
      out.by_severity[row.event.severity] = (out.by_severity[row.event.severity] || 0) + 1;
    }
  }
  return out;
}

module.exports = {
  inboxRootFor,
  dayDirFor,
  isEventId,
  newEventId,
  countEventsInDay,
  tryClaimEventDir,
  appendEvent,
  readInbox,
  listEvents,
  summarize,
  parseSince,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_EVENTS_PER_DAY,
  DEFAULT_RETRY_COUNT,
};