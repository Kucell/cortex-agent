"use strict";

const fs = require("fs");
const path = require("path");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

// Runtime namespace resolution.
//
// Coordination state can live in two layouts: the activated portable
// namespace `.agent/runtime/coordination`, and the legacy
// `.agent-runtime/coordination` that predates the layout migration. A
// `layout.json` activation marker means the new layout is authoritative for
// WRITES; it does not prove every pre-existing record was migrated. The
// runtime-layout resolver therefore reads new-first with a per-file legacy
// fallback (lib/runtime-layout/resolver.js `readWithLegacyFallback`). This
// helper mirrors that contract while staying self-contained for distribution
// to consumer projects, so a Task that still lives in legacy storage is never
// reported as missing after activation.
//
// Order matters: the first root that holds a record wins.
function coordinationRoots(root) {
  const newDir = path.join(root, ".agent", "runtime", "coordination");
  const legacyDir = path.join(root, ".agent-runtime", "coordination");
  const activated = fs.existsSync(path.join(root, ".agent", "runtime", "layout.json"));
  const legacyExists = fs.existsSync(legacyDir);
  if (activated) {
    // New layout owns writes; legacy stays readable for un-migrated records.
    return legacyExists ? [newDir, legacyDir] : [newDir];
  }
  // Compatibility window: a legacy runtime stays authoritative even if an
  // earlier failed write left an empty new runtime directory behind.
  return legacyExists ? [legacyDir] : [newDir];
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

function recordKey(record) {
  if (!record || typeof record !== "object") return JSON.stringify(record);
  const identity = record.taskId || record.eventId || record.leaseId || record.consumerId;
  return identity ? String(identity) : JSON.stringify(record);
}

// Read the first existing JSON file across the ordered runtime roots.
function readJsonAt(roots, ...segments) {
  for (const runtimeRoot of roots) {
    const value = readJson(path.join(runtimeRoot, ...segments));
    if (value !== null) return value;
  }
  return null;
}

// Concatenate the JSON files of every runtime root, new layout first. Records
// already seen in an earlier root win, so an activated project keeps its
// new-layout record as the single source of truth for a given identity.
function listJsonAt(roots, ...segments) {
  const seen = new Set();
  const records = [];
  for (const runtimeRoot of roots) {
    for (const record of listJson(path.join(runtimeRoot, ...segments))) {
      const key = recordKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
  }
  return records;
}

function listSnapshotsAt(roots, ...segments) {
  // Snapshot envelopes carry bookkeeping fields that differ between the two
  // layouts, so deduplicate on the payload identity instead: a Task recorded
  // in both roots must surface exactly once, with the new layout winning.
  const seen = new Set();
  const payloads = [];
  for (const runtimeRoot of roots) {
    for (const envelope of listJson(path.join(runtimeRoot, ...segments))) {
      const payload = envelope && envelope.payload;
      if (!payload || typeof payload !== "object") continue;
      const key = recordKey(payload);
      if (seen.has(key)) continue;
      seen.add(key);
      payloads.push(payload);
    }
  }
  return payloads;
}

function readJournalSegment(journalDir) {
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

function listEventsAt(roots, ...segments) {
  const events = [];
  const warnings = [];
  const seen = new Set();
  for (const runtimeRoot of roots) {
    const segment = readJournalSegment(path.join(runtimeRoot, ...segments));
    for (const event of segment.events) {
      const key = recordKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
    warnings.push(...segment.warnings);
  }
  return { events, warnings };
}

function queryCoordination({ root, args, projection }) {
  const roots = coordinationRoots(root);
  const taskId = option(args, "task");
  if (projection === "coordination-tasks") {
    let tasks = listSnapshotsAt(roots, "tasks");
    const state = option(args, "state");
    if (taskId) tasks = tasks.filter((task) => task.taskId === taskId);
    if (state) tasks = tasks.filter((task) => task.state === state);
    const byState = {};
    for (const task of tasks) byState[task.state || "UNKNOWN"] = (byState[task.state || "UNKNOWN"] || 0) + 1;
    return { ok: true, query: projection, generated_at: new Date().toISOString(), tasks, summary: { total: tasks.length, by_state: byState } };
  }
  if (projection === "coordination-events") {
    const journal = listEventsAt(roots, "journal");
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
    const durable = readJsonAt(roots, "leases", "state.json");
    records = durable && Array.isArray(durable.leases) ? durable.leases : [];
  } else {
    records = listJsonAt(roots, "consumers");
  }
  if (field === "notifications") {
    const eventTasks = new Map(listEventsAt(roots, "journal").events.map((event) => [event.eventId, event.taskId]));
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
