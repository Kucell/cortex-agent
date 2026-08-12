"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../../lib/commands/bridge");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-p006-bridge-cli-"));
}

function run(args, cwd) {
  // bridgeCommand mutates process.exitCode on invalid usage / runtime errors.
  // Reset it on entry so each call's verdict does not bleed into the next or
  // into node:test's pass/fail aggregation.
  process.exitCode = 0;
  // Use the same entrypoint pattern as bin/cli.js: bridgeCommand receives
  // ctx.args starting at the command ("bridge") so that ctx.args.slice(1)
  // inside bridgeCommand yields the subcommand list. Always append --json so
  // tests can parse the output as JSON without console.log interleaving.
  const ctx = {
    cwd,
    args: ["bridge", ...args, "--json"],
    options: {},
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...rest) => logs.push(rest.join(" "));
  try {
    cli.bridgeCommand(ctx);
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

test("bridge emit writes a valid event", () => {
  const root = mkRoot();
  const out = run([
    "emit",
    "--source", "cortex-agent",
    "--type", "task.state_changed",
    "--summary", JSON.stringify({ task_id: "M-017", state: "READY_FOR_REVIEW" }),
    "--group", "agentic-ui-delivery",
    "--id", "BR-EVT-p006-cli-001",
  ], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event_id, "BR-EVT-p006-cli-001");
  assert.ok(fs.existsSync(parsed.file));
});

test("bridge emit rejects invalid event_type", () => {
  const root = mkRoot();
  // invalid usage ends with exitCode=2; the JSON envelope reflects ok=false.
  const out = run([
    "emit", "--source", "cortex-agent", "--type", "made_up", "--summary", "{}"
  ], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.error.code === "INVALID_USAGE");
});

test("bridge outbox-list returns stored events", () => {
  const root = mkRoot();
  run([
    "emit",
    "--source", "cortex-agent",
    "--type", "decision.resolved",
    "--summary", JSON.stringify({ decision_id: "D-CLI" }),
    "--id", "BR-EVT-p006-cli-002",
  ], root);
  const out = run(["outbox-list", "--source", "cortex-agent"], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.events[0].bridge_event_id, "BR-EVT-p006-cli-002");
});

test("bridge outbox-prune deletes older events", () => {
  const root = mkRoot();
  run([
    "emit",
    "--source", "cortex-agent",
    "--type", "task.state_changed",
    "--summary", "{}",
    "--id", "BR-EVT-p006-old",
    "--propagated-at", "2025-01-01T00:00:00.000Z",
  ], root);
  run([
    "emit",
    "--source", "cortex-agent",
    "--type", "task.state_changed",
    "--summary", "{}",
    "--id", "BR-EVT-p006-new",
    "--propagated-at", "2030-01-01T00:00:00.000Z",
  ], root);
  const out = run(["outbox-prune", "--source", "cortex-agent", "--before", "2026-08-01T00:00:00.000Z"], root);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.removed, 1);
});

test("bridge help lists the new sub-commands", () => {
  const help = cli.usage();
  assert.ok(/emit/.test(help));
  assert.ok(/outbox-list/.test(help));
  assert.ok(/outbox-prune/.test(help));
});

test.after(() => {
  process.exitCode = 0;
});
