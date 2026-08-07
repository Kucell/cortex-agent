"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const MANAGEMENT_FILES = [
  "index.js",
  "normalize-token-usage.js",
  "projection-registry.json",
  "query-activity.js",
  "query-dispatch-state.js",
];

function copyFile(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function createProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-update-verify-"));
  copyFile(
    path.join(ROOT, "templates", "en", ".agent", "hooks", "hooks.json"),
    path.join(cwd, ".agent", "hooks", "hooks.json"),
  );
  copyFile(
    path.join(ROOT, "templates", "_shared", ".agent", "skills", "runtime-continuity", "scripts", "index.js"),
    path.join(cwd, ".agent", "skills", "runtime-continuity", "scripts", "index.js"),
  );
  for (const file of MANAGEMENT_FILES) {
    copyFile(
      path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", file),
      path.join(cwd, ".agent", "skills", "management-api", "scripts", file),
    );
  }
  copyFile(
    path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
    path.join(cwd, ".agent", "tasks", "scripts", "task-state.js"),
  );
  for (const directory of ["runs", "queues", "sessions", "inbox", "decisions", "waitpoints", "plans", "handoffs", "artifacts"]) {
    fs.mkdirSync(path.join(cwd, ".agent", directory), { recursive: true });
  }
  fs.writeFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "# Task progress\n", "utf8");
  return cwd;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
  });
}

test("update --verify --report json runs smoke checks without upgrade writes", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const result = runCli(project, ["update", "--verify", "--report", "json"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "verify");
  assert.equal(payload.summary.failed, 0);
  assert.ok(payload.summary.passed >= 5);
  assert.ok(payload.verification.some((check) => check.name === "runtime resume-bundle" && check.status === "passed"));
  assert.ok(payload.verification.some((check) => check.name === "query dashboard-state" && check.status === "passed"));
  assert.equal(fs.existsSync(path.join(project, ".agent", "updates", "latest.json")), false);
});

test("update --verify supports an explicit project path", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const result = runCli(ROOT, ["update", "--verify", "--report", "json", "--project", project]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.failed, 0);
  assert.ok(payload.verification.some((check) => check.name === "query capabilities" && check.status === "passed"));
});

test("update --verify reports invalid JSON configuration as failed", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, ".agent", "hooks", "hooks.json"), "{not json", "utf8");

  const result = runCli(project, ["update", "--verify", "--report=json"]);
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.ok(payload.verification.some((check) =>
    check.name.includes(".agent/hooks/hooks.json") &&
    check.status === "failed"));
});
