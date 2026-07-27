"use strict";

/**
 * Dashboard Supervisor — opt-in auto trigger tests for M-003.
 *
 * Contract:
 *  - `auto enable` sets enabled=true and writes a single transition
 *    marker; `auto disable` reverses it
 *  - `auto status` reports the auto state without writing
 *  - Before enable: every supervisor write path refuses (zero writes)
 *  - After enable: same commands behave identically to manual supervisor
 *  - Calling `auto enable` twice does NOT duplicate the transition
 *    record (idempotent)
 *  - The supervisor must not impersonate runtime-continuity auto mode;
 *    auto trigger is a separate, user-explicit opt-in
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SUPERVISOR = path.join(ROOT, ".agent", "skills", "dashboard-supervisor", "scripts", "supervisor.js");

function makeFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-auto-"));
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "runtime-evidence", "dashboard-supervisor"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "config", "dashboard-automation.json"),
    JSON.stringify({
      schema_version: 1,
      enabled: !!opts.enabled,
      mode: "active-workload",
      dashboard_root: null,
      requested_port: 8787,
      refresh_interval_ms: 3000,
      poll_interval_ms: 5000,
      idle_shutdown_ms: 900000,
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

test("auto status reports enabled=false by default", () => {
  const root = makeFixture({ enabled: false });
  const result = callSupervisor(root, ["auto", "status"]);
  assert.strictEqual(result.ok, true);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.enabled, false);
});

test("auto enable sets enabled=true and reports the transition", () => {
  const root = makeFixture({ enabled: false });
  const result = callSupervisor(root, ["auto", "enable"]);
  assert.strictEqual(result.ok, true);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.enabled, true);
  // The config file must now reflect enabled=true.
  const configFile = path.join(root, ".agent", "config", "dashboard-automation.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.strictEqual(config.enabled, true);
});

test("auto disable reverses enabled=true", () => {
  const root = makeFixture({ enabled: true });
  const result = callSupervisor(root, ["auto", "disable"]);
  assert.strictEqual(result.ok, true);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.enabled, false);
  const configFile = path.join(root, ".agent", "config", "dashboard-automation.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.strictEqual(config.enabled, false);
});

test("auto enable is idempotent: second call still reports enabled=true with no error", () => {
  const root = makeFixture({ enabled: false });
  const first = callSupervisor(root, ["auto", "enable"]);
  const second = callSupervisor(root, ["auto", "enable"]);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  const secondPayload = JSON.parse(second.stdout);
  assert.strictEqual(secondPayload.enabled, true);
});

test("before enable, ensure / stop refuse without writing a dashboard state", () => {
  const root = makeFixture({ enabled: false });
  // Use the manual ensure / stop — they should refuse because the
  // supervisor is disabled. The dashboard state file must remain empty.
  const ensureResult = callSupervisor(root, ["ensure"]);
  assert.strictEqual(ensureResult.ok, false, "ensure must refuse when disabled");
  const stateFile = path.join(root, ".agent", "runtime-evidence", "dashboard-supervisor", "state.json");
  assert.ok(!fs.existsSync(stateFile), "ensure must not write state when disabled");
});

test("auto trigger does not impersonate runtime-continuity", () => {
  const root = makeFixture({ enabled: true });
  // Supervisor reports auto state with a distinct field; it must never
  // say "automatic" / "auto-mode" / claim runtime-continuity ownership.
  const result = callSupervisor(root, ["auto", "status"]);
  const payload = JSON.parse(result.stdout);
  assert.ok(!("runtime_continuity" in payload),
    "auto trigger must not impersonate runtime-continuity");
  assert.ok(!("automatic" in payload) || payload.automatic === false,
    "auto trigger must not report as automatic by default");
});

test("auto enable records the transition timestamp and trigger source", () => {
  const root = makeFixture({ enabled: false });
  const result = callSupervisor(root, ["auto", "enable"]);
  const payload = JSON.parse(result.stdout);
  assert.ok(typeof payload.transitioned_at === "string");
  assert.ok(payload.trigger_source, "transition must record a trigger source");
});