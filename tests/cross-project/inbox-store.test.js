"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const inboxStore = require("../../lib/cross-project/inbox-store");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bridge-inbox-"));
}

function withRoot(fn) {
  return (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return fn(t, root);
  };
}

function mkEvent(overrides = {}) {
  return {
    bridge_event_id: "BR-EVT-001",
    source_project_id: "cortex-agent",
    source_task_id: "T-001",
    event_type: "task.state_changed",
    summary: { to_state: "READY_FOR_REVIEW" },
    propagated_at: "2026-08-05T00:00:01.000Z",
    ...overrides,
  };
}

test("inboxDirFor and inboxEntryPath follow the P-003 §3.1 layout", withRoot((t, root) => {
  const dir = inboxStore.inboxDirFor(root, "cortex-agent");
  assert.equal(dir, path.join(root, ".agent-runtime", "cross-project", "inbox", "cortex-agent"));
  const file = inboxStore.inboxEntryPath(root, "cortex-agent", "BR-EVT-001");
  assert.equal(file, path.join(dir, "BR-EVT-001.json"));
}));

test("inboxEntryPath rejects malformed bridge_event_id", () => {
  assert.throws(() => inboxStore.inboxEntryPath("/tmp", "cortex-agent", "EVT-001"), /invalid bridge_event_id/);
  assert.throws(() => inboxStore.inboxEntryPath("/tmp", "cortex-agent", ""), /invalid bridge_event_id/);
});

test("inboxDirFor rejects empty source id", () => {
  assert.throws(() => inboxStore.inboxDirFor("/tmp", ""), /sourceProjectId is required/);
});

test("readInbox returns empty when the source dir does not exist (cold start)", withRoot((t, root) => {
  const result = inboxStore.readInbox(root, "cortex-agent");
  assert.deepEqual(result, { events: [], skipped: 0 });
}));

test("writeInboxEntry creates the source dir and the event file", withRoot((t, root) => {
  const event = mkEvent();
  const result = inboxStore.writeInboxEntry(root, "cortex-agent", event);
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.path));
  const onDisk = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.deepEqual(onDisk, event);
}));

test("writeInboxEntry rejects events with invalid schema", withRoot((t, root) => {
  assert.throws(
    () => inboxStore.writeInboxEntry(root, "cortex-agent", { ...mkEvent(), bridge_event_id: "bad" }),
    (err) => err.code === "BRIDGE_EVENT_INVALID" && err.details && err.details.length > 0,
  );
}));

test("writeInboxEntry rejects source_project_id mismatch", withRoot((t, root) => {
  assert.throws(
    () => inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ source_project_id: "SamHMI" })),
    (err) => err.code === "BRIDGE_EVENT_SOURCE_MISMATCH",
  );
}));

test("writeInboxEntry is atomic: temp file is gone after success", withRoot((t, root) => {
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent());
  const dir = inboxStore.inboxDirFor(root, "cortex-agent");
  const stragglers = fs.readdirSync(dir).filter((n) => n.includes(".tmp."));
  assert.equal(stragglers.length, 0, `unexpected temp files: ${stragglers.join(",")}`);
}));

test("writeInboxEntry overwrites the same event id (idempotent re-delivery)", withRoot((t, root) => {
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ summary: { to_state: "EXECUTING" } }));
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ summary: { to_state: "READY_FOR_REVIEW" } }));
  const { events, skipped } = inboxStore.readInbox(root, "cortex-agent");
  assert.equal(events.length, 1);
  assert.equal(skipped, 0);
  assert.equal(events[0].summary.to_state, "READY_FOR_REVIEW");
}));

test("readInbox returns events newest-first by propagated_at", withRoot((t, root) => {
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-001", propagated_at: "2026-08-05T00:00:01.000Z" }));
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-002", propagated_at: "2026-08-05T00:00:03.000Z" }));
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-003", propagated_at: "2026-08-05T00:00:02.000Z" }));
  const { events } = inboxStore.readInbox(root, "cortex-agent");
  assert.deepEqual(events.map((e) => e.bridge_event_id), ["BR-EVT-002", "BR-EVT-003", "BR-EVT-001"]);
}));

test("readInbox skips corrupt and invalid files but still returns valid events", withRoot((t, root) => {
  const dir = inboxStore.inboxDirFor(root, "cortex-agent");
  fs.mkdirSync(dir, { recursive: true });
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-001" }));
  fs.writeFileSync(path.join(dir, "BR-EVT-CORRUPT.json"), "not json {{{");
  fs.writeFileSync(path.join(dir, "BR-EVT-INVALID.json"), JSON.stringify({ bridge_event_id: "BR-EVT-INVALID" }));
  const { events, skipped } = inboxStore.readInbox(root, "cortex-agent");
  assert.equal(events.length, 1);
  assert.equal(events[0].bridge_event_id, "BR-EVT-001");
  assert.equal(skipped, 2);
}));

test("listInbox with no source returns events from all sources", withRoot((t, root) => {
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-A1", source_project_id: "cortex-agent" }));
  inboxStore.writeInboxEntry(root, "SamHMI", mkEvent({ bridge_event_id: "BR-EVT-B1", source_project_id: "SamHMI", propagated_at: "2026-08-05T00:00:02.000Z" }));
  const events = inboxStore.listInbox(root);
  assert.equal(events.length, 2);
  assert.equal(events[0].bridge_event_id, "BR-EVT-B1");
  assert.equal(events[1].bridge_event_id, "BR-EVT-A1");
}));

test("listInbox with --source restricts to one source", withRoot((t, root) => {
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-A1" }));
  inboxStore.writeInboxEntry(root, "SamHMI", mkEvent({ bridge_event_id: "BR-EVT-B1", source_project_id: "SamHMI" }));
  const events = inboxStore.listInbox(root, { source: "SamHMI" });
  assert.equal(events.length, 1);
  assert.equal(events[0].bridge_event_id, "BR-EVT-B1");
}));

test("listInbox with --since filters by propagated_at (inclusive)", withRoot((t, root) => {
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-A1", propagated_at: "2026-08-01T00:00:00.000Z" }));
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-A2", propagated_at: "2026-08-05T00:00:00.000Z" }));
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-A3", propagated_at: "2026-08-10T00:00:00.000Z" }));
  const events = inboxStore.listInbox(root, { since: "2026-08-05T00:00:00.000Z" });
  // Newest first per the cross-source sort.
  assert.deepEqual(events.map((e) => e.bridge_event_id), ["BR-EVT-A3", "BR-EVT-A2"]);
}));

test("listInbox rejects invalid --since values", withRoot((t, root) => {
  assert.throws(
    () => inboxStore.listInbox(root, { since: "not-a-date" }),
    (err) => err.code === "BRIDGE_SINCE_INVALID",
  );
}));

test("listInboxSources lists source project ids present in the inbox tree", withRoot((t, root) => {
  inboxStore.writeInboxEntry(root, "cortex-agent", mkEvent({ bridge_event_id: "BR-EVT-A1" }));
  inboxStore.writeInboxEntry(root, "SamHMI", mkEvent({ bridge_event_id: "BR-EVT-B1", source_project_id: "SamHMI" }));
  const sources = inboxStore.listInboxSources(root).sort();
  assert.deepEqual(sources, ["SamHMI", "cortex-agent"]);
}));

test("listInboxSources returns empty when no inbox dir exists", withRoot((t, root) => {
  assert.deepEqual(inboxStore.listInboxSources(root), []);
}));
