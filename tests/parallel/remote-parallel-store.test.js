"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { createFilesystemGovernanceStore } = require("../../lib/governance/store");
const { createGitGovernanceStore } = require("../../lib/governance/git-store");
const {
  RemoteParallelStore,
  ownedFilesOverlap,
} = require("../../lib/parallel/remote-store");

function remoteWorkspace(id, session) {
  return {
    kind: "git-remote",
    workspace_id: id,
    repository_id: "org/product",
    branch: "feat/" + id,
    head_revision: "abc",
    session_id: session,
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("owned_files overlap detection catches exact and wildcard-prefix conflicts", () => {
  assert.equal(ownedFilesOverlap(["src/auth/**"], ["src/auth/token.js"]), true);
  assert.equal(ownedFilesOverlap(["src/a.js"], ["src/a.js"]), true);
  assert.equal(ownedFilesOverlap(["src/auth/**"], ["src/user/**"]), false);
});

test("filesystem remote parallel queue rejects stale concurrent session update", (t) => {
  const root = tempDir("cortex-remote-parallel-fs-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFilesystemGovernanceStore(root);
  const parallel = new RemoteParallelStore(store);

  parallel.createQueue({ queue_id: "Q-1", concurrency_limit: 2 }, { workflow_gate: "parallel" });
  const a = parallel.readQueue("Q-1");
  const b = parallel.readQueue("Q-1");
  assert.equal(a.revision.value, b.revision.value);

  parallel.upsertQueueItem("Q-1", {
    task_id: "T-1",
    state: "running",
    agent_id: "agent-a",
    session_id: "S-A",
    workspace: remoteWorkspace("WS-A", "S-A"),
    owned_files: ["src/a/**"],
  }, {
    workflow_gate: "parallel",
    expected_revision: a.revision,
  });

  assert.throws(
    () => parallel.upsertQueueItem("Q-1", {
      task_id: "T-2",
      state: "running",
      agent_id: "agent-b",
      session_id: "S-B",
      workspace: remoteWorkspace("WS-B", "S-B"),
      owned_files: ["src/b/**"],
    }, {
      workflow_gate: "parallel",
      expected_revision: b.revision,
    }),
    (error) => error.code === "ERR_GOVERNANCE_REVISION_CONFLICT",
  );

  const current = parallel.readQueue("Q-1");
  assert.equal(current.value.items.length, 1);
  assert.equal(current.value.items[0].session_id, "S-A");
  assert.equal(current.value.items[0].workspace.worktree_path, null);
});

test("GitGovernanceStore queue preserves global CAS across remote sessions", (t) => {
  const repo = tempDir("cortex-remote-parallel-git-");
  const init = spawnSync("git", ["init", "-q", "--bare"], { cwd: repo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const store = createGitGovernanceStore(repo);
  const parallel = new RemoteParallelStore(store);
  parallel.createQueue({ queue_id: "Q-GIT", concurrency_limit: 2 }, { workflow_gate: "parallel" });

  const first = parallel.readQueue("Q-GIT");
  const second = parallel.readQueue("Q-GIT");

  parallel.upsertQueueItem("Q-GIT", {
    task_id: "T-A",
    state: "running",
    agent_id: "agent-a",
    workspace: remoteWorkspace("WS-GA", "S-GA"),
  }, {
    workflow_gate: "parallel",
    expected_revision: first.revision,
  });

  assert.throws(
    () => parallel.upsertQueueItem("Q-GIT", {
      task_id: "T-B",
      state: "running",
      agent_id: "agent-b",
      workspace: remoteWorkspace("WS-GB", "S-GB"),
    }, {
      workflow_gate: "parallel",
      expected_revision: second.revision,
    }),
    (error) => error.code === "ERR_GOVERNANCE_REVISION_CONFLICT",
  );
});

test("parallel queue and lock mutations require the parallel workflow gate", (t) => {
  const root = tempDir("cortex-remote-parallel-gate-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parallel = new RemoteParallelStore(createFilesystemGovernanceStore(root));

  assert.throws(
    () => parallel.createQueue({ queue_id: "Q-1" }, { workflow_gate: "mission" }),
    (error) => error.code === "ERR_REMOTE_PARALLEL_GATE_REQUIRED",
  );

  assert.throws(
    () => parallel.acquireLock({
      scope: "task:T-1",
      held_by: "agent-a",
      workspace: remoteWorkspace("WS-A", "S-A"),
    }, { workflow_gate: "worktree" }),
    (error) => error.code === "ERR_REMOTE_PARALLEL_GATE_REQUIRED",
  );
});

test("owned_files conflict blocks a second remote logical lock", (t) => {
  const root = tempDir("cortex-remote-parallel-lock-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parallel = new RemoteParallelStore(createFilesystemGovernanceStore(root));

  const active = [{
    scope: "task:T-1",
    held_by: "agent-a",
    owned_files: ["src/auth/**"],
    released: false,
  }];

  assert.throws(
    () => parallel.acquireLock({
      scope: "task:T-2",
      held_by: "agent-b",
      workspace: remoteWorkspace("WS-B", "S-B"),
      owned_files: ["src/auth/token.js"],
    }, {
      workflow_gate: "parallel",
      active_locks: active,
    }),
    (error) => error.code === "ERR_REMOTE_PARALLEL_OWNED_FILES_CONFLICT",
  );
});

test("Decision and Waitpoint authority block remote dispatch without mutation", (t) => {
  const root = tempDir("cortex-remote-parallel-gates-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFilesystemGovernanceStore(root);
  const parallel = new RemoteParallelStore(store);

  store.writeJson("decisions/D-1.json", {
    decision_id: "D-1",
    status: "pending",
  });
  store.writeJson("waitpoints/WP-1.json", {
    waitpoint_id: "WP-1",
    status: "active",
  });

  assert.throws(
    () => parallel.assertDispatchAllowed({ decision_ids: ["D-1"] }),
    (error) => error.code === "ERR_REMOTE_PARALLEL_DECISION_BLOCKED",
  );

  store.writeJson("decisions/D-1.json", {
    decision_id: "D-1",
    status: "approved",
  });

  assert.throws(
    () => parallel.assertDispatchAllowed({
      decision_ids: ["D-1"],
      waitpoint_ids: ["WP-1"],
    }),
    (error) => error.code === "ERR_REMOTE_PARALLEL_WAITPOINT_BLOCKED",
  );

  assert.equal(store.readJson("waitpoints/WP-1.json").value.status, "active");
});

test("remote logical lock owner can release through CAS-backed store", (t) => {
  const root = tempDir("cortex-remote-parallel-release-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parallel = new RemoteParallelStore(createFilesystemGovernanceStore(root));

  parallel.acquireLock({
    scope: "task:T-1",
    held_by: "agent-a",
    session_id: "S-A",
    workspace: remoteWorkspace("WS-A", "S-A"),
    owned_files: ["src/a/**"],
  }, { workflow_gate: "parallel" });

  assert.throws(
    () => parallel.releaseLock("task:T-1", "agent-b", { workflow_gate: "parallel" }),
    (error) => error.code === "ERR_REMOTE_PARALLEL_LOCK_OWNER",
  );

  const result = parallel.releaseLock("task:T-1", "agent-a", { workflow_gate: "parallel" });
  assert.equal(result.ok, true);
});
