"use strict";

// ─── VC-009, VC-010, VC-011 — CLI: disabled safety, unknown args, status output ──

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const {
  runFeedback,
  runLog,
  runStatus,
  runIngestEvent,
  EXIT_OK,
  EXIT_ARGS,
  EXIT_IO,
  EXIT_DISABLED,
  EXIT_INSECURE,
  EXIT_USAGE,
} = require("../../lib/feedback/commands");
const { inboxRootFor } = require("../../lib/feedback/inbox");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-feedback-cli-"));
}

function withProject(fn) {
  return (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return fn(t, root);
  };
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: cwd },
  });
}

function withEnv(env, fn) {
  // Restore env after the test runs.
  const saved = { ...process.env };
  for (const k of Object.keys(env)) process.env[k] = env[k];
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) process.env[k] = saved[k];
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

function baseFlags(extra = []) {
  return [
    "--title", "test event",
    "--kind", "blocker",
    "--severity", "high",
    "--project-slug", "cortex-agent",
    ...extra,
  ];
}

test("VC-009 disabled (no config) — feedback log writes zero events", withProject((t, root) => {
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runLog(baseFlags(), env);
  assert.equal(r.exitCode, EXIT_DISABLED);
  assert.equal(fs.existsSync(path.join(root, ".agent", "feedback", "inbox")), false);
}));

test("VC-009 disabled — feedback status still returns valid empty state", withProject((t, root) => {
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runStatus([], env);
  assert.equal(r.exitCode, EXIT_OK);
  assert.equal(r.payload.enabled, false);
  assert.equal(r.payload.rows.length, 0);
}));

test("VC-009 enabled — feedback log writes exactly one event and returns event_id", withProject((t, root) => {
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "config", "feedback.json"),
    JSON.stringify({ enabled: true }),
    "utf8",
  );
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runLog(baseFlags(), env);
  assert.equal(r.exitCode, EXIT_OK, JSON.stringify(r));
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.event_id.startsWith("fev_"));
  assert.ok(payload.fingerprint.startsWith("sha256:"));
  const inboxRoot = inboxRootFor(root);
  const files = walk(inboxRoot);
  assert.equal(files.length, 1);
}));

test("VC-010 unknown options including --token fail with a stable usage error", withProject((t, root) => {
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runLog(["--title", "x", "--kind", "blocker", "--severity", "high", "--project-slug", "cortex-agent", "--token", "leak"], env);
  assert.equal(r.exitCode, EXIT_ARGS);
  assert.match(r.stderr, /unknown option/);
  // No event written.
  assert.equal(fs.existsSync(path.join(root, ".agent", "feedback")), false);
}));

test("VC-010 missing required options fail with EXIT_ARGS", withProject((t, root) => {
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runLog(["--title", "x"], env);
  assert.equal(r.exitCode, EXIT_ARGS);
  assert.match(r.stderr, /--kind/);
}));

test("VC-010 ingest-event refuses unknown adapter", withProject((t, root) => {
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "config", "feedback.json"),
    JSON.stringify({ enabled: true, adapters: { cortex_diagnostic: true } }),
    "utf8",
  );
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runIngestEvent([
    "--adapter", "unknown-adapter",
    "--event-json", JSON.stringify({ source: { adapter: "unknown-adapter", project_slug: "cortex-agent" } }),
  ], env);
  assert.equal(r.exitCode, EXIT_ARGS);
}));

test("VC-010 ingest-event refuses unknown payload fields (schema rejects)", withProject((t, root) => {
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "config", "feedback.json"),
    JSON.stringify({ enabled: true, adapters: { cortex_diagnostic: true } }),
    "utf8",
  );
  const eventJson = JSON.stringify({
    schema_version: 1,
    event_id: "fev_00000000-0000-4000-8000-000000000000",
    occurred_at: "2026-08-12T09:00:00.000Z",
    kind: "blocker",
    severity: "high",
    title: "ok",
    source: { adapter: "cortex-diagnostic", project_slug: "cortex-agent" },
    prompt: "should never be accepted",
  });
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runIngestEvent(["--adapter", "cortex-diagnostic", "--event-json", eventJson], env);
  assert.equal(r.exitCode, EXIT_ARGS);
  assert.match(r.stderr, /prompt|forbidden/);
}));

test("VC-010 runFeedback routes unknown subcommands to EXIT_USAGE", withProject((t, root) => {
  const r = runFeedback(["bogus"]);
  assert.equal(r.exitCode, EXIT_USAGE);
  assert.match(r.stderr, /unknown subcommand/);
}));

test("VC-011 status distinguishes valid empty, corrupt and I/O failure", withProject((t, root) => {
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  // Empty case.
  const empty = runStatus([], env);
  assert.equal(empty.exitCode, EXIT_OK);
  assert.equal(empty.payload.rows.length, 0);
  // Write a corrupt event under the inbox.
  const inboxRoot = inboxRootFor(root);
  const dayDir = path.join(inboxRoot, "2026-08-12");
  const evDir = path.join(dayDir, "fev_00000000-0000-4000-8000-000000000000");
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, "event.json"), "{not json", "utf8");
  const corrupt = runStatus([], env);
  assert.equal(corrupt.exitCode, EXIT_OK);
  assert.equal(corrupt.payload.diagnostics.corrupt, 1);
}));

test("VC-011 status --json produces parseable JSON", withProject((t, root) => {
  const env = { ...process.env, CORTEX_AGENT_FEEDBACK_PROJECT_ROOT: root };
  const r = runStatus(["--json"], env);
  assert.equal(r.exitCode, EXIT_OK);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.enabled, "boolean");
}));

test("VC-009 end-to-end via bin/cli.js (disabled → exit code 5)", withProject((t, root) => {
  const r = runCli(root, ["feedback", "log", ...baseFlags()]);
  assert.notEqual(r.status, 0, `unexpected zero exit; stderr=${r.stderr}`);
  // EXIT_DISABLED = 5
  assert.equal(r.status, EXIT_DISABLED);
}));

test("VC-009 end-to-end via bin/cli.js (enabled → writes one event)", withProject((t, root) => {
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "config", "feedback.json"),
    JSON.stringify({ enabled: true }),
    "utf8",
  );
  const r = runCli(root, ["feedback", "log", ...baseFlags()]);
  assert.equal(r.status, EXIT_OK, `stderr=${r.stderr}\nstdout=${r.stdout}`);
  const files = walk(inboxRootFor(root));
  assert.equal(files.length, 1);
}));

test("VC-010 end-to-end via bin/cli.js (unknown flag → exit 3)", withProject((t, root) => {
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "config", "feedback.json"),
    JSON.stringify({ enabled: true }),
    "utf8",
  );
  const r = runCli(root, ["feedback", "log", ...baseFlags(), "--token", "leak"]);
  assert.equal(r.status, EXIT_ARGS);
}));

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