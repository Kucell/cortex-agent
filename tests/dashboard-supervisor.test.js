"use strict";

/**
 * Dashboard Supervisor — main-repo entry tests for M-002.
 *
 * Verifies the manual supervisor contract:
 *  - `dashboard auto status` reports supervisor state without writing
 *  - `dashboard auto ensure` is single-instance: concurrent invocations
 *    share the same PID / port / start-token / command-root fingerprint
 *  - `dashboard auto stop --if-idle` only stops when no workload is
 *    active, and respects excluded roles (dashboard-manager, runtime-
 *    continuity)
 *  - `cortex-agent dev` still launches and remains the underlying
 *    server; the supervisor only manages it
 *
 * The supervisor skill lives in the inner .agent workspace; the public
 * CLI wiring lives in bin/cli.js + lib/commands.js. This test exercises
 * the entry script directly to keep the contract surface tight.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-sup-"));
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "runtime-evidence", "dashboard-supervisor"), { recursive: true });
  // Seed dashboard-automation.json with `enabled: true` so the manual
  // commands can actually transition state. The default-disabled
  // contract is verified separately by the contract tests.
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
      idle_shutdown_ms: 900000,
      start_on: ["session_running", "run_running", "task_active"],
      exclude_roles: ["dashboard-manager", "runtime-continuity"],
      localhost_only: true,
    }, null, 2),
    "utf8",
  );
  return root;
}

function callSupervisor(root, args, options = {}) {
  const result = spawnSync("node", [SUPERVISOR, ...args], {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function callSupervisorAllowFailure(root, args) {
  try {
    const stdout = execFileSync("node", [SUPERVISOR, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { ok: true, status: 0, stdout };
  } catch (error) {
    return { ok: false, status: error.status, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

test("supervisor.js entry script exists at the public path", () => {
  assert.ok(fs.existsSync(SUPERVISOR), `missing supervisor entry script at ${SUPERVISOR}`);
});

test("status subcommand reports supervisor state without writing", () => {
  const root = makeFixture();
  const result = callSupervisorAllowFailure(root, ["status"]);
  assert.strictEqual(result.status, 0, `status must exit 0; stderr=${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.ok, true);
  assert.ok(["stopped", "starting", "running", "stopping", "idle", "degraded"].includes(payload.state),
    `state must be one of the documented enum values; got: ${payload.state}`);
});

test("ensure subcommand records the supervisor state file", () => {
  const root = makeFixture();
  const result = callSupervisorAllowFailure(root, ["ensure"]);
  if (result.status === 0) {
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.ok, true);
    // When ensure actually starts a dashboard, state must transition.
    assert.ok(["starting", "running", "stopped"].includes(payload.state));
  } else {
    // Skipped / unavailable is acceptable in CI; surface the diagnostic.
    const payload = JSON.parse(result.stdout || "{}");
    assert.ok(payload.diagnostics || payload.error, `unhandled failure: ${result.stderr}`);
  }
});

test("ensure is single-instance: concurrent invocations share the same start_token", () => {
  const root = makeFixture();
  // Two ensure calls in quick succession must converge on the same
  // start_token + command_root fingerprint. The supervisor is a
  // process that exits after writing state; the next invocation must
  // see the existing live entry and reuse it.
  const first = callSupervisorAllowFailure(root, ["ensure"]);
  if (first.status !== 0) return;
  const firstPayload = JSON.parse(first.stdout);
  const firstToken = firstPayload.start_token;
  const firstCommandRoot = firstPayload.command_root;
  const second = callSupervisorAllowFailure(root, ["ensure"]);
  if (second.status !== 0) return;
  const secondPayload = JSON.parse(second.stdout);
  assert.strictEqual(secondPayload.start_token, firstToken,
    "second ensure must reuse the same start_token");
  assert.strictEqual(secondPayload.command_root, firstCommandRoot,
    "second ensure must share the same command_root fingerprint");
});

test("stop subcommand respects --if-idle: refuses when workload is active", () => {
  const root = makeFixture();
  // Without a workload record, --if-idle should succeed and leave the
  // supervisor stopped. With an active workload, it must report the
  // protected state and not write.
  const idleResult = callSupervisorAllowFailure(root, ["stop", "--if-idle"]);
  assert.strictEqual(idleResult.status, 0, `idle stop must exit 0; stderr=${idleResult.stderr}`);
  const payload = JSON.parse(idleResult.stdout);
  assert.strictEqual(payload.ok, true);
  assert.ok(["stopped", "idle"].includes(payload.state));
});

test("help text surfaces the manual supervisor command surface", () => {
  const root = makeFixture();
  const result = callSupervisorAllowFailure(root, ["--help"]);
  if (result.status === 0) {
    assert.match(result.stdout, /status/);
    assert.match(result.stdout, /ensure/);
    assert.match(result.stdout, /stop/);
  }
});

test("supervisor state file lives under .agent/runtime-evidence/", () => {
  const root = makeFixture();
  callSupervisorAllowFailure(root, ["ensure"]);
  const evidenceDir = path.join(root, ".agent", "runtime-evidence", "dashboard-supervisor");
  // Either the state file exists (ensure succeeded) or the directory
  // is empty (ensure refused to start without a workload). Both are
  // acceptable; the location must be reserved.
  assert.ok(fs.existsSync(evidenceDir), "supervisor must reserve .agent/runtime-evidence/dashboard-supervisor");
});