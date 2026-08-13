"use strict";

// ─── VC-012 — Nudge is default-disabled, read-only and never blocks ──────────

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildNudge, formatNudgeLine } = require("../../lib/feedback/nudge");
const { appendEvent, inboxRootFor } = require("../../lib/feedback/inbox");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-feedback-nudge-"));
}

test("VC-012 formatNudgeLine returns null when there are no events", () => {
  assert.equal(formatNudgeLine({ summary: { event_count: 0, by_severity: {}, diagnostics: { incomplete: 0, corrupt: 0 } } }), null);
});

test("VC-012 formatNudgeLine produces a single human-readable line with by-severity list", () => {
  const line = formatNudgeLine({
    summary: { event_count: 2, by_severity: { high: 1, low: 1 }, diagnostics: { incomplete: 0, corrupt: 0 } },
    since: "7d",
    maxEntries: 3,
  });
  assert.ok(typeof line === "string");
  assert.match(line, /2 events in local inbox/);
  assert.match(line, /by severity: 1 high, 1 low/);
});

test("VC-012 nudge is silent when no config exists", () => {
  const root = mkRoot();
  try {
    const r = buildNudge({ root, env: {}, stdout: "" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.lines.length, 0);
    assert.equal(r.reason, "nudge-disabled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-012 nudge is silent when nudge.enabled is false", () => {
  const root = mkRoot();
  try {
    fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "config", "feedback.json"), JSON.stringify({ enabled: true, nudge: { enabled: false } }), "utf8");
    const r = buildNudge({ root, env: {}, stdout: "" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.lines.length, 0);
    assert.equal(r.reason, "nudge-disabled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-012 nudge is silent even with events when nudge is disabled", () => {
  const root = mkRoot();
  try {
    fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "config", "feedback.json"), JSON.stringify({ enabled: true, nudge: { enabled: false } }), "utf8");
    const inboxRoot = inboxRootFor(root);
    appendEvent({ inboxRoot, event: { schema_version: 1, event_id: "fev_00000000-0000-4000-8000-000000000000", occurred_at: new Date().toISOString(), kind: "blocker", severity: "high", title: "preexisting event", source: { adapter: "manual", project_slug: "cortex-agent" } } });
    const r = buildNudge({ root, env: {}, stdout: "" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.lines.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-012 nudge emits lines but never writes events", () => {
  const root = mkRoot();
  try {
    fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "config", "feedback.json"), JSON.stringify({ enabled: true, nudge: { enabled: true, since: "30d", max_entries: 3 } }), "utf8");
    const inboxRoot = inboxRootFor(root);
    appendEvent({ inboxRoot, event: { schema_version: 1, event_id: "fev_00000000-0000-4000-8000-000000000001", occurred_at: new Date().toISOString(), kind: "blocker", severity: "high", title: "preexisting event", source: { adapter: "manual", project_slug: "cortex-agent" } } });
    const before = walk(inboxRoot).length;
    const r = buildNudge({ root, env: {}, stdout: "" });
    assert.equal(r.exitCode, 0);
    assert.ok(r.lines.length > 0);
    const after = walk(inboxRoot).length;
    assert.equal(before, after, "nudge must not create new event files");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-012 config error produces a soft warning but exitCode stays 0", () => {
  const root = mkRoot();
  try {
    fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
    // unknown top-level field — triggers ConfigError.
    fs.writeFileSync(path.join(root, ".agent", "config", "feedback.json"), JSON.stringify({ unknown_top_key: 1 }), "utf8");
    const r = buildNudge({ root, env: {}, stdout: "" });
    assert.equal(r.exitCode, 0);
    assert.ok(r.lines.some((l) => /skipped/.test(l)));
    assert.equal(r.reason, "config-error");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-012 nudge tolerates a missing project (no .agent/) and returns 0", () => {
  const root = mkRoot();
  try {
    const r = buildNudge({ root, env: {}, stdout: "" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.lines.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}