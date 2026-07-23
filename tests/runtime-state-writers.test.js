"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const MANAGEMENT = path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", "index.js");

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-runtime-writer-"));
  fs.mkdirSync(path.join(cwd, ".agent", "queues"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "runs"), { recursive: true });
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [MANAGEMENT, ...args], { cwd, encoding: "utf8" });
}

function waitFor(check, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = check();
        if (value) return resolve(value);
      } catch (_) {}
      if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for runtime state"));
      setTimeout(poll, 50);
    };
    poll();
  });
}

test("queue mutations require a workflow gate and persist item state", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const denied = run(cwd, ["queues", "upsert", "--queue-id", "Q-test"]);
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout).error, "workflow_gate_required");

  assert.equal(run(cwd, ["queues", "upsert", "--queue-id", "Q-test", "--gate", "parallel", "--concurrency-limit", "2"]).status, 0);
  assert.equal(run(cwd, ["queues", "item", "--queue-id", "Q-test", "--gate", "parallel", "--task-id", "T-001", "--state", "running"]).status, 0);

  const queue = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "queues", "Q-test.json")));
  assert.equal(queue.updated_by_gate, "parallel");
  assert.equal(queue.items[0].task_id, "T-001");
  assert.equal(queue.items[0].state, "running");
});

test("session heartbeat and owner transitions fail closed", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["sessions", "open", "--session-id", "S-test", "--agent-id", "owner", "--role", "worker"]).status, 0);
  assert.equal(run(cwd, ["sessions", "heartbeat", "--session-id", "S-test", "--agent-id", "other"]).status, 1);
  assert.equal(run(cwd, ["sessions", "close", "--session-id", "S-test", "--agent-id", "other", "--gate", "owner"]).status, 1);
  assert.equal(run(cwd, ["sessions", "close", "--session-id", "S-test", "--agent-id", "owner", "--gate", "owner"]).status, 0);

  const session = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "sessions", "S-test.json")));
  assert.equal(session.status, "closed");
  assert.equal(session.updated_by_gate, "owner");
});

test("closed sessions reject heartbeats and explicit reopen starts a clean lifecycle", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessionFile = path.join(cwd, ".agent", "sessions", "S-reopen.json");

  assert.equal(run(cwd, [
    "sessions", "open",
    "--session-id", "S-reopen",
    "--agent-id", "owner",
    "--role", "worker",
    "--started-at", "2026-07-17T01:00:00.000Z",
  ]).status, 0);
  assert.equal(run(cwd, [
    "sessions", "open",
    "--session-id", "S-reopen",
    "--agent-id", "owner",
    "--role", "worker",
    "--started-at", "2026-07-17T01:30:00.000Z",
  ]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile, "utf8")).started_at, "2026-07-17T01:00:00.000Z");
  assert.equal(run(cwd, [
    "sessions", "close",
    "--session-id", "S-reopen",
    "--agent-id", "owner",
    "--gate", "owner",
  ]).status, 0);

  const closedContent = fs.readFileSync(sessionFile, "utf8");
  const heartbeat = run(cwd, [
    "sessions", "heartbeat",
    "--session-id", "S-reopen",
    "--agent-id", "owner",
  ]);
  assert.equal(heartbeat.status, 1);
  assert.equal(JSON.parse(heartbeat.stdout).error, "session_closed");
  assert.equal(fs.readFileSync(sessionFile, "utf8"), closedContent);

  assert.equal(run(cwd, [
    "sessions", "open",
    "--session-id", "S-reopen",
    "--agent-id", "owner",
    "--role", "worker",
    "--started-at", "2026-07-17T02:00:00.000Z",
  ]).status, 0);
  const reopened = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(reopened.status, "running");
  assert.equal(reopened.started_at, "2026-07-17T02:00:00.000Z");
  assert.equal("closed_at" in reopened, false);
  assert.equal("updated_by_gate" in reopened, false);
});

test("dashboard server owns and closes its runtime session", async (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const agent = path.join(cwd, ".agent");
  const dashboardScripts = path.join(agent, "skills", "agent-dashboard", "scripts");
  const managementScripts = path.join(agent, "skills", "management-api", "scripts");
  fs.mkdirSync(dashboardScripts, { recursive: true });
  fs.mkdirSync(managementScripts, { recursive: true });
  fs.mkdirSync(path.join(agent, "metrics"), { recursive: true });
  fs.copyFileSync(MANAGEMENT, path.join(managementScripts, "index.js"));
  fs.copyFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", "normalize-token-usage.js"),
    path.join(managementScripts, "normalize-token-usage.js"),
  );
  fs.copyFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", "projection-registry.json"),
    path.join(managementScripts, "projection-registry.json"),
  );
  fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-dashboard", "scripts", "generate.js"), path.join(dashboardScripts, "generate.js"));
  fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-dashboard", "scripts", "serve.js"), path.join(dashboardScripts, "serve.js"));
  const dashboardVendor = path.join(agent, "skills", "agent-dashboard", "vendor");
  fs.mkdirSync(dashboardVendor, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-dashboard", "vendor", "markdown-it.min.js"),
    path.join(dashboardVendor, "markdown-it.min.js"),
  );

  const child = spawn(process.execPath, [path.join(dashboardScripts, "serve.js"), "--port", "0", "--interval-ms", "1000", "--session-id", "S-dashboard-test"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });

  const file = path.join(agent, "sessions", "S-dashboard-test.json");
  const opened = await waitFor(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).status === "running");
  assert.equal(opened, true);
  const running = JSON.parse(fs.readFileSync(file));
  assert.equal(running.agent_id, "dashboard-manager");
  assert.ok(running.server.port > 0);

  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const closed = JSON.parse(fs.readFileSync(file));
  assert.equal(closed.status, "closed");
  assert.equal(closed.updated_by_gate, "owner");
});
