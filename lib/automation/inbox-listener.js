"use strict";

// ─── Inbox Watcher (P-006 Capability C) ──────────────────────────────────────
//
// Polls (or ev-listens, when watchInbox is supported) the local inbox and,
// when a matching event arrives, dispatches a task into the configured
// downstream mission. Provides:
//   • loadInboxHandlerConfig(root)         — reads .agent/bridges/<id>.json
//   • planDispatch(event, handler)         — picks the target mission + MS
//   • runOnce(root, { source, event_id })  — single-pass dispatch
//
// Capability C **does not** spawn agents. It writes a `dispatch-pending.json`
// sidecar file in the target mission, plus the inbox-handler's contract
// metadata. Downstream agent runners (e.g. /mission or /start-task) consume
// the sidecar.
//
// Source: P-006 §3.3 Capability C.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const inboxStore = require("../cross-project/inbox-store");

function bridgesDir(root) {
  return path.join(path.resolve(root), ".agent", "bridges");
}

function loadInboxHandlerConfig(root, handlerId) {
  const file = path.join(bridgesDir(root), `${handlerId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    const error = new Error(`inbox handler config is corrupted: ${file}`);
    error.code = "AUTOMATION_HANDLER_CORRUPT";
    error.cause = cause;
    throw error;
  }
}

function listInboxHandlers(root) {
  const dir = bridgesDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

function planDispatch(event, handler) {
  if (!event || !handler) return null;
  if (!Array.isArray(handler.event_types) || !handler.event_types.includes(event.event_type)) return null;
  if (handler.correlation_group && event.correlation_group !== handler.correlation_group) return null;
  return {
    target_mission_id: handler.target_mission_id,
    target_milestone: handler.target_milestone || null,
    action: handler.action || "advance",
    payload: {
      bridge_event_id: event.bridge_event_id,
      source_project_id: event.source_project_id,
      event_type: event.event_type,
      correlation_group: event.correlation_group || null,
      summary: event.summary,
      propagated_at: event.propagated_at,
    },
  };
}

function writeDispatchSidecar(targetRoot, dispatch) {
  const dir = path.join(targetRoot, ".agent", "missions", dispatch.target_mission_id);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${dispatch.payload.bridge_event_id}-${Date.now().toString(36)}`;
  const target = path.join(dir, `${id}.dispatch-pending.json`);
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const data = `${JSON.stringify(dispatch, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* renamed or best-effort */ }
  }
  return target;
}

function runOnce(targetRoot, options) {
  const opts = options || {};
  const root = path.resolve(targetRoot);
  const handlerId = opts.handler_id;
  if (!handlerId) return { ok: false, errors: ["handler_id is required"] };
  const handler = loadInboxHandlerConfig(root, handlerId);
  if (!handler) return { ok: false, errors: [`handler not found: ${handlerId}`] };
  if (!handler.source_project_id) return { ok: false, errors: ["handler.source_project_id is required"] };
  const cursorPath = path.join(bridgesDir(root), `${handlerId}.cursor.json`);
  let cursor = {};
  try {
    cursor = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  } catch { /* fresh */ }
  // Cursor is "AFTER" semantics: walk every inbox event and only dispatch those
  // strictly past the cursor (propagated_at asc), tie-broken by bridge_event_id.
  // Using the bridge event id tie-break avoids re-dispatching when timestamps
  // tie on the same instant.
  const events = inboxStore.listInbox(root, { source: handler.source_project_id });
  const dispatched = [];
  let maxStamp = cursor.last_propagated_at || null;
  let maxId = cursor.last_bridge_event_id || null;
  for (const event of events) {
    if (event.__skipped) continue;
    if (opts.event_id && event.bridge_event_id !== opts.event_id) continue;
    if (cursor.last_propagated_at) {
      if (event.propagated_at < cursor.last_propagated_at) continue;
      if (event.propagated_at === cursor.last_propagated_at &&
          event.bridge_event_id <= cursor.last_bridge_event_id) continue;
    }
    const plan = planDispatch(event, handler);
    if (!plan) continue;
    const sidecar = writeDispatchSidecar(root, plan);
    dispatched.push({ bridge_event_id: event.bridge_event_id, sidecar, target_mission_id: plan.target_mission_id, target_milestone: plan.target_milestone });
    if (!maxStamp || event.propagated_at > maxStamp ||
        (event.propagated_at === maxStamp && event.bridge_event_id > maxId)) {
      maxStamp = event.propagated_at;
      maxId = event.bridge_event_id;
    }
  }
  if (maxStamp && (maxStamp !== (cursor.last_propagated_at || null) || maxId !== (cursor.last_bridge_event_id || null))) {
    const newCursor = {
      last_bridge_event_id: maxId,
      last_propagated_at: maxStamp,
      updated_at: new Date().toISOString(),
    };
    fs.mkdirSync(bridgesDir(root), { recursive: true });
    fs.writeFileSync(cursorPath, `${JSON.stringify(newCursor, null, 2)}\n`);
  }
  return { ok: true, dispatched, scanned: events.length };
}

function runAllOnce(targetRoot) {
  const root = path.resolve(targetRoot);
  const ids = listInboxHandlers(root);
  const runs = [];
  for (const id of ids) {
    const result = runOnce(root, { handler_id: id });
    runs.push({ handler_id: id, ...result });
  }
  return { ok: true, runs };
}

module.exports = {
  bridgesDir,
  loadInboxHandlerConfig,
  listInboxHandlers,
  planDispatch,
  writeDispatchSidecar,
  runOnce,
  runAllOnce,
};
