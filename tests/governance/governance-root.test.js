"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveGovernanceRoot } = require("../../lib/governance/root");
const {
  upsertBranch,
  getBranch,
  registryPath,
} = require("../../lib/branch/registry");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("embedded local governance resolves project/.agent as the canonical agent root", (t) => {
  const project = tmp("cortex-rdg-embedded-");
  const agent = path.join(project, ".agent");
  fs.mkdirSync(agent);
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const resolved = resolveGovernanceRoot(project);
  assert.equal(resolved.mode, "embedded-local");
  assert.equal(resolved.project_root, fs.realpathSync(project));
  assert.equal(resolved.binding_path, path.join(fs.realpathSync(project), ".agent"));
  assert.equal(resolved.agent_root, fs.realpathSync(agent));
  assert.equal(resolved.materialized, true);
});

test("detached local governance follows a .agent symlink to its canonical root", (t) => {
  const base = tmp("cortex-rdg-detached-");
  const project = path.join(base, "project");
  const detached = path.join(base, "project-agent");
  fs.mkdirSync(project);
  fs.mkdirSync(detached);
  fs.symlinkSync(detached, path.join(project, ".agent"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const resolved = resolveGovernanceRoot(project);
  assert.equal(resolved.mode, "detached-local");
  assert.equal(resolved.agent_root, fs.realpathSync(detached));
  assert.equal(resolved.materialized, true);
});

test("strict resolver fails closed when governance binding is missing", (t) => {
  const project = tmp("cortex-rdg-missing-");
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  assert.throws(
    () => resolveGovernanceRoot(project),
    (error) => error.code === "ERR_GOVERNANCE_BINDING_NOT_FOUND",
  );
});

test("local writers may preserve lazy embedded behavior before .agent materializes", (t) => {
  const project = tmp("cortex-rdg-lazy-");
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const resolved = resolveGovernanceRoot(project, { allow_missing_embedded: true });
  assert.equal(resolved.mode, "embedded-local");
  assert.equal(resolved.materialized, false);
  assert.equal(resolved.agent_root, path.join(fs.realpathSync(project), ".agent"));
});

test("two project workspaces sharing one detached .agent observe the same branch registry", (t) => {
  const base = tmp("cortex-rdg-shared-");
  const detached = path.join(base, "shared-agent");
  const worktreeA = path.join(base, "worktree-a");
  const worktreeB = path.join(base, "worktree-b");
  fs.mkdirSync(detached);
  fs.mkdirSync(worktreeA);
  fs.mkdirSync(worktreeB);
  fs.symlinkSync(detached, path.join(worktreeA, ".agent"));
  fs.symlinkSync(detached, path.join(worktreeB, ".agent"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const created = upsertBranch(worktreeA, {
    name: "feat/shared-state",
    type: "feat",
    status: "active",
  });
  assert.equal(created.ok, true);

  const observed = getBranch(worktreeB, "feat/shared-state");
  assert.equal(observed.ok, true);
  assert.equal(observed.entry.name, "feat/shared-state");
  assert.equal(registryPath(worktreeA), registryPath(worktreeB));
  assert.equal(registryPath(worktreeA), path.join(fs.realpathSync(detached), "branches", "registry.json"));
});
