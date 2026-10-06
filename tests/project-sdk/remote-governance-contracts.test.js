"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const project = require(path.join(ROOT, "packages", "project-sdk", "src"));

function baseDescriptor(overrides = {}) {
  return {
    project_id: "demo",
    repository: { slug: "bookmagic-co/demo", default_branch: "main" },
    integration_mode: "connected",
    capabilities: { provided: ["project.discover"], required: [] },
    validation: { profiles: [] },
    artifacts: [],
    events: { mode: "none" },
    boundaries: {
      authoritative_domain: "demo",
      authoritative_runtime: "demo",
      cortex_role: "governance-orchestration",
      protected_components: [],
    },
    ...overrides,
  };
}

test("legacy cortex.project.json remains valid without governance binding", () => {
  const value = project.normalizeProjectDescriptor(baseDescriptor());
  assert.equal(value.project_id, "demo");
  assert.equal(value.governance, null);
});

test("project descriptor accepts additive filesystem governance binding", () => {
  const value = project.normalizeProjectDescriptor(baseDescriptor({
    governance: { kind: "filesystem", locator: ".agent" },
  }));
  assert.deepEqual(value.governance, {
    kind: "filesystem",
    locator: ".agent",
    ref: null,
  });
});

test("project descriptor accepts git governance locator without provider-specific schema", () => {
  const value = project.normalizeProjectDescriptor(baseDescriptor({
    governance: {
      kind: "git",
      locator: "gitlab://bookmagic-co/demo-agent",
      ref: "main",
    },
  }));
  assert.equal(value.governance.kind, "git");
  assert.equal(value.governance.locator, "gitlab://bookmagic-co/demo-agent");
  assert.equal(value.governance.ref, "main");
});

test("filesystem governance binding rejects absolute machine-specific paths", () => {
  assert.throws(
    () => project.normalizeGovernanceBinding({
      kind: "filesystem",
      locator: "/Users/example/project-agent",
    }),
    (error) => error.code === "ERR_GOVERNANCE_FILESYSTEM_LOCATOR",
  );
});

test("remote ExecutionWorkspaceIdentity does not require worktree_path", () => {
  const value = project.normalizeExecutionWorkspaceIdentity({
    kind: "git-remote",
    workspace_id: "W-REMOTE-1",
    repository_id: "bookmagic-co/demo",
    branch: "feat/x",
    base_revision: "abc",
    head_revision: "def",
    change_request: "pr:42",
    task_id: "T-1",
  });
  assert.equal(value.worktree_path, null);
  assert.equal(value.repository_id, "bookmagic-co/demo");
  assert.equal(value.branch, "feat/x");
});

test("local ExecutionWorkspaceIdentity still requires worktree_path", () => {
  assert.throws(
    () => project.normalizeExecutionWorkspaceIdentity({
      kind: "local-worktree",
      workspace_id: "W-LOCAL-1",
    }),
    (error) => error.code === "ERR_EXECUTION_WORKSPACE_LOCAL_PATH_REQUIRED",
  );
});

test("state classification freezes durable derived ephemeral vocabulary", () => {
  assert.deepEqual(project.STATE_CLASSES, ["durable", "derived", "ephemeral"]);
  assert.equal(project.normalizeStateClass("durable"), "durable");
  assert.throws(
    () => project.normalizeStateClass("runtime"),
    (error) => error.code === "ERR_STATE_CLASS_INVALID",
  );
});

test("RevisionConflict has stable fail-closed error code and revision facts", () => {
  const error = new project.RevisionConflict({
    expected: "R17",
    actual: "R18",
    resource: "task:T-1",
  });
  assert.equal(error.code, "ERR_GOVERNANCE_REVISION_CONFLICT");
  assert.equal(error.expected, "R17");
  assert.equal(error.actual, "R18");
  assert.equal(error.resource, "task:T-1");
});

test("governance lock and runtime resource lease are distinct contracts", () => {
  const lock = project.normalizeGovernanceLockClaim({
    lock_id: "L-1",
    owner_id: "agent:A",
    resource_ref: "file:src/shared.js",
    revision: "R9",
  });
  const lease = project.normalizeRuntimeResourceLease({
    lease_id: "LEASE-1",
    owner_id: "agent:A",
    resource: "port:8787",
    host_id: "host:local",
    expires_at: "2026-10-06T03:00:00Z",
  });
  assert.equal(lock.resource_ref, "file:src/shared.js");
  assert.equal(lock.revision, "R9");
  assert.equal(lease.host_id, "host:local");
  assert.equal(lease.resource, "port:8787");
  assert.equal(Object.prototype.hasOwnProperty.call(lock, "host_id"), false);
});

test("rebind transaction states encode single-authority cutover ordering", () => {
  assert.deepEqual(project.REBIND_TRANSACTION_STATES, [
    "prepare",
    "copy",
    "verify",
    "freeze-old-authority",
    "flip-canonical-binding",
    "verify-new-authority",
    "archive-old-source",
    "completed",
    "rolled-back",
  ]);
});

test("governance store capabilities normalize to explicit booleans", () => {
  const caps = project.normalizeGovernanceStoreCapabilities({
    read: true,
    write: true,
    compare_and_write: true,
    history: true,
  });
  assert.deepEqual(caps, {
    read: true,
    write: true,
    compare_and_write: true,
    append: false,
    history: true,
    watch: false,
  });
});
