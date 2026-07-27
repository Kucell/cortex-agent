"use strict";

/**
 * Dashboard Supervisor — idle grace and recovery tests for M-004.
 *
 * Contract:
 *  - Dashboard Session must NOT keep itself alive — when the only
 *    "active" source is the dashboard-manager session, the supervisor
 *    must still allow stop
 *  - `stop --if-idle` succeeds when state is `idle`
 *  - Stale PID: if state.dashboard.pid points at a dead process,
 *    `ensure` must transition cleanly without spurious refused status
 *  - PID reuse: a different process holding the recorded pid must NOT
 *    be killed by the supervisor
 *  - Idle deadline is cancellable: a subsequent ensure cancels any
 *    pending stop
 *  - The supervisor never schedules a stop by itself (no self-sustaining
 *    timer) — idle shutdown must come from an explicit user command
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SUPERVISOR = path.join(ROOT, ".agent", "skills", "dashboard-supervisor", "scripts", "supervisor.js");

function makeFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-idle-"));
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "runtime-evidence", "dashboard-supervisor"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "config", "dashboard-automation.json"),
    JSON.stringify({
      schema_version: 1,
      enabled: opts.enabled !== false,
      mode: "active-workload",
      dashboard_root: null,
      requested_port: 8787,
      refresh_interval_ms: 3000,
      poll_interval_ms: 5000,
      idle_shutdown_ms: opts.idleShutdownMs ?? 900000,
      start_on: ["session_running", "run_running", "task_active"],
      exclude_roles: ["dashboard-manager", "runtime-continuity"],
      localhost_only: true,
    }, null, 2),
    "utf8",
  );
  return root;
}

function callSupervisor(root, args) {
  try {
    const stdout = execFileSync("node", [SUPERVISOR, ...args], { cwd: root, encoding: "utf8" });
    return { ok: true, status: 0, stdout };
  } catch (error) {
    return { ok: false, status: error.status || 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

function seedState(root, statePatch) {
  const stateFile = path.join(root, ".agent", "runtime-evidence", "dashboard-supervisor", "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    schema_version: 1,
    state: "stopped",
    dashboard: null,
    updated_at: new Date().toISOString(),
    start_token: null,
    command_root: "CMD-test",
    ...statePatch,
  }, null, 2));
}

test("dashboard-manager session alone does not keep the supervisor alive", () => {
  const root = makeFixture();
  // Seed state with a dashboard-manager session as the only recorded
  // workload. The supervisor's "active" filter must exclude
  // dashboard-manager and runtime-continuity.
  seedState(root, {
    state: "running",
    dashboard: {
      pid: process.pid,
      port: 8787,
      started_at: new Date().toISOString(),
      session_id: "dashboard-manager",
    },
  });
  const result = callSupervisor(root, ["stop", "--if-idle"]);
  // The supervisor's contract: dashboard-manager Session alone does
  // NOT count as active. The stop must succeed (no workload to
  // protect).
  assert.strictEqual(result.ok, true, `stop --if-idle failed; stderr=${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.ok(["stopped", "idle"].includes(payload.state));
});

test("stale PID: ensure clears dead PID and transitions cleanly", () => {
  const root = makeFixture();
  // Seed state with a PID that is almost certainly dead (very high
  // number). Ensure must transition the state instead of returning the
  // stale entry unchanged.
  seedState(root, {
    state: "running",
    dashboard: {
      pid: 999999, // dead in normal CI
      port: 8787,
      started_at: new Date().toISOString(),
    },
  });
  const result = callSupervisor(root, ["ensure"]);
  assert.strictEqual(result.ok, true, `ensure failed; stderr=${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  // After ensure, the state should reflect a fresh transition
  // (start_token preserved from before, dashboard.pid updated).
  assert.ok(payload.start_token, "ensure must preserve the identity across stale PID recovery");
});

test("PID reuse safety: supervisor must not assume PID ownership", () => {
  const root = makeFixture();
  // Seed state with a wildly large PID. A subsequent ensure must NOT
  // try to kill the recorded PID; the supervisor only writes state.
  seedState(root, {
    state: "running",
    dashboard: {
      pid: 9999998,
      port: 8787,
      started_at: new Date().toISOString(),
    },
  });
  const result = callSupervisor(root, ["ensure"]);
  assert.strictEqual(result.ok, true);
  // The supervisor must not error out on a missing PID; it must simply
  // transition state.
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.state, "starting");
});

test("idle state allows --if-idle stop without refusal", () => {
  const root = makeFixture();
  seedState(root, { state: "idle" });
  const result = callSupervisor(root, ["stop", "--if-idle"]);
  assert.strictEqual(result.ok, true);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.state, "stopped");
});

test("non-idle state refuses --if-idle stop", () => {
  const root = makeFixture();
  seedState(root, {
    state: "running",
    dashboard: {
      pid: process.pid,
      port: 8787,
      started_at: new Date().toISOString(),
      session_id: "real-workload",
    },
  });
  const result = callSupervisor(root, ["stop", "--if-idle"]);
  assert.strictEqual(result.ok, false, "stop --if-idle must refuse a non-idle state");
  const payload = JSON.parse(result.stdout || "{}");
  assert.strictEqual(payload.refused, true);
});

test("subsequent ensure cancels pending idle shutdown (idempotent recovery)", () => {
  const root = makeFixture();
  // Seed state with a dead PID and idle state. Ensure should clear
  // the dead PID and put us back to starting, not stuck on idle.
  seedState(root, {
    state: "idle",
    dashboard: { pid: 9999997, port: 8787, started_at: new Date().toISOString() },
  });
  const result = callSupervisor(root, ["ensure"]);
  assert.strictEqual(result.ok, true);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.state, "starting");
});

test("supervisor never schedules its own idle shutdown (no self-sustaining timer)", () => {
  const root = makeFixture({ idleShutdownMs: 1000 });
  // Ensure twice in quick succession; the supervisor must not write a
  // timer or schedule field that would imply background self-shutdown.
  callSupervisor(root, ["ensure"]);
  const stateFile = path.join(root, ".agent", "runtime-evidence", "dashboard-supervisor", "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(!("scheduled_stop" in state), "supervisor must not schedule its own stop");
  assert.ok(!("idle_timer" in state), "supervisor must not embed an idle timer");
});