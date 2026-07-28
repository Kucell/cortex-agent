"use strict";

const fs = require("fs");
const path = require("path");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function option(args, name) {
  const marker = `--${name}`;
  const index = args.indexOf(marker);
  return index >= 0 ? args[index + 1] : null;
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readJson(path.join(dir, name)))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function listSnapshots(dir) {
  return listJson(dir)
    .map((envelope) => envelope && envelope.payload)
    .filter((payload) => payload && typeof payload === "object");
}

function listEvents(journalDir) {
  let files;
  try {
    files = fs.readdirSync(journalDir)
      .filter((name) => /^events-\d+\.jsonl$/.test(name))
      .sort();
  } catch (_) {
    return { events: [], warnings: [] };
  }
  const events = [];
  const warnings = [];
  for (const name of files) {
    const lines = fs.readFileSync(path.join(journalDir, name), "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && record.event && typeof record.event === "object") {
          events.push(record.event);
        } else {
          warnings.push({ code: "coordination_journal_record_invalid", segment: name });
        }
      } catch (_) {
        warnings.push({ code: "coordination_journal_parse_error", segment: name });
      }
    }
  }
  return { events, warnings };
}

function queryCoordination({ root, args, projection }) {
  const runtime = path.join(root, ".agent-runtime", "coordination");
  const taskId = option(args, "task");
  if (projection === "coordination-tasks") {
    let tasks = listSnapshots(path.join(runtime, "tasks"));
    const state = option(args, "state");
    if (taskId) tasks = tasks.filter((task) => task.taskId === taskId);
    if (state) tasks = tasks.filter((task) => task.state === state);
    const byState = {};
    for (const task of tasks) byState[task.state || "UNKNOWN"] = (byState[task.state || "UNKNOWN"] || 0) + 1;
    return { ok: true, query: projection, generated_at: new Date().toISOString(), tasks, summary: { total: tasks.length, by_state: byState } };
  }
  if (projection === "coordination-events") {
    const journal = listEvents(path.join(runtime, "journal"));
    let events = journal.events;
    const eventType = option(args, "event-type");
    const producer = option(args, "producer");
    if (taskId) events = events.filter((event) => event.taskId === taskId);
    if (eventType) events = events.filter((event) => event.eventType === eventType);
    if (producer) events = events.filter((event) => event.producer && event.producer.actorId === producer);
    return { ok: true, query: projection, generated_at: new Date().toISOString(), events, summary: { total: events.length }, warnings: journal.warnings };
  }
  const field = projection === "coordination-ownership" ? "ownership" : "notifications";
  let records;
  if (field === "ownership") {
    const durable = readJson(path.join(runtime, "leases", "state.json"));
    records = durable && Array.isArray(durable.leases) ? durable.leases : [];
  } else {
    records = listJson(path.join(runtime, "consumers"));
  }
  if (field === "notifications") {
    const eventTasks = new Map(listEvents(path.join(runtime, "journal")).events.map((event) => [event.eventId, event.taskId]));
    records = records.flatMap((cursor) => Object.entries(cursor.pending || {}).map(([deliveryKey, pending]) => ({
      consumerId: cursor.consumerId,
      deliveryKey,
      taskId: eventTasks.get(pending.eventId) || null,
      ...pending,
    })));
  }
  if (taskId) records = records.filter((record) => record.taskId === taskId);
  return { ok: true, query: projection, generated_at: new Date().toISOString(), [field]: records, summary: { total: records.length } };
}

module.exports = { queryCoordination };
