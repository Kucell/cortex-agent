"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const MANAGEMENT_FILES = ["index.js", "normalize-token-usage.js", "projection-registry.json"];

function installAgent(agentRoot) {
  const scripts = path.join(agentRoot, "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of MANAGEMENT_FILES) {
    fs.copyFileSync(path.join(ROOT, ".agent", "skills", "management-api", "scripts", file), path.join(scripts, file));
  }
  for (const directory of ["runs", "queues", "sessions", "inbox", "decisions", "waitpoints", "plans"]) {
    fs.mkdirSync(path.join(agentRoot, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(agentRoot, "plans", "task-progress.md"), "# Task progress\n", "utf8");
}

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
  });
}

test("explicit worktree project keeps code root distinct from shared agent root", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-management-worktree-"));
  const sharedAgent = path.join(base, "shared-agent");
  const worktree = path.join(base, "worktree");
  const caller = path.join(base, "caller");
  fs.mkdirSync(worktree);
  fs.mkdirSync(caller);
  installAgent(sharedAgent);
  fs.symlinkSync(sharedAgent, path.join(worktree, ".agent"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const result = run(caller, ["query", "runs", "--project", worktree]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.project.root, fs.realpathSync(worktree));
  assert.equal(payload.project.agent_root, fs.realpathSync(sharedAgent));
});

test("implicit project resolution uses the containing Git worktree root", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-management-git-"));
  installAgent(path.join(project, ".agent"));
  fs.mkdirSync(path.join(project, "nested"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const result = run(path.join(project, "nested"), ["query", "runs"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).project.root, fs.realpathSync(project));
});

test("explicit project paths do not search parent directories", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-management-explicit-"));
  installAgent(path.join(project, ".agent"));
  const nested = path.join(project, "nested");
  fs.mkdirSync(nested);
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const result = run(project, ["query", "runs", "--project", nested]);
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "PROJECT_AGENT_NOT_FOUND");
});
