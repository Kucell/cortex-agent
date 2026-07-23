"use strict";

const fs = require("fs");
const path = require("path");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== "index.json" && !name.endsWith(".schema.json"))
      .map((name) => path.join(dir, name))
      .sort();
  } catch (_) {
    return [];
  }
}

function option(args, name) {
  const exact = args.indexOf(name);
  if (exact !== -1) return args[exact + 1] || null;
  const prefix = `${name}=`;
  const inline = args.find((arg) => typeof arg === "string" && arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) || null : null;
}

function localDateBoundary(value, end) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = end
    ? new Date(year, month, day + 1, 0, 0, 0, -1)
    : new Date(year, month, day, 0, 0, 0, 0);
  if (!end && (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day)) return null;
  const startCheck = new Date(year, month, day);
  if (startCheck.getFullYear() !== year || startCheck.getMonth() !== month || startCheck.getDate() !== day) return null;
  return date;
}

function parseBoundary(value, end, name) {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const local = dateOnly ? localDateBoundary(value, end) : null;
  const date = dateOnly ? local : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) {
    const error = new Error(`${name} must be an RFC 3339 timestamp or YYYY-MM-DD date.`);
    error.code = `invalid_${name.slice(2).replace(/-/g, "_")}`;
    throw error;
  }
  return date;
}

function relationSummary(record = {}) {
  const source = record.relations && typeof record.relations === "object" ? record.relations : {};
  const first = (value) => Array.isArray(value) ? value[0] || null : value || null;
  return {
    task_id: record.task_id || first(source.task_id) || first(source.task_ids),
    mission_id: record.mission_id || first(source.mission_id) || first(source.mission_ids),
    run_id: record.run_id || first(source.run_id) || first(source.run_ids),
    session_id: record.session_id || first(source.session_id) || first(source.session_ids),
  };
}

function evidence(record, fallback) {
  const refs = [
    ...(Array.isArray(record.evidence_refs) ? record.evidence_refs : []),
    ...(Array.isArray(record.refs) ? record.refs : []),
    ...(Array.isArray(record.artifact_refs) ? record.artifact_refs : []),
  ].filter(Boolean);
  if (fallback) refs.push(fallback);
  return [...new Set(refs)];
}

function queryActivity({ root, agentRoot, args }) {
  const since = parseBoundary(option(args, "--since"), false, "--since");
  const until = parseBoundary(option(args, "--until"), true, "--until");
  if (since && until && since.getTime() > until.getTime()) {
    const error = new Error("--since must not be later than --until.");
    error.code = "invalid_time_range";
    throw error;
  }

  const timed = new Map();
  const unknown = new Map();
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const add = (entry, rawTime) => {
    const timestamp = typeof rawTime === "string" && rawTime.trim() ? new Date(rawTime) : null;
    const valid = timestamp && Number.isFinite(timestamp.getTime());
    const normalized = {
      activity_id: entry.activity_id,
      at: valid ? timestamp.toISOString() : null,
      time_state: valid ? "known" : (rawTime ? "invalid" : "unknown"),
      kind: entry.kind,
      resource_id: entry.resource_id,
      status: entry.status || "unknown",
      title: entry.title || entry.resource_id,
      relations: relationSummary(entry),
      evidence_refs: evidence(entry, entry.path),
    };
    if (!valid) {
      unknown.set(normalized.activity_id, normalized);
      return;
    }
    if (since && timestamp.getTime() < since.getTime()) return;
    if (until && timestamp.getTime() > until.getTime()) return;
    timed.set(normalized.activity_id, normalized);
  };

  for (const file of jsonFiles(path.join(agentRoot, "tasks"))) {
    const task = readJson(file);
    if (!task || !task.task_id) continue;
    add({
      activity_id: `task:${task.task_id}`,
      kind: "task",
      resource_id: task.task_id,
      status: task.status,
      title: task.title,
      task_id: task.task_id,
      mission_id: task.mission_id,
      evidence_refs: task.source_refs,
      path: relative(file),
    }, task.updated_at || task.created_at);
  }

  for (const file of jsonFiles(path.join(agentRoot, "runs"))) {
    const run = readJson(file);
    if (!run || !run.run_id) continue;
    const events = Array.isArray(run.events) ? run.events : [];
    if (!events.length) {
      add({
        activity_id: `run:${run.run_id}`,
        kind: "run",
        resource_id: run.run_id,
        status: run.status,
        title: run.activity || `${run.kind || "run"} ${run.run_id}`,
        ...relationSummary(run),
        path: relative(file),
      }, run.finished_at || run.updated_at || run.started_at);
    }
    events.forEach((event, index) => add({
      activity_id: `run:${run.run_id}:event:${String(index + 1).padStart(4, "0")}`,
      kind: String(event.type || "").startsWith("validation_") ? "validation" : "run",
      resource_id: run.run_id,
      status: event.status || run.status,
      title: event.message || event.activity || event.type || run.run_id,
      ...relationSummary(run),
      evidence_refs: event.evidence_refs,
      path: relative(file),
    }, event.at));
  }

  for (const file of jsonFiles(path.join(agentRoot, "sessions"))) {
    const session = readJson(file);
    if (!session || !session.session_id) continue;
    add({
      activity_id: `session:${session.session_id}`,
      kind: "session",
      resource_id: session.session_id,
      status: session.status,
      title: session.activity || `${session.role || "session"} ${session.session_id}`,
      task_id: session.current_task_id,
      run_id: session.current_run_id,
      session_id: session.session_id,
      path: relative(file),
    }, session.closed_at || session.updated_at || session.last_heartbeat_at || session.started_at);
  }

  for (const file of jsonFiles(path.join(agentRoot, "decisions"))) {
    const decision = readJson(file);
    if (!decision || !decision.decision_id) continue;
    add({
      activity_id: `decision:${decision.decision_id}`,
      kind: "decision",
      resource_id: decision.decision_id,
      status: decision.status,
      title: decision.prompt || decision.rationale || decision.decision_id,
      ...relationSummary(decision),
      evidence_refs: decision.evidence_refs,
      path: relative(file),
    }, decision.resolved_at || decision.updated_at || decision.created_at);
  }

  for (const file of jsonFiles(path.join(agentRoot, "handoffs"))) {
    const handoff = readJson(file);
    if (!handoff || !handoff.handoff_id) continue;
    add({
      activity_id: `handoff:${handoff.handoff_id}`,
      kind: "handoff",
      resource_id: handoff.handoff_id,
      status: handoff.status || "created",
      title: handoff.next_action || handoff.handoff_id,
      task_id: handoff.task_id,
      mission_id: handoff.mission_id,
      session_id: handoff.from && handoff.from.session_id,
      artifact_refs: handoff.artifacts && handoff.artifacts.artifact_refs,
      path: relative(file),
    }, handoff.produced_at);
  }

  const artifactsRoot = path.join(agentRoot, "artifacts");
  let artifactDirs = [];
  try {
    artifactDirs = fs.readdirSync(artifactsRoot)
      .map((name) => path.join(artifactsRoot, name))
      .filter((dir) => { try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; } });
  } catch (_) {}
  for (const dir of artifactDirs.sort()) {
    for (const file of jsonFiles(dir).filter((candidate) => path.basename(candidate) !== "state.json")) {
      const artifact = readJson(file);
      if (!artifact || !artifact.artifact_id) continue;
      add({
        activity_id: `artifact:${artifact.artifact_id}`,
        kind: artifact.kind === "validation" ? "validation" : "artifact",
        resource_id: artifact.artifact_id,
        status: artifact.status || "produced",
        title: artifact.summary || artifact.artifact_id,
        task_id: artifact.task_id,
        mission_id: artifact.mission_id,
        artifact_refs: artifact.refs,
        path: relative(file),
      }, artifact.produced_at);
    }
  }

  const activity = [...timed.values()].sort((left, right) => right.at.localeCompare(left.at) || left.activity_id.localeCompare(right.activity_id));
  const unknownTime = [...unknown.values()].sort((left, right) => left.activity_id.localeCompare(right.activity_id));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return {
    ok: true,
    query: "activity",
    generated_at: new Date().toISOString(),
    filters: {
      since: since ? since.toISOString() : null,
      until: until ? until.toISOString() : null,
      inclusive: true,
      timezone,
    },
    activity,
    unknown_time: unknownTime,
    summary: {
      total: activity.length,
      unknown_time: unknownTime.length,
      by_kind: activity.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] || 0) + 1 }), {}),
    },
    warnings: unknownTime.length ? ["Records without valid structured timestamps are returned in unknown_time and excluded from date filtering."] : [],
  };
}

module.exports = { queryActivity };
