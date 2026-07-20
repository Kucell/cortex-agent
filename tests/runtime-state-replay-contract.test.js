"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "fixtures", "runtime-state", "failed-operation-replay");

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
}

test("a failed operation is replayable across resource, event, Run, Session, evidence, and log cursor", () => {
  const resource = read("resource.json");
  const events = read("events.json");
  const run = read("run.json");
  const session = read("session.json");
  const evidence = read("evidence.json");
  const cursors = read("log-cursors.json");
  const terminal = events[events.length - 1];

  assert.equal(resource.status, "failed");
  assert.equal(resource.latest_event_id, terminal.event_id);
  assert.equal(terminal.previous_event_id, events[0].event_id);
  assert.deepEqual(events.map((event) => event.transition.to), ["running", "failed"]);

  assert.equal(resource.relations.run_id, run.run_id);
  assert.equal(resource.relations.session_id, session.session_id);
  assert.equal(run.session_id, session.session_id);
  assert.equal(run.workspace_id, resource.resource_id);
  assert.ok(session.workspace_ids.includes(resource.resource_id));
  assert.equal(run.terminal_event_id, terminal.event_id);

  assert.ok(terminal.evidence_refs.includes(evidence[0].evidence_id));
  assert.ok(resource.evidence_refs.includes(evidence[0].evidence_id));
  assert.equal(evidence[0].run_id, run.run_id);
  assert.equal(evidence[0].session_id, session.session_id);
  assert.ok(terminal.log_cursor_refs.includes(cursors[0].cursor_id));
  assert.ok(resource.log_cursor_refs.includes(cursors[0].cursor_id));
  assert.equal(cursors[0].evidence_ref, evidence[0].evidence_id);
});

test("replay timestamps come from the target and all externally readable references are redacted", () => {
  const events = read("events.json");
  const evidence = read("evidence.json");
  const cursors = read("log-cursors.json");

  for (const cursor of cursors) {
    assert.notEqual(cursor.timestamp_source, "controller");
    assert.match(cursor.target_timestamp_utc, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(cursor.log_filter_start_utc, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(cursor.redacted, true);
  }
  for (const item of evidence) assert.equal(item.redacted, true);
  assert.ok(Date.parse(events[events.length - 1].at) >= Date.parse(cursors[0].target_timestamp_utc));
});
