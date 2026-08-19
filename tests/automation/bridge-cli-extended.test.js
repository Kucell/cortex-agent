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

test("bridge sync --auto resolves host_root from topology registry", () => {
  const target = mkRoot();
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-p006-bridge-cli-src-"));
  // Write topology: target has a self entry + one peer pointing at source root
  fs.mkdirSync(path.join(target, ".agent", "topology"), { recursive: true });
  fs.writeFileSync(path.join(target, ".agent", "topology", "projects.json"), `${JSON.stringify({
    schema_version: 1,
    self: { project_id: "cortex-agent", host_root: target, declared_at: "2026-08-12T00:00:00.000Z" },
    peers: [
      { project_id: "hmi-platform", host_root: source, role: "producer", registered_at: "2026-08-12T00:00:00.000Z" },
    ],
  }, null, 2)}\n`);
  // Subscribe to hmi-platform
  cli.bridgeCommand({ cwd: target, args: ["bridge", "subscribe", "--source", "hmi-platform", "--types", "task.state_changed", "--json"], options: {} });
  // Seed an event into the source outbox
  // MS-003: cross-project outbox/inbox now lives under .agent/runtime/cross-project/
  // (new layout per VC-012). The legacy .agent-runtime/cross-project/ path is
  // only used during the compat window when the legacy dir exists and the
  // project has not activated the new layout.
  fs.mkdirSync(path.join(source, ".agent", "runtime", "cross-project", "outbox", "hmi-platform"), { recursive: true });
  fs.writeFileSync(path.join(source, ".agent", "runtime", "cross-project", "outbox", "hmi-platform", "BR-EVT-p006-auto.json"), JSON.stringify({
    bridge_event_id: "BR-EVT-p006-auto",
    source_project_id: "hmi-platform",
    source_task_id: "T-001",
    event_type: "task.state_changed",
    summary: { to_state: "READY_FOR_REVIEW" },
    correlation_group: "agentic-ui-delivery",
    propagated_at: "2026-08-12T02:00:00.000Z",
  }));

  const out = run(["sync", "--auto"], target);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, "auto");
  assert.equal(parsed.total, 1);
  assert.equal(parsed.reachable, 1);
  const inboxFile = path.join(target, ".agent", "runtime", "cross-project", "inbox", "hmi-platform", "BR-EVT-p006-auto.json");
  assert.ok(fs.existsSync(inboxFile), "inbox file should be written via --auto");
});

test.after(() => {
  process.exitCode = 0;
});
