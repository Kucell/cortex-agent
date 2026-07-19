"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, ".agent", "workspaces", "scripts", "workspace-runtime.js");

function project(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-workspace-runtime-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function run(cwd, resource, action, value) {
  const args = [RUNTIME, resource, action];
  if (value !== undefined) args.push("--payload-json", JSON.stringify(value));
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}

function workspace(id, agent = `agent-${id}`) {
  return {
    workspace_id: id,
    repository_id: "repo",
    root: "/repo",
    worktree_path: `/repo-${id}`,
    branch: `agent/${id}`,
    base_commit: "1234567",
    agent_id: agent
  };
}

function hook(id, workspaceId, agentId, overrides = {}) {
  return {
    hook_run_id: id,
    workspace_id: workspaceId,
    phase: "setup",
    workflow: "/worktree",
    agent_id: agentId,
    authorization: "project_allowlist",
    timeout_seconds: 30,
    max_attempts: 2,
    redact_output: true,
    external_side_effect: false,
    ...overrides
  };
}

function lease(id, workspaceId, agentId, key) {
  return {
    lease_id: id,
    workspace_id: workspaceId,
    resource_type: "port",
    resource_key: key,
    agent_id: agentId,
    strategy: "registry_scan",
    value: Number(key),
    environment_key: "PORT"
  };
}

test("workspace and hook lifecycle support success, timeout, retry, and compensation", (t) => {
  const cwd = project(t);
  assert.equal(run(cwd, "workspace", "create", workspace("WS-one", "agent-one")).status, 0);
  assert.equal(run(cwd, "workspace", "transition", { workspace_id: "WS-one", agent_id: "agent-one", status: "preparing" }).status, 0);

  assert.equal(run(cwd, "hook", "request", hook("WH-setup", "WS-one", "agent-one")).status, 0);
  assert.equal(run(cwd, "hook", "transition", { hook_run_id: "WH-setup", workflow: "/worktree", agent_id: "agent-one", status: "running" }).status, 0);
  assert.equal(run(cwd, "hook", "transition", { hook_run_id: "WH-setup", workflow: "/worktree", agent_id: "agent-one", status: "timed_out", failure_reason: "deadline", evidence_ref: "evidence/timeout.json" }).status, 0);
  assert.equal(run(cwd, "hook", "transition", { hook_run_id: "WH-setup", workflow: "/worktree", agent_id: "agent-one", status: "authorized" }).status, 0);
  assert.equal(run(cwd, "hook", "transition", { hook_run_id: "WH-setup", workflow: "/worktree", agent_id: "agent-one", status: "running" }).status, 0);
  assert.equal(run(cwd, "hook", "transition", { hook_run_id: "WH-setup", workflow: "/worktree", agent_id: "agent-one", status: "compensating", compensation_hook_run_id: "WH-cleanup" }).status, 0);
  assert.equal(run(cwd, "hook", "transition", { hook_run_id: "WH-setup", workflow: "/worktree", agent_id: "agent-one", status: "compensated" }).status, 0);

  const record = JSON.parse(fs.readFileSync(path.join(cwd, ".agent/workspaces/state/hooks/WH-setup.json")));
  assert.equal(record.status, "compensated");
  assert.equal(record.attempt, 2);
  assert.deepEqual(record.evidence_refs, ["evidence/timeout.json"]);
});

test("hook requests require redaction and explicit Decisions for external effects", (t) => {
  const cwd = project(t);
  assert.equal(run(cwd, "workspace", "create", workspace("WS-safe", "agent-safe")).status, 0);
  assert.equal(run(cwd, "hook", "request", hook("WH-unsafe", "WS-safe", "agent-safe", { redact_output: false })).status, 2);
  assert.equal(run(cwd, "hook", "request", hook("WH-external", "WS-safe", "agent-safe", { external_side_effect: true })).status, 2);
  assert.equal(run(cwd, "hook", "request", hook("WH-approved", "WS-safe", "agent-safe", {
    authorization: "user_decision", external_side_effect: true, decision_id: "D-approved"
  })).status, 0);
});

test("two workspaces cannot hold the same local resource and release is idempotent", (t) => {
  const cwd = project(t);
  assert.equal(run(cwd, "workspace", "create", workspace("WS-a", "agent-a")).status, 0);
  assert.equal(run(cwd, "workspace", "create", workspace("WS-b", "agent-b")).status, 0);
  assert.equal(run(cwd, "lease", "acquire", lease("RL-a", "WS-a", "agent-a", "13000")).status, 0);

  const conflict = run(cwd, "lease", "acquire", lease("RL-bad", "WS-b", "agent-b", "13000"));
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stdout).error, "resource_conflict");

  assert.equal(run(cwd, "lease", "acquire", lease("RL-b", "WS-b", "agent-b", "23000")).status, 0);
  const release = { lease_id: "RL-a", agent_id: "agent-a", reason: "teardown", evidence_ref: "evidence/release-a.json" };
  assert.equal(run(cwd, "lease", "release", release).status, 0);
  assert.equal(run(cwd, "lease", "release", release).status, 0);

  const records = JSON.parse(run(cwd, "lease", "list").stdout).result;
  assert.equal(records.find((item) => item.lease_id === "RL-a").status, "released");
  assert.equal(records.find((item) => item.lease_id === "RL-b").status, "held");
});

test("expired leases become stale but read-side recovery never releases or deletes them", (t) => {
  const cwd = project(t);
  assert.equal(run(cwd, "workspace", "create", workspace("WS-stale", "agent-stale")).status, 0);
  const input = { ...lease("RL-stale", "WS-stale", "agent-stale", "33000"), expires_at: "2026-01-01T00:00:00.000Z" };
  assert.equal(run(cwd, "lease", "acquire", input).status, 0);
  const sweep = run(cwd, "lease", "sweep", { at: "2026-07-19T00:00:00.000Z" });
  assert.equal(sweep.status, 0);
  assert.deepEqual(JSON.parse(sweep.stdout).result, { marked_stale: ["RL-stale"], released: [] });
  assert.ok(fs.existsSync(path.join(cwd, ".agent/workspaces/state/leases/RL-stale.json")));
});

test("owner checks protect workspace transitions and lease release", (t) => {
  const cwd = project(t);
  assert.equal(run(cwd, "workspace", "create", workspace("WS-owner", "agent-owner")).status, 0);
  assert.equal(run(cwd, "workspace", "transition", { workspace_id: "WS-owner", agent_id: "other", status: "preparing" }).status, 2);
  assert.equal(run(cwd, "lease", "acquire", lease("RL-owner", "WS-owner", "agent-owner", "43000")).status, 0);
  assert.equal(run(cwd, "lease", "release", { lease_id: "RL-owner", agent_id: "other", reason: "steal" }).status, 2);
});

test("two isolated workspaces teardown without owned lease residue", (t) => {
  const cwd = project(t);
  for (const [suffix, port] of [["left", "51001"], ["right", "51002"]]) {
    const workspaceId = `WS-${suffix}`;
    const agentId = `agent-${suffix}`;
    const leaseId = `RL-${suffix}`;
    assert.equal(run(cwd, "workspace", "create", workspace(workspaceId, agentId)).status, 0);
    assert.equal(run(cwd, "workspace", "transition", { workspace_id: workspaceId, agent_id: agentId, status: "preparing" }).status, 0);
    assert.equal(run(cwd, "workspace", "transition", { workspace_id: workspaceId, agent_id: agentId, status: "ready" }).status, 0);
    assert.equal(run(cwd, "workspace", "transition", { workspace_id: workspaceId, agent_id: agentId, status: "running" }).status, 0);
    assert.equal(run(cwd, "lease", "acquire", lease(leaseId, workspaceId, agentId, port)).status, 0);
  }

  for (const suffix of ["left", "right"]) {
    const workspaceId = `WS-${suffix}`;
    const agentId = `agent-${suffix}`;
    assert.equal(run(cwd, "workspace", "transition", { workspace_id: workspaceId, agent_id: agentId, status: "tearing_down" }).status, 0);
    assert.equal(run(cwd, "lease", "release", { lease_id: `RL-${suffix}`, agent_id: agentId, reason: "teardown", evidence_ref: `evidence/${suffix}.json` }).status, 0);
    assert.equal(run(cwd, "workspace", "transition", { workspace_id: workspaceId, agent_id: agentId, status: "closed" }).status, 0);
  }

  const records = JSON.parse(run(cwd, "lease", "list").stdout).result;
  assert.equal(records.filter((item) => item.status === "held").length, 0);
  assert.deepEqual(records.map((item) => item.status), ["released", "released"]);
});
