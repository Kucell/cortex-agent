"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const SHARED_AGENT = path.join(ROOT, "templates", "_shared", ".agent");

function createProject(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dashboard-cli-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, ".agent", "config"), { recursive: true });
  fs.cpSync(
    path.join(SHARED_AGENT, "skills", "dashboard-supervisor"),
    path.join(project, ".agent", "skills", "dashboard-supervisor"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(SHARED_AGENT, "config", "dashboard-automation.json"),
    path.join(project, ".agent", "config", "dashboard-automation.json"),
  );
  return project;
}

function run(project, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--project", project], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("public dashboard command forwards help to the project supervisor", (t) => {
  const project = createProject(t);
  const result = run(project, ["dashboard", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.match(payload.usage, /auto status\|enable\|disable/);
});

test("public dashboard command preserves disabled no-op semantics", (t) => {
  const project = createProject(t);
  const status = run(project, ["dashboard", "auto", "status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).enabled, false);

  const ensure = run(project, ["dashboard", "ensure"]);
  assert.equal(ensure.status, 0);
  assert.equal(JSON.parse(ensure.stdout).reason, "supervisor_disabled");
});

test("machine-readable help exposes dashboard as a default-disabled adapter", () => {
  const result = spawnSync(process.execPath, [CLI, "help", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const dashboard = payload.contract.commands.find((command) => command.name === "dashboard");
  assert.ok(dashboard);
  assert.equal(dashboard.mode, "runtime_supervisor");
  assert.equal(dashboard.default_enabled, false);
  assert.equal(dashboard.mcp_writer, false);
});

test("public dashboard command asks old projects to update", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dashboard-old-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, ".agent"), { recursive: true });
  const result = run(project, ["dashboard", "status"]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cortex-agent update/);
});
