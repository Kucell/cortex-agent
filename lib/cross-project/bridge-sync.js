"use strict";

// ─── Cross-Project Event Bridge Sync (P-003 Phase 1) ────────────────────────
//
// syncForProject(targetRoot, { sourceProjectId, sourceRoot }):
//   1. Reads subscriptions.json from `targetRoot`.
//   2. For each subscription whose source_project_id === sourceProjectId:
//      a. Reads the source project's outbox:
//            <sourceRoot>/.agent-runtime/cross-project/outbox/<source>/<event-id>.json
//         (Phase 1 convention: the source writes its outbox under
//          `.agent-runtime/cross-project/outbox/<source-project-id>/`.)
//      b. Filters the events using subscription.event_types + subscription.filter.
//      c. Writes matching events to the local inbox at
//            <targetRoot>/.agent-runtime/cross-project/inbox/<source>/<event-id>.json
//      d. Records the highest propagated_at as a per-source cursor in
//            <targetRoot>/.agent-runtime/cross-project/cursors.json
//         so the next sync only processes events newer than the cursor.
//   3. Returns { ok, scanned, written, skipped, cursor, sources, errors[] }.
//
// Phase 1 simplification: the source root is passed via --source-root; the
// target project knows where the source lives. P-003 §4.2 step 1 says "read
// the source project's event list (since last_cursor)" — the source list is
// a flat list of bridge event JSONs in the source's outbox directory.
//
// Cursor semantics:
//   • cursors.json is keyed by source_project_id; each entry holds
//       { last_bridge_event_id, last_propagated_at, updated_at }.
//   • On sync, we read the source's outbox, filter, then keep any event with
//     propagated_at > cursor.last_propagated_at (or, when timestamps tie,
//     bridge_event_id > cursor.last_bridge_event_id). The new cursor is the
//     max of the kept set.
//   • If a subscription has no matching events yet, the cursor stays put.
//
// Source: P-003 §4.2 同步流程.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// MS-003: resolved via lib/runtime-layout (VC-011)
const { resolveRuntimePaths } = require("../runtime-layout");
const { validateBridgeEvent } = require("./bridge-event-schema");
const inboxStore = require("./inbox-store");
const subscriptions = require("./subscriptions");
const topologyRegistry = require("../topology");
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

// MS-003: Get cross-project directory for source (may be different project)
// Source project paths use legacy convention: .agent-runtime/cross-project
// However, during migration, source may also use new layout. We try new first,
// then fall back to legacy.
function sourceCrossProjectDir(sourceRoot) {
  const paths = resolveRuntimePaths(sourceRoot);
  // Try new first, fall back to legacy
  if (paths.legacyExists && !paths.activated) {
    // During compat window: check if legacy has content, else use new
    const legacyPath = paths["cross-project"].legacy;
    const newPath = paths["cross-project"].new;
    // Check if legacy cross-project dir has outbox subdir with any files
    const legacyOutbox = path.join(legacyPath, "outbox");
    const newOutbox = path.join(newPath, "outbox");
    if (fs.existsSync(legacyOutbox)) {
      try {
        const legacyEntries = fs.readdirSync(legacyOutbox);
        if (legacyEntries.length > 0) {
          return legacyPath;
        }
      } catch (_) { /* empty */ }
    }
    // Legacy empty or doesn't exist: use new
    return newPath;
  }
  // Activated or no legacy: use new
  return paths["cross-project"].new;
}

function cursorsPath(root) {
  return path.join(crossProjectDirFor(root), "cursors.json");
}

// sourceOutboxDir: source project's outbox (may be different project)
// Source project uses its own layout; we don't migrate external sources
function sourceOutboxDir(sourceRoot, sourceProjectId) {
  return path.join(sourceCrossProjectDir(sourceRoot), "outbox", sourceProjectId);
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

function readCursors(root) {
  const target = cursorsPath(root);
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { schema_version: 1, cursors: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.cursors !== "object" || parsed.cursors === null) {
      throw new Error("cursors.json: missing cursors object");
    }
    return parsed;
  } catch (cause) {
    const error = new Error("cursors.json is corrupted");
    error.code = "BRIDGE_CURSORS_CORRUPT";
    error.cause = cause;
    throw error;
  }
}

function writeCursors(root, payload) {
  ensureRuntimeRoot(root);
  const dir = crossProjectDirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = cursorsPath(root);
  const suffix = crypto.randomBytes(8).toString("hex");
  const temp = `${target}.tmp.${process.pid}.${suffix}`;
  const data = `${JSON.stringify(payload, null, 2)}\n`;
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
  return target;
}

function isAfterCursor(event, cursor) {
  if (!cursor) return true;
  if (event.propagated_at > cursor.last_propagated_at) return true;
  if (event.propagated_at < cursor.last_propagated_at) return false;
  // Tie-break by id so deterministic ordering wins.
  return event.bridge_event_id > cursor.last_bridge_event_id;
}

function readSourceOutbox(sourceRoot, sourceProjectId) {
  const dir = sourceOutboxDir(sourceRoot, sourceProjectId);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return { events: [], skipped: 0, skipDetails: [], reachable: false };
    throw error;
  }
  const events = [];
  const skipDetails = [];
  let skipped = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const parsed = safeReadJson(file);
    if (parsed === null) continue;
    if (parsed && parsed.__corrupt) {
      skipped += 1;
      skipDetails.push({ file: name, bridge_event_id: null, errors: ["file is not valid JSON"] });
      continue;
    }
    const result = validateBridgeEvent(parsed);
    if (!result.ok) {
      skipped += 1;
      skipDetails.push({
        file: name,
        bridge_event_id: typeof parsed.bridge_event_id === "string" ? parsed.bridge_event_id : null,
        errors: result.errors,
      });
      continue;
    }
    events.push(parsed);
  }
  return { events, skipped, skipDetails, reachable: true };
}

function syncForProject(targetRoot, options) {
  const { sourceProjectId, sourceRoot } = options || {};
  if (typeof sourceProjectId !== "string" || sourceProjectId.length === 0) {
    const error = new Error("syncForProject: sourceProjectId is required");
    error.code = "BRIDGE_SYNC_INVALID";
    throw error;
  }
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0) {
    const error = new Error("syncForProject: sourceRoot is required");
    error.code = "BRIDGE_SYNC_INVALID";
    throw error;
  }

  const result = {
    ok: true,
    source_project_id: sourceProjectId,
    scanned: 0,
    written: 0,
    skipped: 0,
    skipped_events: [],
    matched: 0,
    reachable: true,
    cursor: null,
    sources: [],
    errors: [],
  };

  let current;
  try {
    current = subscriptions.readSubscriptions(targetRoot);
  } catch (error) {
    result.ok = false;
    result.errors.push({ code: error.code || "BRIDGE_SUBSCRIPTIONS_CORRUPT", message: error.message });
    return result;
  }

  const subIndexes = [];
  current.subscriptions.forEach((sub, idx) => {
    if (sub.source_project_id === sourceProjectId) subIndexes.push(idx);
  });
  result.sources = subIndexes;

  if (subIndexes.length === 0) {
    // No subscription wants this source: still record the run as a no-op.
    return result;
  }

  let outbox;
  try {
    outbox = readSourceOutbox(sourceRoot, sourceProjectId);
  } catch (error) {
    result.ok = false;
    result.reachable = false;
    result.errors.push({ code: error.code || "BRIDGE_OUTBOX_UNREACHABLE", message: error.message });
    return result;
  }
  result.reachable = outbox.reachable;
  result.scanned = outbox.events.length;
  result.skipped = outbox.skipped;
  result.skipped_events = outbox.skipDetails;

  const cursorsDoc = readCursors(targetRoot);
  const cursorBefore = cursorsDoc.cursors[sourceProjectId] || null;
  result.cursor = cursorBefore;

  // Filter: must match AT LEAST one subscription targeting this source.
  // We pick the highest cursor-advanced event as the new cursor; every
  // accepted event is written to the inbox.
  const kept = [];
  for (const event of outbox.events) {
    const matches = subscriptions.matchEvent(
      subIndexes.map((idx) => current.subscriptions[idx]),
      event,
    );
    if (matches.length === 0) continue;
    if (!isAfterCursor(event, cursorBefore)) continue;
    kept.push({ event, matches });
  }
  result.matched = kept.length;

  if (kept.length === 0) {
    // No new events past the cursor; no write needed.
    return result;
  }

  // Sort kept events by (propagated_at, bridge_event_id) ascending so the
  // inbox + cursor advance in deterministic order.
  kept.sort((a, b) => {
    if (a.event.propagated_at === b.event.propagated_at) {
      return a.event.bridge_event_id.localeCompare(b.event.bridge_event_id);
    }
    return a.event.propagated_at < b.event.propagated_at ? -1 : 1;
  });

  let advanced = cursorBefore ? { ...cursorBefore } : { last_bridge_event_id: "", last_propagated_at: "" };
  for (const { event } of kept) {
    try {
      inboxStore.writeInboxEntry(targetRoot, sourceProjectId, event);
      result.written += 1;
    } catch (error) {
      result.errors.push({
        code: error.code || "BRIDGE_INBOX_WRITE_FAILED",
        message: error.message,
        bridge_event_id: event.bridge_event_id,
      });
      continue;
    }
    if (
      event.propagated_at > advanced.last_propagated_at ||
      (event.propagated_at === advanced.last_propagated_at &&
        event.bridge_event_id > advanced.last_bridge_event_id)
    ) {
      advanced = {
        last_bridge_event_id: event.bridge_event_id,
        last_propagated_at: event.propagated_at,
        updated_at: new Date().toISOString(),
      };
    }
  }

  // Persist cursor only when something advanced. We always persist on write,
  // but a write failure that left cursor untouched keeps the doc untouched.
  cursorsDoc.cursors[sourceProjectId] = advanced;
  cursorsDoc.schema_version = cursorsDoc.schema_version || 1;
  writeCursors(targetRoot, cursorsDoc);
  result.cursor = advanced;

  return result;
}

function syncAll(targetRoot, options = {}) {
  const { sourceRoot, onlySources } = options;
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0) {
    const error = new Error("syncAll: sourceRoot is required");
    error.code = "BRIDGE_SYNC_INVALID";
    throw error;
  }
  const current = subscriptions.readSubscriptions(targetRoot);
  const sourceIds = new Set();
  for (const sub of current.subscriptions) sourceIds.add(sub.source_project_id);
  if (Array.isArray(onlySources)) {
    for (const id of onlySources) sourceIds.add(id);
  }
  const runs = [];
  for (const sourceProjectId of sourceIds) {
    runs.push({ source_project_id: sourceProjectId, result: syncForProject(targetRoot, { sourceProjectId, sourceRoot }) });
  }
  return { ok: true, sources: runs };
}

// P-006 §3.5 auto-sync: walk the local subscriptions, look each source up in
// the P-001 topology registry for its host_root, then call syncForProject
// per-source. Unreachable sources (not in topology, or host_root missing)
// are reported as ok:false,reachable:false so the caller can exit 0
// (opportunistic sync, per P-003 §9.6).
function syncFromTopology(targetRoot, options = {}) {
  const opts = options || {};
  const current = subscriptions.readSubscriptions(targetRoot);
  const topologyDoc = topologyRegistry.readTopology(targetRoot);
  const seen = new Set();
  const sources = [];
  const unresolved = [];
  for (const sub of current.subscriptions) {
    if (seen.has(sub.source_project_id)) continue;
    seen.add(sub.source_project_id);
    const peer = topologyDoc && topologyDoc.peers
      ? topologyDoc.peers.find((p) => p.project_id === sub.source_project_id)
      : null;
    if (!peer || !peer.host_root) {
      unresolved.push({
        source_project_id: sub.source_project_id,
        reason: peer ? "peer_missing_host_root" : "peer_not_in_topology",
      });
      sources.push({
        source_project_id: sub.source_project_id,
        result: { ok: false, source_project_id: sub.source_project_id, reachable: false, errors: [{ code: "BRIDGE_SYNC_TOPOLOGY_UNRESOLVED", message: `source "${sub.source_project_id}" not in topology registry or has no host_root` }] },
      });
      continue;
    }
    const result = syncForProject(targetRoot, { sourceProjectId: sub.source_project_id, sourceRoot: peer.host_root });
    sources.push({ source_project_id: sub.source_project_id, host_root: peer.host_root, result });
  }
  return {
    ok: true,
    sources,
    unresolved,
    total: sources.length,
    reachable: sources.filter((s) => s.result && s.result.reachable !== false).length,
    unreachable: sources.length - sources.filter((s) => s.result && s.result.reachable !== false).length,
  };
}

module.exports = {
  syncForProject,
  syncAll,
  syncFromTopology,
  // Exposed for tests
  cursorsPath,
  sourceOutboxDir,
  readCursors,
  writeCursors,
  readSourceOutbox,
  isAfterCursor,
};
