"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeRuntimeWorkspaceIdentity,
  fromLegacyWorkspaceRecord,
  createRemoteWorkspaceIdentity,
  requireLocalWorkspace,
  remoteReconciliationFacts,
} = require("../../lib/workspace/identity");

function legacy(overrides = {}) {
  return {
    workspace_id: "WS-local",
    repository_id: "org/repo",
    task_id: "T-1",
    mission_id: "M-1",
    root: "/tmp/repo",
    worktree_path: "/tmp/repo-worktree",
    branch: "feat/local",
    base_branch: "main",
    base_commit: "abc",
    head_commit: "def",
    owner: {
      agent_id: "agent-local",
      session_id: "S-local",
      run_id: "R-local",
    },
    status: "running",
    hook_run_refs: [],
    resource_lease_refs: [],
    relations: {
      queue_item_ids: ["Q-1"],
      lock_scopes: ["task:T-1"],
      artifact_refs: ["artifact:1"],
      composite_workspace_id: null,
    },
    failure: null,
    created_at: "2026-10-06T00:00:00Z",
    updated_at: "2026-10-06T00:01:00Z",
    closed_at: null,
    ...overrides,
  };
}

test("legacy local workspace maps to canonical ExecutionWorkspaceIdentity", () => {
  const value = fromLegacyWorkspaceRecord(legacy());
  assert.equal(value.identity.kind, "local-worktree");
  assert.equal(value.identity.workspace_id, "WS-local");
  assert.equal(value.identity.repository_id, "org/repo");
  assert.equal(value.identity.worktree_path, "/tmp/repo-worktree");
  assert.equal(value.identity.base_revision, "abc");
  assert.equal(value.identity.head_revision, "def");
  assert.equal(value.owner.agent_id, "agent-local");
  assert.equal(value.owner.session_id, "S-local");
  assert.equal(value.owner.run_id, "R-local");
  assert.deepEqual(value.relations.queue_item_ids, ["Q-1"]);
});

test("remote git workspace does not require local root or worktree_path", () => {
  const value = createRemoteWorkspaceIdentity({
    workspace_id: "WS-remote",
    repository_id: "org/repo",
    branch: "feat/remote",
    base_revision: "abc",
    head_revision: "def",
    change_request: "cr:42",
    task_id: "T-2",
    mission_id: "M-2",
    agent_id: "agent-remote",
    session_id: "S-remote",
    run_id: "R-remote",
    status: "running",
  });
  assert.equal(value.identity.kind, "git-remote");
  assert.equal(value.identity.worktree_path, null);
  assert.equal(value.identity.change_request, "cr:42");
  assert.equal(value.owner.session_id, "S-remote");
});

test("cloud sandbox identity can exist without worktree_path", () => {
  const value = createRemoteWorkspaceIdentity({
    kind: "cloud-sandbox",
    workspace_id: "WS-cloud",
    repository_id: "org/repo",
    branch: "feat/cloud",
    base_revision: "abc",
    head_revision: "def",
    agent_id: "agent-cloud",
  });
  assert.equal(value.identity.kind, "cloud-sandbox");
  assert.equal(value.identity.worktree_path, null);
});

test("remote git workspace still requires repository and branch facts", () => {
  assert.throws(
    () => createRemoteWorkspaceIdentity({
      workspace_id: "WS-bad",
      agent_id: "agent",
    }),
    (error) => error.code === "ERR_EXECUTION_WORKSPACE_REMOTE_IDENTITY_REQUIRED",
  );
});

test("requireLocalWorkspace protects local-only Git verification paths", () => {
  const local = fromLegacyWorkspaceRecord(legacy());
  assert.equal(requireLocalWorkspace(local).identity.kind, "local-worktree");

  const remote = createRemoteWorkspaceIdentity({
    workspace_id: "WS-remote",
    repository_id: "org/repo",
    branch: "feat/remote",
    agent_id: "agent-remote",
  });
  assert.throws(
    () => requireLocalWorkspace(remote),
    (error) => error.code === "ERR_LOCAL_WORKSPACE_REQUIRED"
      && error.details.kind === "git-remote",
  );
});

test("remote reconciliation facts expose only portable recorded identity facts", () => {
  const remote = createRemoteWorkspaceIdentity({
    workspace_id: "WS-remote",
    repository_id: "org/repo",
    branch: "feat/remote",
    base_revision: "abc",
    head_revision: "def",
    change_request: "cr:42",
    task_id: "T-2",
    mission_id: "M-2",
    agent_id: "agent-remote",
    session_id: "S-remote",
    run_id: "R-remote",
  });

  assert.deepEqual(remoteReconciliationFacts(remote), {
    workspace_id: "WS-remote",
    kind: "git-remote",
    repository_id: "org/repo",
    branch: "feat/remote",
    base_revision: "abc",
    head_revision: "def",
    change_request: "cr:42",
    task_id: "T-2",
    mission_id: "M-2",
    session_id: "S-remote",
    agent_id: "agent-remote",
    run_id: "R-remote",
  });
});

test("relations are stable, unique and sorted", () => {
  const value = normalizeRuntimeWorkspaceIdentity({
    kind: "git-remote",
    workspace_id: "WS-rel",
    repository_id: "org/repo",
    branch: "feat/x",
    agent_id: "agent",
    relations: {
      queue_item_ids: ["Q-2", "Q-1", "Q-2"],
      lock_scopes: ["task:T-2", "task:T-1", "task:T-2"],
      artifact_refs: ["artifact:b", "artifact:a", "artifact:b"],
    },
  });
  assert.deepEqual(value.relations.queue_item_ids, ["Q-1", "Q-2"]);
  assert.deepEqual(value.relations.lock_scopes, ["task:T-1", "task:T-2"]);
  assert.deepEqual(value.relations.artifact_refs, ["artifact:a", "artifact:b"]);
});
