"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const audit = path.join(root, "templates/_shared/.agent/skills/worktree-audit/scripts/index.js");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function run(repo) {
  return JSON.parse(execFileSync(process.execPath, [audit, "--repo", repo, "--dirty-only", "--json"], { encoding: "utf8" }));
}

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-worktree-audit-"));
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "base");
  return repo;
}

test("worktree audit classifies tracked, dist, and untracked changes without mutation", () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  fs.mkdirSync(path.join(repo, "dist"));
  fs.writeFileSync(path.join(repo, "dist", "bundle.js"), "generated\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "untracked\n");
  const before = git(repo, "status", "--porcelain");

  const report = run(repo);
  const item = report.worktrees.find((worktree) => worktree.path === fs.realpathSync(repo));
  assert.equal(report.read_only, true);
  assert.equal(item.state, "owner_action_required");
  assert.deepEqual(item.files.map((file) => file.category).sort(), ["dist", "tracked", "untracked"]);
  assert.equal(git(repo, "status", "--porcelain"), before, "audit must not mutate Git state");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("worktree audit blocks unmerged paths as recovery_required", () => {
  const repo = initRepo();
  git(repo, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(repo, "README.md"), "feature\n");
  git(repo, "commit", "-am", "feature change");
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "main\n");
  git(repo, "commit", "-am", "main change");
  try { git(repo, "merge", "feature"); } catch {}

  const report = run(repo);
  const item = report.worktrees.find((worktree) => worktree.path === fs.realpathSync(repo));
  assert.equal(item.state, "recovery_required");
  assert.ok(item.files.some((file) => file.category === "unmerged"));
  assert.match(item.next_action, /explicitly resolve|explicitly abort/);
  git(repo, "merge", "--abort");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("runtime and distributed worktree audit scripts remain identical", () => {
  const runtime = path.join(root, ".agent/skills/worktree-audit/scripts/index.js");
  assert.equal(fs.readFileSync(runtime, "utf8"), fs.readFileSync(audit, "utf8"));
});
