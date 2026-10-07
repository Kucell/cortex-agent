"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { ensureProjectDescriptor, readDescriptor, rebind } = require("../../lib/governance/lifecycle");
const { migrateEmbeddedToDetached } = require("../../lib/governance/migration");
const { createGitGovernanceStore } = require("../../lib/governance/git-store");
const { RemoteParallelStore } = require("../../lib/parallel/remote-store");
const { reconcile, canResume } = require("../../lib/reconciliation");
const {
  createGenericGitAdapter,
  createGitHubAdapter,
  createGitLabAdapter,
  createGiteeAdapter,
  hasProviderCapability,
} = require("../../lib/governance/providers");

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initBare(repo) {
  fs.mkdirSync(repo, { recursive: true });
  const result = spawnSync("git", ["init", "-q", "--bare"], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function remoteWorkspace(id, session, branch) {
  return {
    kind: "git-remote",
    workspace_id: id,
    repository_id: "github:Kucell/cortex-agent",
    branch,
    head_revision: "product-head-1",
    session_id: session,
  };
}

test("provider capability matrix preserves portable core across GitHub GitLab Gitee and Generic Git", () => {
  const adapters = [
    createGitHubAdapter(),
    createGitLabAdapter(),
    createGiteeAdapter(),
    createGenericGitAdapter(),
  ];
  for (const adapter of adapters) {
    assert.equal(adapter.supports("repository.resolve"), true);
    assert.equal(adapter.supports("revision.read"), true);
    assert.equal(adapter.supports("conditional-write"), true);
  }
  assert.equal(hasProviderCapability("github", "change-request.read"), true);
  assert.equal(hasProviderCapability("gitlab", "change-request.read"), true);
  assert.equal(hasProviderCapability("gitee", "change-request.read"), true);
  assert.equal(hasProviderCapability("generic-git", "change-request.read"), false);
});

test("two remote sessions share Git-backed Queue and stale writer fails closed", (t) => {
  const root = temp("cortex-ms012-multisession-");
  const repo = path.join(root, "governance.git");
  initBare(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sessionA = new RemoteParallelStore(createGitGovernanceStore(repo));
  const sessionB = new RemoteParallelStore(createGitGovernanceStore(repo));

  sessionA.createQueue({ queue_id: "Q-ACCEPT", concurrency_limit: 2 }, { workflow_gate: "parallel" });

  const aView = sessionA.readQueue("Q-ACCEPT");
  const bView = sessionB.readQueue("Q-ACCEPT");

  sessionA.upsertQueueItem("Q-ACCEPT", {
    task_id: "T-A",
    state: "running",
    agent_id: "agent-a",
    session_id: "session-a",
    workspace: remoteWorkspace("WS-A", "session-a", "feat/a"),
    owned_files: ["src/a/**"],
  }, {
    workflow_gate: "parallel",
    expected_revision: aView.revision,
  });

  assert.throws(
    () => sessionB.upsertQueueItem("Q-ACCEPT", {
      task_id: "T-B",
      state: "running",
      agent_id: "agent-b",
      session_id: "session-b",
      workspace: remoteWorkspace("WS-B", "session-b", "feat/b"),
      owned_files: ["src/b/**"],
    }, {
      workflow_gate: "parallel",
      expected_revision: bView.revision,
    }),
    (error) => error.code === "ERR_GOVERNANCE_REVISION_CONFLICT",
  );

  const final = sessionB.readQueue("Q-ACCEPT");
  assert.equal(final.value.items.length, 1);
  assert.equal(final.value.items[0].session_id, "session-a");
});

test("session restart reattaches to the same governance revision and state", (t) => {
  const root = temp("cortex-ms012-restart-");
  const repo = path.join(root, "governance.git");
  initBare(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let store = createGitGovernanceStore(repo);
  let parallel = new RemoteParallelStore(store);
  parallel.createQueue({ queue_id: "Q-RESTART" }, { workflow_gate: "parallel" });
  const before = parallel.readQueue("Q-RESTART");

  // Simulate chat/sandbox/session disappearing. New process objects only.
  parallel = null;
  store = null;

  const restartedStore = createGitGovernanceStore(repo);
  const restartedParallel = new RemoteParallelStore(restartedStore);
  const after = restartedParallel.readQueue("Q-RESTART");

  assert.equal(after.exists, true);
  assert.equal(after.value.queue_id, "Q-RESTART");
  assert.equal(after.revision.value, before.revision.value);
});

test("Generic Git missing optional checks degrades but does not block controlled resume", () => {
  const result = reconcile({
    governance_snapshot: { expected_revision: "G-1", actual_revision: "G-1" },
    workspace: { head_revision: "P-1" },
    product: { head_revision: "P-1" },
    change_request: {},
    governance: { decisions: [], waitpoints: [], locks: [] },
    observations: [{
      id: "checks",
      source: "generic-git",
      status: "unavailable",
      required: false,
      reason: "provider_capability_missing",
    }],
  });
  assert.equal(result.disposition, "DEGRADED");
  assert.equal(canResume(result), true);
});

test("failed hosted-provider checks block controlled resume", () => {
  const result = reconcile({
    governance_snapshot: { expected_revision: "G-1", actual_revision: "G-1" },
    workspace: { head_revision: "P-1" },
    product: { head_revision: "P-1" },
    change_request: { revision: "P-1" },
    governance: { decisions: [], waitpoints: [], locks: [] },
    observations: [{
      id: "checks",
      source: "github",
      status: "observed",
      required: true,
      value: [{ id: "ci", name: "CI", status: "completed", conclusion: "failure" }],
    }],
  });
  assert.equal(result.disposition, "BLOCKED");
  assert.equal(canResume(result), false);
});

test("local detached Git local roundtrip preserves ProjectIdentity", (t) => {
  const base = temp("cortex-ms012-roundtrip-");
  const project = path.join(base, "product");
  const detached = path.join(base, "product-agent");
  const gitRepo = path.join(base, "product-agent.git");
  fs.mkdirSync(path.join(project, ".agent", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agent", "tasks", "T-1.json"), '{"task_id":"T-1"}\n');
  initBare(gitRepo);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const initial = ensureProjectDescriptor(project, { project_id: "cortex-project-roundtrip" }).descriptor;
  assert.equal(initial.project_id, "cortex-project-roundtrip");

  const migrated = migrateEmbeddedToDetached(project, detached, { allow_unclassified: true });
  assert.equal(migrated.ok, true);
  assert.equal(readDescriptor(project).project_id, "cortex-project-roundtrip");

  const detachedBinding = readDescriptor(project).governance;
  const gitBinding = {
    kind: "git",
    locator: "../product-agent.git",
    ref: "main",
  };
  rebind(project, gitBinding, { expected_current: detachedBinding });
  assert.equal(readDescriptor(project).project_id, "cortex-project-roundtrip");
  assert.equal(readDescriptor(project).governance.kind, "git");

  rebind(project, detachedBinding, { expected_current: gitBinding });
  const final = readDescriptor(project);
  assert.equal(final.project_id, "cortex-project-roundtrip");
  assert.equal(final.governance.kind, "filesystem");
  assert.equal(final.governance.locator, "../product-agent");
});

test("reconciliation conflict then refreshed observation permits controlled resume", () => {
  const stale = reconcile({
    governance_snapshot: { expected_revision: "G-1", actual_revision: "G-2" },
    workspace: { head_revision: "P-1" },
    product: { head_revision: "P-1" },
    change_request: { revision: "P-1" },
    governance: { decisions: [], waitpoints: [], locks: [] },
    observations: [],
  });
  assert.equal(stale.disposition, "RECONCILIATION_REQUIRED");
  assert.equal(canResume(stale), false);

  const refreshed = reconcile({
    governance_snapshot: { expected_revision: "G-2", actual_revision: "G-2" },
    workspace: { head_revision: "P-1" },
    product: { head_revision: "P-1" },
    change_request: { revision: "P-1" },
    governance: { decisions: [], waitpoints: [], locks: [] },
    observations: [],
  });
  assert.equal(refreshed.disposition, "READY");
  assert.equal(canResume(refreshed), true);
});
