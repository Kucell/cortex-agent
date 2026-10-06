"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { ensureProjectDescriptor, readDescriptor } = require("../../lib/governance/lifecycle");
const {
  classifyMigrationPath,
  buildMigrationManifest,
  migrateEmbeddedToDetached,
  seedManifestToGit,
} = require("../../lib/governance/migration");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governance-migration-"));
  const agent = path.join(root, ".agent");
  fs.mkdirSync(path.join(agent, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(agent, "runtime", "hosts", "machine"), { recursive: true });
  fs.mkdirSync(path.join(agent, "rules"), { recursive: true });
  fs.writeFileSync(path.join(agent, "tasks", "T-1.json"), JSON.stringify({ task_id: "T-1" }) + "\n");
  fs.writeFileSync(path.join(agent, "runtime", "hosts", "machine", "state.json"), "{}\n");
  fs.writeFileSync(path.join(agent, "rules", "project.md"), "# rules\n");
  ensureProjectDescriptor(root);
  return root;
}

test("migration classification reuses M-042 state registry", () => {
  assert.equal(classifyMigrationPath("tasks/T-1.json").state_class, "durable");
  assert.equal(classifyMigrationPath("decisions/index.json").state_class, "derived");
  assert.equal(classifyMigrationPath("runtime/hosts/machine/state.json").state_class, "ephemeral");
  assert.equal(classifyMigrationPath("rules/project.md").state_class, "durable");
});

test("manifest skips machine-local runtime and includes durable framework state", (t) => {
  const root = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = buildMigrationManifest(path.join(root, ".agent"));
  assert.ok(manifest.included.some((x) => x.path === "tasks/T-1.json"));
  assert.ok(manifest.included.some((x) => x.path === "rules/project.md"));
  assert.ok(manifest.skipped.some((x) => x.path === "runtime/hosts/machine/state.json"));
});

test("embedded to detached migration copies verifies cuts over and archives old authority", (t) => {
  const root = project();
  const target = path.join(root, "project-agent");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = migrateEmbeddedToDetached(root, target);
  assert.equal(result.ok, true);
  assert.equal(result.journal.state, "completed");
  assert.equal(fs.lstatSync(path.join(root, ".agent")).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(root, ".agent")), fs.realpathSync(target));
  assert.equal(fs.existsSync(result.archive_path), true);
  assert.equal(fs.existsSync(path.join(target, "tasks", "T-1.json")), true);
  assert.equal(fs.existsSync(path.join(target, "runtime", "hosts", "machine", "state.json")), false);
  assert.equal(readDescriptor(root).governance.locator, "project-agent");
});

test("git seed verifies migrated durable state in a bare repository", (t) => {
  const root = project();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governance-migration-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", "--bare"], { cwd: repo }).status, 0);

  const manifest = buildMigrationManifest(path.join(root, ".agent"));
  const result = seedManifestToGit(manifest, repo);
  assert.equal(result.ok, true);
  assert.ok(result.revision && result.revision.value);
  assert.equal(result.files, manifest.included.length);
});
