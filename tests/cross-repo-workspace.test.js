"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, ".agent/workspaces/scripts/workspace-runtime.js");

function run(cwd, resource, action, value) {
  const args = [RUNTIME, resource, action];
  if (value !== undefined) args.push("--payload-json", JSON.stringify(value));
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.name", "Cortex Test"]);
  git(directory, ["config", "user.email", "cortex@example.invalid"]);
  fs.writeFileSync(path.join(directory, "README.md"), `${name}\n`);
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "-qm", "initial"]);
  return { directory, commit: git(directory, ["rev-parse", "HEAD"]) };
}

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-cross-repo-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const frontend = repository(cwd, "frontend");
  const backend = repository(cwd, "backend");
  for (const [id, repo] of [["frontend", frontend], ["backend", backend]]) {
    assert.equal(run(cwd, "workspace", "create", {
      workspace_id: `WS-${id}`, repository_id: id, root: repo.directory, worktree_path: repo.directory,
      branch: "agent/T-100-auth", base_commit: repo.commit, head_commit: repo.commit, agent_id: "coordinator"
    }).status, 0);
  }
  const create = run(cwd, "composite", "create", {
    composite_workspace_id: "CWS-auth", task_id: "T-100", branch_family: "agent/T-100-auth", agent_id: "coordinator",
    members: [
      { repository_id: "frontend", workspace_id: "WS-frontend", branch: "agent/T-100-auth", base_commit: frontend.commit, head_commit: frontend.commit },
      { repository_id: "backend", workspace_id: "WS-backend", branch: "agent/T-100-auth", base_commit: backend.commit, head_commit: backend.commit }
    ],
    merge_order: ["backend", "frontend"]
  });
  assert.equal(create.status, 0, create.stdout);
  return { cwd, frontend, backend };
}

function member(cwd, repositoryId, status, extra = {}) {
  return run(cwd, "composite", "member", {
    composite_workspace_id: "CWS-auth", repository_id: repositoryId, agent_id: "coordinator", status, ...extra
  });
}

function approve(cwd, repositoryId, revision, id) {
  const directory = path.join(cwd, ".agent", "decisions");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
    decision_id: id, status: "approved", selected_option: "approve",
    gate: { action: "merge", resource_ref: `composite:CWS-auth:repo:${repositoryId}:revision:${revision}` }
  }));
}

test("composite workspace preserves two independent Git histories", (t) => {
  const { cwd, frontend, backend } = setup(t);
  assert.notEqual(frontend.directory, backend.directory);
  assert.ok(fs.existsSync(path.join(frontend.directory, ".git")));
  assert.ok(fs.existsSync(path.join(backend.directory, ".git")));
  assert.notEqual(run(cwd, "composite", "get", undefined).status, 0, "get without an id must fail rather than infer a workspace");
  const stored = JSON.parse(fs.readFileSync(path.join(cwd, ".agent/workspaces/state/composites/CWS-auth.json")));
  assert.equal(stored.atomic_merge, false);
  assert.deepEqual(stored.merge_order, ["backend", "frontend"]);
  assert.deepEqual(stored.members.map((item) => item.repository_id), ["backend", "frontend"]);
});

test("merge readiness requires an approved Decision bound to exact repository revision", (t) => {
  const { cwd, backend } = setup(t);
  assert.equal(member(cwd, "backend", "ready").status, 0);
  assert.equal(member(cwd, "backend", "running").status, 0);
  assert.equal(member(cwd, "backend", "validated", { head_commit: backend.commit, validation_ref: "validation/backend.json" }).status, 0);
  approve(cwd, "backend", "wrong-revision", "D-wrong");
  assert.equal(member(cwd, "backend", "merge_ready", { decision_id: "D-wrong" }).status, 2);
  approve(cwd, "backend", backend.commit, "D-right");
  assert.equal(member(cwd, "backend", "merge_ready", { decision_id: "D-right" }).status, 0);
  assert.equal(member(cwd, "backend", "merged", { decision_id: "D-right", validation_ref: "merge/backend.json" }).status, 0);
  const stored = JSON.parse(fs.readFileSync(path.join(cwd, ".agent/workspaces/state/composites/CWS-auth.json")));
  assert.equal(stored.recovery.next_repository_id, "frontend");
  assert.ok(stored.recovery.checkpoint_refs.includes(".agent/decisions/D-right.json"));
});

test("member failure blocks the composite and records an ordered recovery target", (t) => {
  const { cwd } = setup(t);
  assert.equal(member(cwd, "frontend", "ready").status, 0);
  assert.equal(member(cwd, "frontend", "running").status, 0);
  assert.equal(member(cwd, "frontend", "failed", { next_action: "repair frontend validation" }).status, 0);
  const stored = JSON.parse(fs.readFileSync(path.join(cwd, ".agent/workspaces/state/composites/CWS-auth.json")));
  assert.equal(stored.status, "blocked");
  assert.equal(stored.recovery.failed_repository_id, "frontend");
  assert.equal(stored.recovery.next_repository_id, "frontend");
  assert.equal(stored.recovery.next_action, "repair frontend validation");
});
