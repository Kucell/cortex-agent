"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const FILES = ["index.js", "normalize-token-usage.js", "projection-registry.json", "query-activity.js"];

function createProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-writer-cli-"));
  const scripts = path.join(project, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", file), path.join(scripts, file));
  const taskScripts = path.join(project, ".agent", "tasks", "scripts");
  fs.mkdirSync(taskScripts, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"), path.join(taskScripts, "task-state.js"));
  for (const dir of ["runs", "queues", "sessions", "decisions", "inbox", "waitpoints"]) fs.mkdirSync(path.join(project, ".agent", dir), { recursive: true });
  return project;
}

function run(cwd, project, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--project", project], { cwd, encoding: "utf8", env: { ...process.env, LANG: "en_US.UTF-8" } });
}

test("explicit writer actions preserve project scope and owner lifecycle exits", (t) => {
  const project = createProject();
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-writer-caller-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(caller, { recursive: true, force: true }));

  let result = run(caller, project, ["sessions", "open", "--session-id", "S-1", "--agent-id", "owner", "--role", "worker"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).project.root, fs.realpathSync(project));

  result = run(caller, project, ["sessions", "heartbeat", "--session-id", "S-1", "--agent-id", "other"]);
  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).error.code, "SESSION_OWNER_MISMATCH");

  result = run(caller, project, ["sessions", "close", "--session-id", "S-1", "--agent-id", "owner", "--gate", "owner"]);
  assert.equal(result.status, 0, result.stderr);
  result = run(caller, project, ["sessions", "heartbeat", "--session-id", "S-1", "--agent-id", "owner"]);
  assert.equal(result.status, 5);
  assert.equal(JSON.parse(result.stdout).error.code, "SESSION_CLOSED");
});

test("writer gates and atomic failures use stable exit classes", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  let result = run(project, project, ["queues", "upsert", "--queue-id", "Q-1", "--name", "Queue"]);
  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).error.code, "WORKFLOW_GATE_REQUIRED");

  fs.rmSync(path.join(project, ".agent", "runs"), { recursive: true, force: true });
  fs.writeFileSync(path.join(project, ".agent", "runs"), "not-a-directory", "utf8");
  result = run(project, project, ["runs", "checkpoint", "--run-id", "R-1", "--status", "running"]);
  assert.equal(result.status, 5, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "ATOMIC_WRITE_FAILED");
});
