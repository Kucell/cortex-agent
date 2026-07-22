"use strict";

// End-to-end coverage for the subagent-trace Phase 2 receiver CLI.
// Verifies the 3 subcommands (emit / list / tree) + double-write to
// runs/<id>.json#subagent_fanout[] AND runs/<id>.json#events[].

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, "templates", "_shared", ".agent", "skills", "subagent-trace", "scripts", "index.js");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-st-"));
  fs.mkdirSync(path.join(cwd, ".agent", "runs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "inbox"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".agent", "runs", "R-st-001.json"),
    JSON.stringify({ run_id: "R-st-001", status: "running", events: [] }),
    "utf8",
  );
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [SKILL, ...args], { cwd, encoding: "utf8" });
}

function readRun(cwd, runId) {
  if (runId === undefined) runId = "R-st-001";
  return JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "runs", `${runId}.json`), "utf8"));
}

function rmInbox(cwd) {
  const dir = path.join(cwd, ".agent", "inbox");
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith("IM-")) fs.unlinkSync(path.join(dir, f));
  }
}

test("emit subagent_spawned appends to events[] and creates subagent_fanout[]", () => {
  const cwd = fixture();
  const r = run(cwd, [
    "emit", "--event", "subagent_spawned",
    "--subagent-id", "sub-A",
    "--subagent-role", "explore",
    "--task-description", "scan L1",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  const lastEv = runBody.events[runBody.events.length - 1];
  assert.equal(lastEv.type, "subagent_spawned");
  assert.equal(lastEv.subagent_id, "sub-A");
  assert.equal(lastEv.subagent_role, "explore");
  assert.equal(runBody.subagent_fanout.length, 1);
  const entry = runBody.subagent_fanout[0];
  assert.equal(entry.subagent_id, "sub-A");
  assert.equal(entry.role, "explore");
  assert.equal(entry.status, "running");
  assert.equal(entry.events.length, 1);
});

test("emit subagent_progress updates the existing fanout entry", () => {
  const cwd = fixture();
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-B", "--subagent-role", "plan", "--gate", "agent"]);
  const r = run(cwd, [
    "emit", "--event", "subagent_progress",
    "--subagent-id", "sub-B",
    "--percent", "60",
    "--current-step", "scanning",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  const entry = runBody.subagent_fanout[0];
  assert.ok(Array.isArray(entry.progress));
  assert.equal(entry.progress.length, 1);
  assert.equal(entry.progress[0].percent, 60);
  const lastEv = runBody.events[runBody.events.length - 1];
  assert.equal(lastEv.type, "subagent_progress");
});

test("emit subagent_completed sets final_status", () => {
  const cwd = fixture();
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-C", "--subagent-role", "explore", "--gate", "agent"]);
  const r = run(cwd, [
    "emit", "--event", "subagent_completed",
    "--subagent-id", "sub-C", "--status", "success",
    "--output-summary", "5 deps",
    "--duration-actual-seconds", "30",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  const entry = runBody.subagent_fanout[0];
  assert.equal(entry.final_status, "success");
  assert.equal(entry.status, "running");
});

test("emit subagent_cancelled captures reason", () => {
  const cwd = fixture();
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-D", "--subagent-role", "plan", "--gate", "agent"]);
  const r = run(cwd, [
    "emit", "--event", "subagent_cancelled",
    "--subagent-id", "sub-D", "--reason", "user stopped",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  assert.equal(runBody.subagent_fanout[0].cancellation_reason, "user stopped");
});

test("emit completed failed + --notify-on-fail writes inbox to parent_run", () => {
  const cwd = fixture();
  rmInbox(cwd);
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-E", "--subagent-role", "test-runner", "--gate", "agent"]);
  const r = run(cwd, [
    "emit", "--event", "subagent_completed",
    "--subagent-id", "sub-E", "--status", "failed",
    "--output-summary", "sandbox denied bash",
    "--notify-on-fail", "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.ok(body.inbox_notified);
  assert.ok(fs.existsSync(body.inbox_notified));
  const inbox = JSON.parse(fs.readFileSync(body.inbox_notified, "utf8"));
  assert.equal(inbox.type, "alert");
  assert.equal(inbox.subject, "subagent sub-E failed");
});

test("emit completed success without --notify-on-fail does NOT write inbox", () => {
  const cwd = fixture();
  rmInbox(cwd);
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-F", "--subagent-role", "explore", "--gate", "agent"]);
  const r = run(cwd, [
    "emit", "--event", "subagent_completed",
    "--subagent-id", "sub-F", "--status", "success",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0);
  const inboxFiles = fs.readdirSync(path.join(cwd, ".agent", "inbox"));
  assert.equal(inboxFiles.filter((f) => f.startsWith("IM-")).length, 0);
});

test("list returns all fanout sub-agents for the run", () => {
  const cwd = fixture();
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-X", "--subagent-role", "explore", "--gate", "agent"]);
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-Y", "--subagent-role", "plan", "--gate", "agent"]);
  const r = run(cwd, ["list"]);
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.count, 2);
  assert.equal(body.subagents[0].subagent_id, "sub-X");
  assert.equal(body.subagents[1].subagent_id, "sub-Y");
});

test("tree renders parent + 2 children as 2-level tree", () => {
  const cwd = fixture();
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-A1", "--subagent-role", "explore", "--gate", "agent"]);
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-A2", "--subagent-role", "plan", "--gate", "agent"]);
  const r = run(cwd, ["tree"]);
  const body = JSON.parse(r.stdout);
  assert.equal(body.tree.run_id, "R-st-001");
  assert.equal(body.tree.children.length, 2);
  assert.equal(body.tree.children[0].subagent_id, "sub-A1");
  assert.deepEqual(body.tree.children[0].children, []);
});

test("emit without --gate fails with workflow_gate_required", () => {
  const cwd = fixture();
  const r = run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "x", "--subagent-role", "y"]);
  assert.equal(JSON.parse(r.stdout).error, "workflow_gate_required");
});

test("emit with unknown event fails with unknown_event", () => {
  const cwd = fixture();
  const r = run(cwd, ["emit", "--event", "subagent_danced", "--subagent-id", "x", "--gate", "agent"]);
  assert.equal(JSON.parse(r.stdout).error, "unknown_event");
});

test("emit completed without --status fails with missing_status", () => {
  const cwd = fixture();
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "x", "--subagent-role", "y", "--gate", "agent"]);
  const r = run(cwd, ["emit", "--event", "subagent_completed", "--subagent-id", "x", "--gate", "agent"]);
  assert.equal(JSON.parse(r.stdout).error, "missing_status");
});

test("unknown subcommand fails with unknown_command", () => {
  const cwd = fixture();
  const r = run(cwd, ["definitely-not-a-real-subcommand"]);
  assert.equal(JSON.parse(r.stdout).error, "unknown_command");
});

test("full fan-out sequence is reconstructable via tree", () => {
  const cwd = fixture();
  run(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-1", "--subagent-role", "explore", "--task-description", "find L1 deps", "--gate", "agent"]);
  run(cwd, ["emit", "--event", "subagent_progress", "--subagent-id", "sub-1", "--percent", "30", "--current-step", "scanning", "--gate", "agent"]);
  run(cwd, ["emit", "--event", "subagent_progress", "--subagent-id", "sub-1", "--percent", "80", "--current-step", "writing report", "--gate", "agent"]);
  run(cwd, ["emit", "--event", "subagent_completed", "--subagent-id", "sub-1", "--status", "success", "--output-summary", "found 5 deps", "--duration-actual-seconds", "120", "--gate", "agent"]);
  const r = run(cwd, ["tree"]);
  const body = JSON.parse(r.stdout);
  const sub = body.tree.children[0];
  assert.equal(sub.subagent_id, "sub-1");
  assert.equal(sub.status, "success");
  const runBody = readRun(cwd);
  const entry = runBody.subagent_fanout[0];
  assert.equal(entry.progress.length, 2);
  assert.equal(entry.events.length, 4);
});
