const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const shared = path.join(root, "templates/_shared/.agent/workspaces/scripts/worktree-layout.js");

function git(cwd, args) {
  return cp.execFileSync("git", args, { cwd, encoding: "utf8" });
}

function run(script, args) {
  return JSON.parse(cp.execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }));
}

test("worktree layout machine script is distributed from the shared layer", () => {
  assert.ok(fs.existsSync(shared));
});

test("default layout uses one sibling repository container", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-worktree-layout-"));
  const repo = path.join(base, "Demo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  const value = run(shared, ["resolve", "--repo", repo, "--task-id", "T-001-auth"]);
  const canonicalBase = fs.realpathSync(base);
  assert.equal(value.worktree_root, path.join(canonicalBase, "Demo-worktrees"));
  assert.equal(value.worktree_path, path.join(canonicalBase, "Demo-worktrees", "T-001-auth"));
});

test("legacy repository prefix is removed from child name", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-worktree-layout-"));
  const repo = path.join(base, "Demo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  const value = run(shared, ["resolve", "--repo", repo, "--name", "Demo-M007"]);
  assert.equal(value.child_name, "M007");
});

test("repository-internal root fails closed without explicit policy", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-worktree-layout-"));
  const repo = path.join(base, "Demo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  assert.throws(() => cp.execFileSync(process.execPath, [shared, "resolve", "--repo", repo, "--root", path.join(repo, ".worktrees"), "--name", "T-1"]));
});

test("migration plan is read-only and requires a full status/process audit", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-worktree-layout-"));
  const repo = path.join(base, "Demo");
  const legacy = path.join(base, "Demo-T-1");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-qm", "base"]);
  git(repo, ["worktree", "add", "-qb", "agent/T-1", legacy]);
  const value = run(shared, ["plan", "--repo", repo]);
  const child = value.worktrees.find((item) => !item.is_main);
  assert.equal(child.target_path, path.join(fs.realpathSync(base), "Demo-worktrees", "T-1"));
  assert.equal(child.migration, "inspect_required");
  assert.deepEqual(child.blockers, ["full_status_and_active_process_audit_required"]);
  assert.equal(fs.existsSync(child.target_path), false);
});

test("distributed workflows no longer create flat sibling task directories", () => {
  const enWorkflow = fs.readFileSync(path.join(root, "templates/en/.agent/workflows/worktree.md"), "utf8");
  const zhWorkflow = fs.readFileSync(path.join(root, "templates/zh/.agent/workflows/worktree.md"), "utf8");
  assert.match(enWorkflow, /<repo>-worktrees\/T-001/);
  assert.match(zhWorkflow, /<repo>-worktrees\/<task-id>/);
  assert.doesNotMatch(enWorkflow, /worktree add \.\.\/<repo>-<task-id>/);
  assert.doesNotMatch(zhWorkflow, /worktree add \.\.\/<repo>-<task-id>/);
});
