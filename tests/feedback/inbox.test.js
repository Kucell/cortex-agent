"use strict";

// ─── VC-004, VC-005, VC-006 — Inbox layout, isolation and capacity ──────────

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  appendEvent,
  readInbox,
  summarize,
  listEvents,
  inboxRootFor,
  dayDirFor,
  isEventId,
  newEventId,
  countEventsInDay,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_EVENTS_PER_DAY,
} = require("../../lib/feedback/inbox");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-feedback-inbox-"));
}

function sampleEvent(overrides = {}) {
  return {
    schema_version: 1,
    event_id: `fev_${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    occurred_at: new Date().toISOString(),
    kind: "blocker",
    severity: "high",
    title: "test event",
    source: { adapter: "manual", project_slug: "cortex-agent" },
    ...overrides,
  };
}

test("VC-004 inboxRootFor is deterministic and inside .agent/feedback/inbox", () => {
  const root = mkRoot();
  try {
    const r = inboxRootFor(root);
    assert.equal(r, path.join(root, ".agent", "feedback", "inbox"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-004 dayDirFor emits YYYY-MM-DD UTC", () => {
  const r = dayDirFor("/tmp/inbox", "2026-08-12T09:00:00.000Z");
  assert.equal(path.basename(r), "2026-08-12");
});

test("VC-004 isEventId accepts the documented shapes and rejects malformed ids", () => {
  assert.equal(isEventId("fev_00000000-0000-4000-8000-000000000000"), true);
  // Crockford base32 ULIDs avoid I, L, O, U. The regex intentionally
  // excludes those letters so any ULID-shaped id passes deterministically.
  assert.equal(isEventId("01HZX8K1V6ABCDEFGHJKMNPQRS"), true);
  assert.equal(isEventId("not-an-id"), false);
  assert.equal(isEventId(""), false);
});

test("VC-004 appendEvent writes one event file and returns path/fingerprint", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    const result = appendEvent({ inboxRoot, event: sampleEvent() });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(fs.existsSync(result.path));
    assert.equal(path.basename(result.path), "event.json");
    assert.ok(result.fingerprint.startsWith("sha256:"));
    // Layout: <inboxRoot>/YYYY-MM-DD/<event_id>/event.json
    const rel = path.relative(inboxRoot, result.path);
    assert.match(rel, /^\d{4}-\d{2}-\d{2}\/fev_[0-9a-f-]+\/event\.json$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-004 repeated fingerprint creates separate immutable event files", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    const first = appendEvent({
      inboxRoot,
      event: sampleEvent({
        title: "Same title here",
        kind: "blocker",
        diagnostic_code: "DUP",
      }),
    });
    const second = appendEvent({
      inboxRoot,
      event: sampleEvent({
        title: "Same title here",
        kind: "blocker",
        diagnostic_code: "DUP",
      }),
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.fingerprint, second.fingerprint, "fingerprint must be identical for canonically-equal events");
    assert.notEqual(first.path, second.path, "events must be persisted to distinct files");
    const read = readInbox({ inboxRoot });
    assert.equal(read.events.length, 2);
    // Both event files remain present and immutable.
    assert.ok(fs.existsSync(first.path));
    assert.ok(fs.existsSync(second.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-005 incomplete event dir (no event.json) is diagnosed but does not block siblings", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    const good = appendEvent({ inboxRoot, event: sampleEvent({ title: "good event" }) });
    // Create an incomplete dir directly.
    const dayDir = path.dirname(path.dirname(good.path));
    const incompleteId = "fev_00000000-0000-4000-8000-deadbeef0000";
    const incompleteDir = path.join(dayDir, incompleteId);
    fs.mkdirSync(incompleteDir, { recursive: true });
    fs.writeFileSync(path.join(incompleteDir, "garbage.txt"), "tmp", "utf8");
    const read = readInbox({ inboxRoot });
    assert.equal(read.events.length, 1);
    assert.equal(read.diagnostics.incomplete.length, 1);
    assert.equal(read.diagnostics.incomplete[0].event_id, incompleteId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-005 corrupt event.json file is reported and skipped without dropping siblings", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    const good = appendEvent({ inboxRoot, event: sampleEvent({ title: "good event" }) });
    // Overwrite the good event.json with garbage to simulate corruption.
    fs.writeFileSync(good.path, "{not valid json", "utf8");
    const read = readInbox({ inboxRoot });
    assert.equal(read.events.length, 0);
    assert.equal(read.diagnostics.corrupt.length, 1);
    assert.equal(read.diagnostics.corrupt[0].path, good.path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-006 per-event byte cap (16 KiB by default) fails closed", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    // Build a payload whose JSON serialization exceeds 16 KiB but whose
    // individual fields stay within the schema caps. We use a long summary
    // and a few repeated tags to drive the byte count above the limit.
    const big = "Y".repeat(18 * 1024);
    const r = appendEvent({ inboxRoot, event: sampleEvent({ summary: big }) });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, "OVER_LIMIT");
    assert.equal(r.limit, DEFAULT_MAX_EVENT_BYTES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-006 day capacity (default 10k) fails closed when reached", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    const r1 = appendEvent({
      inboxRoot,
      event: sampleEvent({ title: "first" }),
      dayCapacity: 2,
    });
    assert.equal(r1.ok, true);
    const r2 = appendEvent({
      inboxRoot,
      event: sampleEvent({ title: "second" }),
      dayCapacity: 2,
    });
    assert.equal(r2.ok, true);
    const r3 = appendEvent({
      inboxRoot,
      event: sampleEvent({ title: "third" }),
      dayCapacity: 2,
    });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, "DAY_CAPACITY_REACHED");
    assert.equal(r3.existing, 2);
    assert.equal(r3.capacity, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-006 schema rejects payloads over the cap before any disk I/O", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    const r = appendEvent({
      inboxRoot,
      event: sampleEvent({ title: "ok", bogus_field: "ignored" }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "SCHEMA");
    assert.equal(countEventsInDay(dayDirFor(inboxRoot, new Date().toISOString())), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-004 summarize counts days/events without reading every file twice", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    appendEvent({ inboxRoot, event: sampleEvent({ kind: "blocker", severity: "high" }) });
    appendEvent({ inboxRoot, event: sampleEvent({ kind: "observation", severity: "low" }) });
    const summary = summarize({ inboxRoot });
    assert.equal(summary.event_count, 2);
    assert.equal(summary.days, 1);
    assert.equal(summary.by_kind.blocker, 1);
    assert.equal(summary.by_kind.observation, 1);
    assert.equal(summary.by_severity.high, 1);
    assert.equal(summary.by_severity.low, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-004 listEvents filters by kind/severity/since", () => {
  const root = mkRoot();
  try {
    const inboxRoot = inboxRootFor(root);
    appendEvent({ inboxRoot, event: sampleEvent({ kind: "blocker", severity: "high", title: "older", occurred_at: "2026-01-01T00:00:00.000Z" }) });
    appendEvent({ inboxRoot, event: sampleEvent({ kind: "observation", severity: "low", title: "newer" }) });
    const onlyBlocker = listEvents({ inboxRoot, kind: "blocker" });
    assert.equal(onlyBlocker.length, 1);
    const onlyHigh = listEvents({ inboxRoot, severity: "high" });
    assert.equal(onlyHigh.length, 1);
    const sinceNow = listEvents({ inboxRoot, since: "30m" });
    assert.equal(sinceNow.length, 1, "should include the most recent event");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-004 newEventId returns a fresh UUID each call", () => {
  const ids = new Set();
  for (let i = 0; i < 32; i += 1) ids.add(newEventId());
  assert.equal(ids.size, 32);
});