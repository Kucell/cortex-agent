"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { ensureProjectDescriptor, readDescriptor } = require("../../lib/governance/lifecycle");
const {
  stateClassForEntry,
  classifyMigrationPath,
  buildMigrationManifest,
  migrateEmbeddedToDetached,
  seedManifestToGit,
  readJournal,
} = require("../../lib/governance/migration");

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rdg-migration-"));
  const project = path.join(base, "project");
  const detached = path.join(base, "project-agent");
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, ".agent", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agent", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agent", "runtime", "hosts", "machine-a"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agent", "tasks", "T-1.json"), '{"task_id":"T-1"}\n');
  fs.writeFileSync(path.join(project, ".agent", "decisions", "index.json"), '{"items":[]}\n');
  fs.writeFileSync(path.join(project, ".agent", "runtime", "hosts", "machine-a", "state.json"), '{"pid":1}\n');
  ensureProjectDescriptor(project, { project_id: "cortex-project-migration-fixture" });
  return { base, project, detached };
}

test("state registry mapping produces durable derived and ephemeral migration classes", () => {
  assert.equal(classifyMigrationPath("tasks/T-1.json").state_class, "durable");
  assert.equal(classifyMigrationPath("decisions/index.json").state_class, "derived");
  assert.equal(classifyMigrationPath("runtime/hosts/machine-a/state.json").state_class, "ephemeral");
  assert.equal(stateClassForEntry({ sync_policy: "ignored", runtime_scope: "portable" }), "ephemeral");
});

test("manifest excludes machine-local runtime but includes durable and derived state", (t) => {
  const { base, project } = fixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const manifest = buildMigrationManifest(path.join(project, ".agent"));
  assert.deepEqual(manifest.included.map((item) => item.path).sort(), [
    "decisions/index.json",
    "tasks/T-1.json",
  ]);
  assert.deepEqual(manifest.skipped.map((item) => item.path), [
    "runtime/hosts/machine-a/state.json",
  ]);
});

test("embedded filesystem migration cuts over to sibling detached authority", (t) => {
  const { base, project, detached } = fixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const result = migrateEmbeddedToDetached(project, detached);
  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(path.join(project, ".agent")).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(project, ".agent")), fs.realpathSync(detached));
  assert.equal(fs.existsSync(path.join(detached, "tasks", "T-1.json")), true);
  assert.equal(fs.existsSync(path.join(detached, "runtime", "hosts", "machine-a", "state.json")), false);
  assert.equal(fs.existsSync(result.archive_path), true);
  assert.deepEqual(readDescriptor(project).governance, {
    kind: "filesystem",
    locator: "../project-agent",
    ref: null,
  });
  assert.equal(result.journal.state, "completed");
});

test("failure after freeze rolls back original authority and descriptor", (t) => {
  const { base, project, detached } = fixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  assert.throws(
    () => migrateEmbeddedToDetached(project, detached, { fail_at: "after-freeze" }),
    (error) => error.code === "ERR_GOVERNANCE_MIGRATION_INJECTED_FAILURE",
  );
  assert.equal(fs.lstatSync(path.join(project, ".agent")).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(project, ".agent", "tasks", "T-1.json")), true);
  assert.deepEqual(readDescriptor(project).governance, {
    kind: "filesystem",
    locator: ".agent",
    ref: null,
  });

  const journalDir = path.join(project, ".cortex-governance-migrations");
  const journalFile = fs.readdirSync(journalDir).find((name) => name.endsWith(".json"));
  const journal = JSON.parse(fs.readFileSync(path.join(journalDir, journalFile), "utf8"));
  assert.equal(journal.state, "rolled-back");
});

test("rolled-back migration journal can resume with the same migration id", (t) => {
  const { base, project, detached } = fixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  try {
    migrateEmbeddedToDetached(project, detached, { fail_at: "after-freeze" });
  } catch (_) {}

  const journalDir = path.join(project, ".cortex-governance-migrations");
  const journalFile = fs.readdirSync(journalDir).find((name) => name.endsWith(".json"));
  const migrationId = journalFile.replace(/\.json$/, "");
  assert.equal(readJournal(project, migrationId).state, "rolled-back");

  const resumed = migrateEmbeddedToDetached(project, detached, { resume_migration_id: migrationId });
  assert.equal(resumed.journal.migration_id, migrationId);
  assert.equal(resumed.journal.state, "completed");
});

test("manifest seeds and verifies a locally accessible bare Git governance store", (t) => {
  const { base, project } = fixture();
  const repo = path.join(base, "governance.git");
  fs.mkdirSync(repo);
  const init = spawnSync("git", ["init", "-q", "--bare"], { cwd: repo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const manifest = buildMigrationManifest(path.join(project, ".agent"));
  const result = seedManifestToGit(manifest, repo);
  assert.equal(result.ok, true);
  assert.equal(result.files, 2);
  assert.ok(result.revision && result.revision.value);
});

test("unclassified state fails closed by default", (t) => {
  const { base, project } = fixture();
  fs.writeFileSync(path.join(project, ".agent", "mystery.bin"), "x");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  assert.throws(
    () => buildMigrationManifest(path.join(project, ".agent")),
    (error) => error.code === "ERR_GOVERNANCE_MIGRATION_UNCLASSIFIED",
  );
});
