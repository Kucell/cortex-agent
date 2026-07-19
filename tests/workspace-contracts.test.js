"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const RELATIVE_FILES = [
  "workspaces/workspace-identity.schema.json",
  "workspaces/hook-lifecycle.schema.json",
  "workspaces/resource-lease.schema.json",
  "workspaces/composite-workspace.schema.json",
];

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

test("workspace contract schemas parse and keep local/en/zh templates identical", () => {
  const local = path.join(ROOT, ".agent");
  const english = path.join(ROOT, "templates", "en", ".agent");
  const chinese = path.join(ROOT, "templates", "zh", ".agent");

  for (const relative of RELATIVE_FILES) {
    const source = read(local, relative);
    assert.doesNotThrow(() => JSON.parse(source), relative);
    assert.equal(read(english, relative), source, `English template drift: ${relative}`);
    assert.equal(read(chinese, relative), source, `Chinese template drift: ${relative}`);
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
