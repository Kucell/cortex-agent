"use strict";

// ─── M-004 MS-002 VC-006: subagent-trace bridge + BC tests ───────────────────
//
// Coverage:
//   1. BC — 旧 subagent-trace emit 仍可用 (event-bus 不收)
//   2. Bridge — 新 bridge.spawn/progress/complete/cancel 自动 emit + 双写
//   3. 失败自动 inbox (status=failed + notify-on-fail default true)
//   4. 进度节流 (≥ 10% 间隔)
//
// Total: 18 cases (target 15-20)
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-006
//   - docs/architecture/framework-event-bus-design.md §6
//   - .agent/missions/M-004/handoffs/20260805-215200-ms-002-spec-done.md

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(ROOT, "lib", "event-bus", "subagent-trace-bridge");
const LEGACY = path.join(
  ROOT,
  "templates",
  "_shared",
  ".agent",
  "skills",
  "subagent-trace",
  "scripts",
  "index.js",
);

const { createEventBus } = require(path.join(ROOT, "lib", "event-bus", "event-bus"));

let _counter = 0;

function freshFixture() {
  _counter++;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vc-006-" + process.pid + "-" + _counter + "-"));
  fs.mkdirSync(path.join(cwd, ".agent", "runs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "inbox"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".agent", "runs", "R-vc006.json"),
    JSON.stringify({ run_id: "R-vc006", status: "running", events: [] }),
    "utf8",
  );
  return cwd;
}

function freshBusDir() {
  const d = path.join(os.tmpdir(), "vc-006-bus-" + process.pid + "-" + (++_counter));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readRun(cwd, runId = "R-vc006") {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "runs", `${runId}.json`), "utf8"));
}

function listInbox(cwd) {
  const dir = path.join(cwd, ".agent", "inbox");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("IM-"));
}

function rmInbox(cwd) {
  for (const f of listInbox(cwd)) {
    try { fs.unlinkSync(path.join(cwd, ".agent", "inbox", f)); } catch (_) {}
  }
}

function runLegacy(cwd, args) {
  return spawnSync(process.execPath, [LEGACY, ...args], { cwd, encoding: "utf8" });
}

// ─── 1. BC — 旧 subagent-trace emit 仍可用 (event-bus 不收) ────────────────

test("VC-006 BC1: legacy emit subagent_spawned still works (writes fanout)", () => {
  const cwd = freshFixture();
  const r = runLegacy(cwd, [
    "emit", "--event", "subagent_spawned",
    "--subagent-id", "sub-bc-1",
    "--subagent-role", "explore",
    "--task-description", "BC verify",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  assert.equal(runBody.subagent_fanout.length, 1);
  assert.equal(runBody.subagent_fanout[0].subagent_id, "sub-bc-1");
  assert.equal(runBody.subagent_fanout[0].role, "explore");
});

test("VC-006 BC2: legacy emit subagent_completed still works (writes fanout)", () => {
  const cwd = freshFixture();
  runLegacy(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-bc-2", "--subagent-role", "explore", "--gate", "agent"]);
  const r = runLegacy(cwd, [
    "emit", "--event", "subagent_completed",
    "--subagent-id", "sub-bc-2", "--status", "success",
    "--output-summary", "done",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  assert.equal(runBody.subagent_fanout[0].final_status, "success");
});

test("VC-006 BC3: legacy emit subagent_progress still works (writes fanout progress)", () => {
  const cwd = freshFixture();
  runLegacy(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-bc-3", "--subagent-role", "plan", "--gate", "agent"]);
  const r = runLegacy(cwd, [
    "emit", "--event", "subagent_progress",
    "--subagent-id", "sub-bc-3", "--percent", "75",
    "--current-step", "scanning",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  assert.equal(runBody.subagent_fanout[0].progress.length, 1);
  assert.equal(runBody.subagent_fanout[0].progress[0].percent, 75);
});

test("VC-006 BC4: legacy emit subagent_cancelled still works (writes fanout reason)", () => {
  const cwd = freshFixture();
  runLegacy(cwd, ["emit", "--event", "subagent_spawned", "--subagent-id", "sub-bc-4", "--subagent-role", "plan", "--gate", "agent"]);
  const r = runLegacy(cwd, [
    "emit", "--event", "subagent_cancelled",
    "--subagent-id", "sub-bc-4", "--reason", "user stopped",
    "--gate", "agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const runBody = readRun(cwd);
  assert.equal(runBody.subagent_fanout[0].cancellation_reason, "user stopped");
});

test("VC-006 BC5: legacy emit does NOT publish to event-bus (event-bus 不收)", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  const bus = createEventBus({ busId: "vc006-bc:test", dataDir: busDir, fsync: false });

  // Emit via legacy path (no bridge, no event-bus)
  runLegacy(cwd, [
    "emit", "--event", "subagent_spawned",
    "--subagent-id", "sub-bc-5",
    "--subagent-role", "explore",
    "--task-description", "BC check event-bus",
    "--gate", "agent",
  ]);

  // event-bus should be empty
  const result = bus.list({});
  assert.equal(result.events.length, 0);
  bus.close();
});

// ─── 2. Bridge — spawn/progress/complete/cancel 自动 emit + 双写 ────────────

test("VC-006 B1: bridge.spawn auto-emits eb:subagent_spawned + writes fanout", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  // Reset throttle for this subagent
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);

  const result = bridge.spawn({
    parent_run_id: "R-vc006",
    subagent_id: "sub-b-1",
    role: "explore",
    task_description: "bridge test",
    dataDir: busDir,
    busId: "vc006-b1:test",
  });
  assert.equal(result.ok, true);
  assert.ok(result.event_id);
  assert.ok(result.event_id.startsWith("eb-evt-"));
  assert.equal(result.legacy.ok, true);

  // event-bus side: should have subagent_spawned
  const bus = createEventBus({ busId: "vc006-b1:test", dataDir: busDir, fsync: false });
  const listed = bus.list({ event_name: "subagent_spawned" });
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].event_name, "subagent_spawned");
  assert.equal(listed.events[0].payload.subagent_role, "explore");
  bus.close();

  // subagent_fanout[] side: should have entry
  const runBody = readRun(cwd);
  const entry = runBody.subagent_fanout.find((e) => e.subagent_id === "sub-b-1");
  assert.ok(entry, "subagent_fanout entry must exist");
  assert.equal(entry.role, "explore");
  assert.equal(entry.status, "running");
});

test("VC-006 B2: bridge.progress emits eb:subagent_progress + updates fanout progress", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-2", role: "explore", task_description: "p",
    dataDir: busDir, busId: "vc006-b2:test",
  });
  // First progress (50%) — should pass the throttle (0% → 50%)
  const r = bridge.progress({
    parent_run_id: "R-vc006", subagent_id: "sub-b-2", percent: 50,
    current_step: "scanning", dataDir: busDir, busId: "vc006-b2:test",
  });
  assert.equal(r.emitted, true);
  assert.ok(r.event_id);

  const bus = createEventBus({ busId: "vc006-b2:test", dataDir: busDir, fsync: false });
  const listed = bus.list({ event_name: "subagent_progress" });
  assert.ok(listed.events.length >= 1);
  bus.close();

  const runBody = readRun(cwd);
  const entry = runBody.subagent_fanout.find((e) => e.subagent_id === "sub-b-2");
  assert.ok(entry.progress && entry.progress.length >= 1);
  assert.equal(entry.progress[0].percent, 50);
});

test("VC-006 B3: bridge.complete with status=success auto-emits eb:subagent_completed", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-3", role: "explore", task_description: "c",
    dataDir: busDir, busId: "vc006-b3:test",
  });
  const r = bridge.complete({
    parent_run_id: "R-vc006", subagent_id: "sub-b-3", status: "success",
    output_summary: "all done",
    duration_actual_seconds: 12.5,
    dataDir: busDir, busId: "vc006-b3:test",
  });
  assert.equal(r.event_name, "subagent_completed");
  assert.ok(r.event_id);
  assert.equal(r.legacy.ok, true);

  const bus = createEventBus({ busId: "vc006-b3:test", dataDir: busDir, fsync: false });
  const completed = bus.list({ event_name: "subagent_completed" });
  assert.equal(completed.events.length, 1);
  assert.equal(completed.events[0].payload.status, "success");
  assert.equal(completed.events[0].payload.output_summary, "all done");
  bus.close();

  const runBody = readRun(cwd);
  const entry = runBody.subagent_fanout.find((e) => e.subagent_id === "sub-b-3");
  assert.equal(entry.final_status, "success");
});

test("VC-006 B4: bridge.complete with status=partial auto-emits eb:subagent_completed", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-4", role: "plan", task_description: "p",
    dataDir: busDir, busId: "vc006-b4:test",
  });
  const r = bridge.complete({
    parent_run_id: "R-vc006", subagent_id: "sub-b-4", status: "partial",
    output_summary: "partial done", dataDir: busDir, busId: "vc006-b4:test",
  });
  assert.equal(r.event_name, "subagent_completed");
  const bus = createEventBus({ busId: "vc006-b4:test", dataDir: busDir, fsync: false });
  const completed = bus.list({ event_name: "subagent_completed" });
  assert.equal(completed.events.length, 1);
  assert.equal(completed.events[0].payload.status, "partial");
  bus.close();
});

test("VC-006 B5: bridge.complete with status=failed auto-emits eb:subagent_failed", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-5", role: "test-runner", task_description: "t",
    dataDir: busDir, busId: "vc006-b5:test",
  });
  const r = bridge.complete({
    parent_run_id: "R-vc006", subagent_id: "sub-b-5", status: "failed",
    error_code: "ERR_TEST",
    error_message: "sandbox denied bash",
    output_summary: "test failed",
    dataDir: busDir, busId: "vc006-b5:test",
  });
  assert.equal(r.event_name, "subagent_failed");
  const bus = createEventBus({ busId: "vc006-b5:test", dataDir: busDir, fsync: false });
  const failed = bus.list({ event_name: "subagent_failed" });
  assert.equal(failed.events.length, 1);
  assert.equal(failed.events[0].payload.status, "failed");
  assert.equal(failed.events[0].payload.error_code, "ERR_TEST");
  bus.close();
});

test("VC-006 B6: bridge.cancel auto-emits eb:subagent_cancelled + writes reason", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-6", role: "plan", task_description: "x",
    dataDir: busDir, busId: "vc006-b6:test",
  });
  const r = bridge.cancel({
    parent_run_id: "R-vc006", subagent_id: "sub-b-6", reason: "user stopped",
    cancelled_by: "user",
    dataDir: busDir, busId: "vc006-b6:test",
  });
  assert.equal(r.ok, true);
  assert.ok(r.event_id);
  const bus = createEventBus({ busId: "vc006-b6:test", dataDir: busDir, fsync: false });
  const cancelled = bus.list({ event_name: "subagent_cancelled" });
  assert.equal(cancelled.events.length, 1);
  assert.equal(cancelled.events[0].payload.reason, "user stopped");
  assert.equal(cancelled.events[0].payload.cancelled_by, "user");
  bus.close();
  const runBody = readRun(cwd);
  const entry = runBody.subagent_fanout.find((e) => e.subagent_id === "sub-b-6");
  assert.equal(entry.cancellation_reason, "user stopped");
});

test("VC-006 B7: bridge.spawn/complete produce event-bus entries with correct correlation", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-7", role: "explore",
    task_description: "corr test", mission_id: "M-VC006", session_id: "S-1",
    dataDir: busDir, busId: "vc006-b7:test",
  });
  bridge.complete({
    parent_run_id: "R-vc006", subagent_id: "sub-b-7", status: "success",
    output_summary: "ok", mission_id: "M-VC006",
    dataDir: busDir, busId: "vc006-b7:test",
  });
  const bus = createEventBus({ busId: "vc006-b7:test", dataDir: busDir, fsync: false });
  const all = bus.list({});
  for (const ev of all.events) {
    assert.equal(ev.correlation.mission_id, "M-VC006");
    assert.equal(ev.correlation.subagent_id, "sub-b-7");
    assert.equal(ev.correlation.parent_run_id, "R-vc006");
  }
  bus.close();
});

test("VC-006 B8: bridge.complete with status=failed auto-inboxes parent (notify-on-fail default true)", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  rmInbox(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-8", role: "test-runner",
    task_description: "fail test", dataDir: busDir, busId: "vc006-b8:test",
  });
  // notify_on_fail not specified → default true
  bridge.complete({
    parent_run_id: "R-vc006", subagent_id: "sub-b-8", status: "failed",
    error_code: "X", error_message: "y",
    output_summary: "f",
    dataDir: busDir, busId: "vc006-b8:test",
  });
  const inbox = listInbox(cwd);
  assert.ok(inbox.length >= 1, "inbox should have at least one message after failed");
  const inboxFile = path.join(cwd, ".agent", "inbox", inbox[0]);
  const body = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
  assert.equal(body.type, "alert");
  assert.equal(body.subject, "subagent sub-b-8 failed");
});

test("VC-006 B9: bridge.complete with status=failed + notify_on_fail=false does NOT inbox", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  rmInbox(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-b-9", role: "test-runner",
    task_description: "fail test", dataDir: busDir, busId: "vc006-b9:test",
  });
  bridge.complete({
    parent_run_id: "R-vc006", subagent_id: "sub-b-9", status: "failed",
    error_code: "X", error_message: "y",
    output_summary: "f", notify_on_fail: false,
    dataDir: busDir, busId: "vc006-b9:test",
  });
  const inbox = listInbox(cwd);
  assert.equal(inbox.length, 0, "inbox should be empty when notify_on_fail=false");
});

// ─── 4. 进度节流 (≥ 10% 间隔) ──────────────────────────────────────────────

test("VC-006 T1: bridge.progress throttles: 5% after 50% is suppressed", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_id: "R-vc006", subagent_id: "sub-t-1", role: "explore",
    task_description: "throttle test", dataDir: busDir, busId: "vc006-t1:test",
  });
  // First progress 50% — should pass (0→50)
  const r1 = bridge.progress({
    parent_run_id: "R-vc006", subagent_id: "sub-t-1", percent: 50,
    dataDir: busDir, busId: "vc006-t1:test",
  });
  assert.equal(r1.emitted, true);
  // 55% — should be throttled (50→55 = 5 < 10)
  const r2 = bridge.progress({
    parent_run_id: "R-vc006", subagent_id: "sub-t-1", percent: 55,
    dataDir: busDir, busId: "vc006-t1:test",
  });
  assert.equal(r2.emitted, false);
  assert.match(r2.reason, /throttled/);
  // 59% — still throttled (50→59 = 9 < 10)
  const r3 = bridge.progress({
    parent_run_id: "R-vc006", subagent_id: "sub-t-1", percent: 59,
    dataDir: busDir, busId: "vc006-t1:test",
  });
  assert.equal(r3.emitted, false);
  // 70% — should pass (50→70 = 20 >= 10)
  const r4 = bridge.progress({
    parent_run_id: "R-vc006", subagent_id: "sub-t-1", percent: 70,
    dataDir: busDir, busId: "vc006-t1:test",
  });
  assert.equal(r4.emitted, true);

  // event-bus should have exactly 2 progress events (50% and 70%)
  const bus = createEventBus({ busId: "vc006-t1:test", dataDir: busDir, fsync: false });
  const progress = bus.list({ event_name: "subagent_progress" });
  assert.equal(progress.events.length, 2);
  bus.close();
});

test("VC-006 T2: bridge.progress force=true bypasses throttle", () => {
  const cwd = freshFixture();
  const busDir = freshBusDir();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  bridge._resetThrottleForTests();

  bridge.spawn({
    parent_run_run_id: "R-vc006", parent_run_id: "R-vc006", subagent_id: "sub-t-2", role: "explore",
    task_description: "force", dataDir: busDir, busId: "vc006-t2:test",
  });
  bridge.progress({ parent_run_id: "R-vc006", subagent_id: "sub-t-2", percent: 50, dataDir: busDir, busId: "vc006-t2:test" });
  // 51% with force
  const r = bridge.progress({
    parent_run_id: "R-vc006", subagent_id: "sub-t-2", percent: 51, force: true,
    dataDir: busDir, busId: "vc006-t2:test",
  });
  assert.equal(r.emitted, true);

  const bus = createEventBus({ busId: "vc006-t2:test", dataDir: busDir, fsync: false });
  const progress = bus.list({ event_name: "subagent_progress" });
  assert.equal(progress.events.length, 2);
  bus.close();
});

// ─── 5. Bridge validation (input errors) ───────────────────────────────────

test("VC-006 V1: bridge.spawn throws on missing subagent_id", () => {
  const cwd = freshFixture();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  assert.throws(() => {
    bridge.spawn({ parent_run_id: "R-vc006", role: "explore", task_description: "x" });
  }, /subagent_id is required/);
});

test("VC-006 V2: bridge.complete throws on invalid status", () => {
  const cwd = freshFixture();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  assert.throws(() => {
    bridge.complete({ parent_run_id: "R-vc006", subagent_id: "x", status: "weird" });
  }, /must be success\|partial\|failed/);
});

test("VC-006 V3: bridge.progress throws on percent out of range", () => {
  const cwd = freshFixture();
  process.chdir(cwd);
  delete require.cache[require.resolve(BRIDGE)];
  const bridge = require(BRIDGE);
  assert.throws(() => {
    bridge.progress({ parent_run_id: "R-vc006", subagent_id: "x", percent: 150 });
  }, /must be a number 0-100/);
});
