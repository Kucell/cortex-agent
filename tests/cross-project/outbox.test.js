"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const outbox = require("../../lib/cross-project/outbox");
const { resolveRuntimePaths } = require("../../lib/runtime-layout");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bridge-outbox-"));
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
    event_type: "task.state_changed",
    summary: { to_state: "READY_FOR_REVIEW" },
    propagated_at: "2026-08-12T00:00:00.000Z",
    correlation_group: "agentic-ui-delivery",
    ...overrides,
  };
}

test("outboxPath + outboxFile derive directories safely", () => {
  const root = mkRoot();
  const dir = outbox.outboxPath(root, "cortex-agent");
  assert.equal(path.basename(dir), "cortex-agent");
  assert.equal(path.basename(path.dirname(dir)), "outbox");
  assert.equal(path.basename(path.dirname(path.dirname(dir))), "cross-project");
  fs.rmSync(root, { recursive: true, force: true });
});

test("generateEventId produces a valid BR-EVT-* id", () => {
  const id = outbox.generateEventId("p006-test");
  assert.match(id, /^BR-EVT-p006-test-[0-9a-z-]+$/);
});

test("generateEventId with numeric sequence returns deterministic padded id", () => {
  assert.equal(outbox.generateEventId("p006", 7), "BR-EVT-p006-007");
  assert.equal(outbox.generateEventId("hmi-collab", 42), "BR-EVT-hmi-collab-042");
});

test("writeEvent rejects missing event_type", withRoot((t, root) => {
  const result = outbox.writeEvent(root, {
    source_project_id: "cortex-agent",
    summary: {},
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("event_type")));
}));

test("writeEvent rejects array summary", withRoot((t, root) => {
  const result = outbox.writeEvent(root, {
    source_project_id: "cortex-agent",
    event_type: "task.state_changed",
    summary: [1, 2, 3],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("summary")));
}));

test("writeEvent validates against bridge-event-schema", withRoot((t, root) => {
  const result = outbox.writeEvent(root, {
    source_project_id: "cortex-agent",
    event_type: "made_up_type",
    summary: {},
    propagated_at: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /event_type/.test(e)));
}));

test("writeEvent persists schema-valid event on disk", withRoot((t, root) => {
  const result = outbox.writeEvent(root, {
    source_project_id: "cortex-agent",
    event_type: "task.state_changed",
    summary: { task_id: "M-017", state: "READY_FOR_REVIEW" },
    correlation_group: "agentic-ui-delivery",
    bridge_event_id: "BR-EVT-p006-001",
    propagated_at: "2026-08-12T01:23:45.678Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.event_id, "BR-EVT-p006-001");
  assert.ok(fs.existsSync(result.file));
  const raw = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.equal(raw.bridge_event_id, "BR-EVT-p006-001");
  assert.equal(raw.source_project_id, "cortex-agent");
  assert.equal(raw.event_type, "task.state_changed");
  assert.deepEqual(raw.summary, { task_id: "M-017", state: "READY_FOR_REVIEW" });
  assert.equal(raw.correlation_group, "agentic-ui-delivery");
}));

test("writeEvent refuses duplicates without overwrite flag", withRoot((t, root) => {
  const opts = {
    source_project_id: "cortex-agent",
    event_type: "decision.resolved",
    summary: { decision_id: "D-1" },
    bridge_event_id: "BR-EVT-p006-dup",
    propagated_at: "2026-08-12T01:00:00.000Z",
  };
  const a = outbox.writeEvent(root, opts);
  assert.equal(a.ok, true);
  const b = outbox.writeEvent(root, opts);
  assert.equal(b.ok, false);
  assert.ok(b.errors[0].includes("already exists"));
}));

test("writeEvent with overwrite=true replaces existing event", withRoot((t, root) => {
  const opts = {
    source_project_id: "cortex-agent",
    event_type: "decision.resolved",
    summary: { decision_id: "D-1" },
    bridge_event_id: "BR-EVT-p006-dup2",
    propagated_at: "2026-08-12T01:00:00.000Z",
  };
  outbox.writeEvent(root, opts);
  const result = outbox.writeEvent(root, { ...opts, summary: { decision_id: "D-2" }, overwrite: true });
  assert.equal(result.ok, true);
  const raw = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.deepEqual(raw.summary, { decision_id: "D-2" });
}));

test("readEvents lists events in propagated_at order", withRoot((t, root) => {
  const base = { source_project_id: "cortex-agent", event_type: "task.state_changed", summary: {} };
  outbox.writeEvent(root, { ...base, bridge_event_id: "BR-EVT-p006-a", propagated_at: "2026-08-12T00:00:02.000Z" });
  outbox.writeEvent(root, { ...base, bridge_event_id: "BR-EVT-p006-b", propagated_at: "2026-08-12T00:00:01.000Z" });
  outbox.writeEvent(root, { ...base, bridge_event_id: "BR-EVT-p006-c", propagated_at: "2026-08-12T00:00:03.000Z" });
  const result = outbox.readEvents(root, { source_project_id: "cortex-agent" });
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 3);
  assert.deepEqual(result.events.map((e) => e.bridge_event_id), ["BR-EVT-p006-b", "BR-EVT-p006-a", "BR-EVT-p006-c"]);
}));

// MS-003: Updated to use correct runtime path based on activation state
test("readEvents since filter excludes older mtimes", withRoot((t, root) => {
  const base = { source_project_id: "cortex-agent", event_type: "task.state_changed", summary: {} };
  // Write the older event first, then capture `since` from a moment after the
  // older event was written but before the new one — using fs.utimesSync so
  // mtime is deterministic for the old file.
  // MS-003: Use the correct outbox path based on the runtime layout
  outbox.writeEvent(root, { ...base, bridge_event_id: "BR-EVT-p006-old", propagated_at: "2026-08-12T00:00:00.000Z" });
  const paths = resolveRuntimePaths(root);
  const outboxDir = path.join(paths["cross-project"].new, "outbox", "cortex-agent");
  const olderFile = path.join(outboxDir, "BR-EVT-p006-old.json");
  fs.utimesSync(olderFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  const since = new Date(Date.now() - 1000).toISOString();
  outbox.writeEvent(root, { ...base, bridge_event_id: "BR-EVT-p006-new", propagated_at: new Date().toISOString() });
  const result = outbox.readEvents(root, { source_project_id: "cortex-agent", since });
  assert.equal(result.ok, true);
  // Since filtering uses mtime, the old event's pinned mtime is also old, so
  // it is excluded. The new one has a recent mtime.
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].bridge_event_id, "BR-EVT-p006-new");
}));

test("readEvents on missing dir returns empty list", withRoot((t, root) => {
  const result = outbox.readEvents(root, { source_project_id: "never-written" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.events, []);
}));

test("deleteEvent removes the file", withRoot((t, root) => {
  const a = outbox.writeEvent(root, {
    source_project_id: "cortex-agent",
    event_type: "checkpoint.closed",
    summary: {},
    bridge_event_id: "BR-EVT-p006-del",
    propagated_at: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(a.ok, true);
  const r = outbox.deleteEvent(root, "cortex-agent", "BR-EVT-p006-del");
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(a.file));
}));

test("deleteEvent on missing id returns ok: false", withRoot((t, root) => {
  const r = outbox.deleteEvent(root, "cortex-agent", "BR-EVT-p006-missing");
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("not found"));
}));

test("rate limit blocks writes beyond cap", withRoot((t, root) => {
  // Use a tiny cap so the test stays fast.
  const opts = {
    source_project_id: "cortex-agent",
    event_type: "task.state_changed",
    summary: {},
    bridge_event_id: "BR-EVT-p006-rl1",
    rate_limit_per_day: 1,
    propagated_at: "2026-08-12T00:00:00.000Z",
  };
  outbox.writeEvent(root, { ...opts, bridge_event_id: "BR-EVT-p006-rl1" });
  const second = outbox.writeEvent(root, { ...opts, bridge_event_id: "BR-EVT-p006-rl2" });
  assert.equal(second.ok, false);
  assert.ok(second.errors[0].includes("rate limit"));
}));

test("ensureOutboxDir is idempotent", withRoot((t, root) => {
  const a = outbox.ensureOutboxDir(root, "cortex-agent");
  const b = outbox.ensureOutboxDir(root, "cortex-agent");
  assert.equal(a, b);
  assert.ok(fs.existsSync(b));
}));

test("BR-EVT-mkEvent helper validates the schema path for all four event types", withRoot((t, root) => {
  const types = ["task.state_changed", "decision.resolved", "checkpoint.closed", "waitpoint.released"];
  for (const ev of types) {
    const result = outbox.writeEvent(root, {
      source_project_id: "cortex-agent",
      event_type: ev,
      summary: { task_id: "T-1" },
      bridge_event_id: `BR-EVT-p006-${ev.split(".")[0]}`,
      propagated_at: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(result.ok, true, `writeEvent failed for ${ev}: ${JSON.stringify(result.errors)}`);
  }
}));
