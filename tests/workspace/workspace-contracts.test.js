"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const RELATIVE_FILES = [
  "workspaces/workspace-identity.schema.json",
  "workspaces/hook-lifecycle.schema.json",
  "workspaces/resource-lease.schema.json",
  "workspaces/composite-workspace.schema.json",
];

// New file added by M-026 MS-001 (runtime-state-layout revision
// `c8e0f0226caca0499ae7a6fa48923b8b5d6e4160d269888115aa51311982c28a`).
// It only needs to be present in `templates/_shared/.agent/workspaces/`;
// parity with `.agent/workspaces/` is enforced by `cortex-agent update`
// in a later milestone, not by this contract test (which would otherwise
// force Pi to edit shared `.agent/` governance data outside its scope).
const RUNTIME_LAYOUT_RELATIVE = "workspaces/runtime-layout.schema.json";

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

test("workspace contract schemas parse and keep local/shared templates identical", () => {
  const local = path.join(ROOT, ".agent");
  const shared = path.join(ROOT, "templates", "_shared", ".agent");

  for (const relative of RELATIVE_FILES) {
    const source = read(local, relative);
    assert.doesNotThrow(() => JSON.parse(source), relative);
    assert.equal(read(shared, relative), source, `Shared template drift: ${relative}`);
  }
});

test("workspace identities bind repository state, owner, relations, and recovery", () => {
  const schema = JSON.parse(read(path.join(ROOT, ".agent"), RELATIVE_FILES[0]));
  for (const required of ["workspace_id", "repository_id", "worktree_path", "branch", "base_commit", "owner", "status"]) {
    assert.ok(schema.required.includes(required));
  }
  assert.equal(schema.properties.workspace_id.pattern.startsWith("^WS-"), true);
  assert.equal(schema.properties.owner.additionalProperties, false);
  assert.equal(schema.properties.relations.additionalProperties, false);
  assert.ok(schema.properties.status.enum.includes("stale"));
  assert.ok(schema.properties.failure.properties.recoverable);
});

test("hook contracts fail closed around authorization, secrets, timeout, and compensation", () => {
  const schema = JSON.parse(read(path.join(ROOT, ".agent"), RELATIVE_FILES[1]));
  const policy = schema.properties.policy;
  assert.deepEqual(schema.properties.phase.enum, ["setup", "run", "teardown"]);
  assert.ok(policy.required.includes("authorization"));
  assert.ok(policy.required.includes("timeout_seconds"));
  assert.ok(policy.required.includes("redact_output"));
  assert.equal(policy.properties.redact_output.const, true);
  assert.ok(policy.properties.authorization.enum.includes("user_decision"));
  assert.ok(schema.properties.status.enum.includes("compensated"));
  assert.ok(schema.properties.evidence_refs);
});

test("resource leases define collision, release, ownership, and external decision gates", () => {
  const schema = JSON.parse(read(path.join(ROOT, ".agent"), RELATIVE_FILES[2]));
  assert.equal(schema.properties.lease_id.pattern.startsWith("^RL-"), true);
  assert.ok(schema.properties.resource_type.enum.includes("port"));
  assert.ok(schema.properties.resource_type.enum.includes("database_namespace"));
  assert.ok(schema.properties.status.enum.includes("conflicted"));
  assert.ok(schema.properties.status.enum.includes("stale"));
  assert.ok(schema.properties.conflicts_with);
  assert.ok(schema.properties.release_reason);
  assert.ok(schema.allOf.some((rule) => rule.if?.properties?.external_side_effect?.const === true));
});

test("composite workspaces preserve independent repositories and non-atomic recovery", () => {
  const schema = JSON.parse(read(path.join(ROOT, ".agent"), RELATIVE_FILES[3]));
  assert.equal(schema.properties.composite_workspace_id.pattern.startsWith("^CWS-"), true);
  assert.equal(schema.properties.members.minItems, 2);
  assert.ok(schema.properties.members.items.required.includes("repository_id"));
  assert.ok(schema.properties.members.items.required.includes("workspace_id"));
  assert.equal(schema.properties.atomic_merge.const, false);
  assert.equal(schema.properties.recovery.properties.strategy.const, "ordered_checkpoints_with_compensation");
  assert.ok(schema.properties.merge_order);
  assert.ok(schema.properties.validation_refs);
});

// ─── M-026 MS-001: runtime-layout workspace descriptor ────────────────────
//
// The runtime-layout descriptor lives next to the existing workspace
// schemas so the workspace contract layer can document which segments of
// `.agent/runtime/` belong to one workspace. It is intentionally
// `additionalProperties: false` and stable-identity-first so it lines up with
// the resolver output (`lib/runtime-layout/`).

test("workspace runtime-layout descriptor lives under shared templates and freezes identity-first references", () => {
  const shared = path.join(ROOT, "templates", "_shared", ".agent");
  const schema = JSON.parse(read(shared, RUNTIME_LAYOUT_RELATIVE));

  assert.equal(schema.title, "Cortex Agent Workspace Runtime Layout");
  for (const required of [
    "workspace_id",
    "repository_id",
    "project_id",
    "machine_id",
    "workspace_instance_id",
    "runtime_dir",
    "host_binding_ref",
    "worktree_instance_ref",
    "portable_namespaces",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(schema.required.includes(required), `runtime-layout descriptor must require ${required}`);
  }
  // Identity-first: workspace_id and project_id are identity strings, not paths.
  assert.equal(schema.properties.workspace_id.pattern.startsWith("^WS-"), true);
  // The descriptor must reference the per-host binding slot via a logical
  // placeholder, never an absolute path. The placeholder is intentional and
  // is the only place "<machine_id>" may appear in a workspace contract.
  assert.ok(schema.properties.host_binding_ref.const.includes("<machine_id>"));
  assert.equal(schema.properties.host_binding_ref.const.includes("/Users/"), false);
  assert.equal(schema.properties.host_binding_ref.const.includes("C:"), false);
  // The per-instance slot uses the same placeholder discipline.
  assert.ok(schema.properties.worktree_instance_ref.const.includes("<workspace_instance_id>"));
  // The legacy root is exposed as a read-only reference; consumers must
  // never write through it.
  assert.equal(schema.properties.legacy_root_ref.const, ".agent-runtime");
});

test("shared templates expose the M-026 runtime-state contracts", () => {
  const shared = path.join(ROOT, "templates", "_shared", ".agent");
  const contractsDir = path.join(shared, "contracts", "runtime-state");
  const expected = [
    "README.md",
    "identity-record.schema.json",
    "logical-uri.schema.json",
    "local-binding.schema.json",
    "runtime-layout.schema.json",
  ];
  for (const relative of expected) {
    const file = path.join(contractsDir, relative);
    assert.equal(fs.existsSync(file), true, `${relative} must exist in shared runtime-state contracts`);
    if (relative.endsWith(".json")) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), relative);
    }
  }

  const layoutSchema = JSON.parse(fs.readFileSync(path.join(contractsDir, "runtime-layout.schema.json"), "utf8"));
  assert.equal(layoutSchema.properties.segments.properties.legacy_runtime.const, ".agent-runtime");
  assert.equal(layoutSchema.properties.segments.properties.contracts_runtime_state.const, "contracts/runtime-state");
  assert.equal(layoutSchema.properties.segments.properties.runtime_dir.const, "runtime");
  assert.ok(layoutSchema.properties.portable_namespaces.items.enum.includes("coordination"));
  assert.ok(layoutSchema.properties.portable_namespaces.items.enum.includes("evidence"));
  assert.equal(layoutSchema.properties.legacy_recognised_segments.items.enum.includes("runtime-continuity"), true);

  const identitySchema = JSON.parse(fs.readFileSync(path.join(contractsDir, "identity-record.schema.json"), "utf8"));
  assert.ok(identitySchema.properties.kind.enum.includes("project_id"));
  assert.ok(identitySchema.properties.kind.enum.includes("workspace_instance_id"));

  const uriSchema = JSON.parse(fs.readFileSync(path.join(contractsDir, "logical-uri.schema.json"), "utf8"));
  assert.deepEqual(
    new Set(uriSchema.properties.scheme.enum),
    new Set(["project", "repo", "workspace", "agent", "runtime", "artifact"]),
  );

  const bindingSchema = JSON.parse(fs.readFileSync(path.join(contractsDir, "local-binding.schema.json"), "utf8"));
  assert.equal(bindingSchema.properties.machine_id.maxLength, 64);
  assert.ok(bindingSchema.properties.bindings.items.required.includes("workspace_id"));
  assert.ok(bindingSchema.properties.bindings.items.required.includes("absolute_path"));
});