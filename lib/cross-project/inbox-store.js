"use strict";

// ─── Cross-Project Event Inbox Store (P-003 Phase 1) ────────────────────────
//
// Per-project filesystem inbox at
//   <root>/.agent-runtime/cross-project/inbox/<source-project-id>/<event-id>.json
//
// Atomic writes follow the project's established temp-file + atomic rename
// + fsync pattern (see lib/coordination/lease-store.js). Reads tolerate a
// missing directory by returning an empty list — the inbox is *derived*
// state and may legitimately be empty before the first sync.
//
// Phase 1: this is the CONSUMER side. The producer (cortex-agent producing
// bridge events to its own outbox) is intentionally out of scope; sync is
// driven externally via `bridge sync --source-root <path>`.
//
// Public API:
//   • inboxDirFor(root, sourceProjectId)           → absolute path
//   • inboxEntryPath(root, sourceProjectId, id)    → absolute path
//   • readInbox(root, sourceProjectId)             → array of validated events
//                                                    (skips corrupt files with
//                                                    a `skipped` count)
//   • writeInboxEntry(root, sourceProjectId, event) → { ok, path, skipped }
//                                                    (atomic; rejects
//                                                    invalid event ids)
//   • listInbox(root, { source, since })           → filtered events from one
//                                                    or all sources
//   • listInboxSources(root)                       → string[] of source ids
//                                                    that have a non-empty dir
//
// The on-disk JSON shape matches the bridgeEventSchema in bridge-event-schema.js.
// The store is write-once: re-writing the same event id OVERWRITES the previous
// file (since both writes carry the same payload and consumers should be
// idempotent). Corruption in an existing file is reported via `skipped`, not
// silently dropped.
//
// Source: P-003 §3.1 桥接存储, §3.2 事件摘要格式.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// MS-003: resolved via lib/runtime-layout (VC-011)
const { resolveRuntimePaths } = require("../runtime-layout");
const { validateBridgeEvent, isValidBridgeEventId } = require("./bridge-event-schema");
const { ensureRuntimeRoot } = require("./runtime-root");

// MS-003: Get cross-project directory using shared runtime-layout API (VC-011)
// Uses new-first/legacy-fallback per VC-012 compatibility window
function crossProjectDirFor(root) {
  const paths = resolveRuntimePaths(root);
  // During compat window: prefer legacy if exists, else new
  // After activation: always use new
  if (paths.legacyExists && !paths.activated) {
    return paths["cross-project"].legacy;
  }
  return paths["cross-project"].new;
}

function inboxDirFor(root, sourceProjectId) {
  if (typeof sourceProjectId !== "string" || sourceProjectId.length === 0) {
    throw new Error("inboxDirFor: sourceProjectId is required");
  }
  return path.join(crossProjectDirFor(root), "inbox", sourceProjectId);
}

function inboxEntryPath(root, sourceProjectId, eventId) {
  if (!isValidBridgeEventId(eventId)) {
    throw new Error(`inboxEntryPath: invalid bridge_event_id ${JSON.stringify(eventId)}`);
  }
  return path.join(inboxDirFor(root, sourceProjectId), `${eventId}.json`);
}

function safeReadJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { __corrupt: true };
  }
}

function readInbox(root, sourceProjectId) {
  const dir = inboxDirFor(root, sourceProjectId);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return { events: [], skipped: 0 };
    throw error;
  }
  const events = [];
  let skipped = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const parsed = safeReadJson(file);
    if (parsed === null) continue; // race: removed between readdir and read
    if (parsed && parsed.__corrupt) {
      skipped += 1;
      continue;
    }
    const result = validateBridgeEvent(parsed);
    if (!result.ok) {
      skipped += 1;
      continue;
    }
    events.push({ ...parsed, _path: file });
  }
  // Stable order by propagated_at then id (newest first per the spec's
  // assumption that propagation timestamps roughly mirror event order).
  events.sort((a, b) => {
    if (a.propagated_at === b.propagated_at) return a.bridge_event_id.localeCompare(b.bridge_event_id);
    return a.propagated_at < b.propagated_at ? 1 : -1;
  });
  return { events, skipped };
}

function writeInboxEntry(root, sourceProjectId, event) {
  const validation = validateBridgeEvent(event);
  if (!validation.ok) {
    const error = new Error(`writeInboxEntry: invalid event: ${validation.errors.join("; ")}`);
    error.code = "BRIDGE_EVENT_INVALID";
    error.details = validation.errors;
    throw error;
  }
  if (event.source_project_id !== sourceProjectId) {
    const error = new Error(
      `writeInboxEntry: event.source_project_id=${JSON.stringify(event.source_project_id)} does not match path ${JSON.stringify(sourceProjectId)}`,
    );
    error.code = "BRIDGE_EVENT_SOURCE_MISMATCH";
    throw error;
  }
  ensureRuntimeRoot(root);
  const dir = inboxDirFor(root, sourceProjectId);
  fs.mkdirSync(dir, { recursive: true });
  const target = inboxEntryPath(root, sourceProjectId, event.bridge_event_id);
  const suffix = crypto.randomBytes(8).toString("hex");
  const temp = `${target}.tmp.${process.pid}.${suffix}`;
  const data = `${JSON.stringify(event, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed or best-effort cleanup */ }
  }
  return { ok: true, path: target };
}

function listInbox(root, options = {}) {
  // Validate --since first so callers get a structured error even when
  // the inbox dir is empty / missing (cold start).
  const sinceMs = options.since ? Date.parse(options.since) : null;
  if (options.since && Number.isNaN(sinceMs)) {
    const error = new Error(`listInbox: --since is not a valid date: ${JSON.stringify(options.since)}`);
    error.code = "BRIDGE_SINCE_INVALID";
    throw error;
  }

  const baseDir = path.join(crossProjectDirFor(root), "inbox");
  let sources;
  if (options.source) {
    sources = [options.source];
  } else {
    try {
      sources = fs.readdirSync(baseDir).filter((name) => {
        try {
          return fs.statSync(path.join(baseDir, name)).isDirectory();
        } catch (_) {
          return false;
        }
      });
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      throw error;
    }
  }
  const out = [];
  for (const source of sources) {
    const { events, skipped } = readInbox(root, source);
    for (const ev of events) {
      if (sinceMs !== null) {
        const ts = Date.parse(ev.propagated_at);
        if (Number.isNaN(ts) || ts < sinceMs) continue;
      }
      out.push({ ...ev, _source_project_id: source });
    }
    if (skipped > 0) {
      // Surface corruption at the boundary; consumers may log/audit.
      out.push({ __skipped: true, source_project_id: source, skipped });
    }
  }
  // Newest first across sources.
  out.sort((a, b) => {
    if (a.__skipped) return 1;
    if (b.__skipped) return -1;
    if (a.propagated_at === b.propagated_at) return a.bridge_event_id.localeCompare(b.bridge_event_id);
    return a.propagated_at < b.propagated_at ? 1 : -1;
  });
  return out;
}

function listInboxSources(root) {
  const baseDir = path.join(crossProjectDirFor(root), "inbox");
  try {
    return fs.readdirSync(baseDir).filter((name) => {
      try {
        return fs.statSync(path.join(baseDir, name)).isDirectory();
      } catch (_) {
        return false;
      }
    });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

module.exports = {
  crossProjectDirFor,
  inboxDirFor,
  inboxEntryPath,
  readInbox,
  writeInboxEntry,
  listInbox,
  listInboxSources,
};
