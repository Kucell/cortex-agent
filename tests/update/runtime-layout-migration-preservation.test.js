"use strict";

// Repository adaptation of six previously exercised synthetic-file oracles.
// This adaptation is NOT_RUN: historical standalone results do not validate it.
// Scope: newly generated migration plans and portable copies only.
// No network, subprocess, Host, real project data, or persisted legacy plans.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const migration = require("../../lib/commands/update/runtime-layout-migration");
const layout = require("../../lib/runtime-layout");

const SOURCE = ".agent-runtime/coordination/tasks.json";
const TARGET = ".agent/runtime/coordination/tasks.json";
const MARKER = ".agent/runtime/layout.json";

function withFixture(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-migration-preservation-"));
  try {
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function put(root, relative, bytes) {
  const file = path.join(root, relative);
  assert.ok(file.startsWith(root + path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function snapshot(root, base = "") {
  const files = {};
  const entries = fs.readdirSync(path.join(root, base), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    assert.equal(entry.isSymbolicLink(), false, "fixture must contain no symlinks");
    const relative = base ? base + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, snapshot(root, relative));
    } else {
      assert.equal(entry.isFile(), true);
      files[relative] = digest(fs.readFileSync(path.join(root, relative)));
    }
  }
  return files;
}

function seedLegacy(root) {
  put(root, SOURCE, '{"tasks":[{"id":"synthetic-old-1","state":"in_progress","legacy_extension":{"note":"keep"}}]}\n');
  put(root, ".agent/user-rule.md", "synthetic user-owned customization\n");
}

function withMarkerFault(root, body) {
  const originalWrite = fs.writeFileSync;
  let markerFaultReached = false;
  fs.writeFileSync = function (file, ...args) {
    if (path.resolve(String(file)) === path.join(root, MARKER)) {
      markerFaultReached = true;
      const error = new Error("SYNTHETIC_ACTIVATION_FAILURE");
      error.code = "EIO";
      throw error;
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    return { result: body(), markerFaultReached };
  } finally {
    fs.writeFileSync = originalWrite;
  }
}

describe("runtime migration portable-copy preservation", { concurrency: 1 }, () => {
  it("preserves nonempty legacy bytes, fallback, and repeated-update contents", () => {
    withFixture((root) => {
      seedLegacy(root);
      const mappings = [
        [SOURCE, TARGET],
        [".agent-runtime/dispatch/journal.jsonl", ".agent/runtime/dispatch/journal.jsonl"],
        [".agent-runtime/cross-project/inbox.json", ".agent/runtime/cross-project/inbox.json"],
        [".agent-runtime/runtime-continuity/state.json", ".agent/runtime/continuity/state.json"],
        [".agent-runtime/runtime-evidence/nested/archive.bin", ".agent/runtime/evidence/nested/archive.bin"],
      ];
      put(root, mappings[1][0], '{"event":"synthetic-checkpoint","seq":4}\n');
      put(root, mappings[2][0], '{"messages":[{"id":"synthetic-old-2"}]}\n');
      put(root, mappings[3][0], '{"cursor":19,"legacy_extension":"keep"}\n');
      put(root, mappings[4][0], Buffer.from([0, 255, 128, 13, 10, 42]));
      const before = snapshot(root);
      const source = path.join(root, SOURCE);
      const target = path.join(root, TARGET);
      const read = (file) => fs.readFileSync(file);
      assert.equal(layout.readWithLegacyFallback(read, target, source).source, "legacy");
      assert.equal(layout.resolveWritePath(target, source, root).mode, "legacy");

      const plan = migration.buildMigrationPlan({ cwd: root }, { dryRun: true });
      assert.deepEqual(snapshot(root), before, "planning must be zero-write");
      const result = migration.applyMigration({ cwd: root }, plan);
      assert.equal(result.ok, true);
      for (const [legacy, current] of mappings) {
        assert.equal(digest(fs.readFileSync(path.join(root, legacy))), before[legacy]);
        assert.equal(digest(fs.readFileSync(path.join(root, current))), before[legacy]);
      }
      assert.equal(digest(fs.readFileSync(path.join(root, ".agent/user-rule.md"))), before[".agent/user-rule.md"]);
      assert.equal(layout.resolveWritePath(target, source, root).mode, "new");
      assert.equal(layout.readWithLegacyFallback(read, target, source).source, "new");

      const migrated = snapshot(root);
      const secondPlan = migration.buildMigrationPlan({ cwd: root }, { dryRun: true });
      assert.equal(secondPlan.is_noop, true);
      assert.equal(migration.applyMigration({ cwd: root }, secondPlan).noop, true);
      assert.deepEqual(snapshot(root), migrated);
    });
  });

  it("honors BLOCK for a divergent pre-existing destination without overwriting", () => {
    withFixture((root) => {
      seedLegacy(root);
      put(root, TARGET, '{"tasks":[{"id":"synthetic-NEWER-DO-NOT-LOSE","state":"done"}]}\n');
      const before = snapshot(root);
      const plan = migration.buildMigrationPlan({ cwd: root });
      assert.equal(plan.actions.find((action) => action.target_ref === TARGET).conflict_policy, "block");
      const result = migration.applyMigration({ cwd: root }, plan);
      assert.equal(result.ok, false, "BLOCK conflict must reject apply");
      assert.deepEqual(snapshot(root), before, "rejection must preserve every original file");
      assert.equal(fs.existsSync(path.join(root, MARKER)), false);
    });
  });

  it("rolls back new copies after activation failure while preserving legacy and unrelated files", () => {
    withFixture((root) => {
      seedLegacy(root);
      put(root, ".agent/runtime/coordination/unrelated.json", '{"synthetic":"pre-existing unrelated state"}\n');
      const before = snapshot(root);
      const plan = migration.buildMigrationPlan({ cwd: root });
      const { result, markerFaultReached } = withMarkerFault(root, () => migration.applyMigration({ cwd: root }, plan));
      assert.equal(markerFaultReached, true, "this case must actually reach activation failure");
      assert.equal(result.ok, false);
      assert.equal(result.rollback.ok, true);
      assert.deepEqual(snapshot(root), before, "rollback must restore original file contents and remove generated files");
      assert.equal(fs.existsSync(path.join(root, MARKER)), false);
    });
  });

  it("preserves a conflicting pre-existing target after failure or early rejection", (t) => {
    withFixture((root) => {
      seedLegacy(root);
      put(root, TARGET, '{"tasks":[{"id":"synthetic-NEWER-DO-NOT-DELETE"}]}\n');
      const before = snapshot(root);
      const plan = migration.buildMigrationPlan({ cwd: root });
      const { result, markerFaultReached } = withMarkerFault(root, () => migration.applyMigration({ cwd: root }, plan));
      t.diagnostic("marker fault reached: " + markerFaultReached + "; early conflict rejection is permitted");
      assert.equal(result.ok, false);
      assert.deepEqual(snapshot(root), before, "pre-existing target must survive rejected or failed migration");
    });
  });

  it("does not overwrite a destination created at the copy boundary", () => {
    withFixture((root) => {
      seedLegacy(root);
      const plan = migration.buildMigrationPlan({ cwd: root });
      const injected = '{"tasks":[{"id":"synthetic-concurrent-writer"}]}\n';
      const originalCopy = fs.copyFileSync;
      let conflictInjected = false;
      let result;
      fs.copyFileSync = function (source, destination, ...args) {
        if (!conflictInjected && path.resolve(String(destination)) === path.join(root, TARGET)) {
          put(root, TARGET, injected);
          conflictInjected = true;
        }
        return originalCopy.call(this, source, destination, ...args);
      };
      try {
        result = migration.applyMigration({ cwd: root }, plan);
      } finally {
        fs.copyFileSync = originalCopy;
      }
      assert.equal(conflictInjected, true);
      assert.equal(result.ok, false, "copy-time conflict must reject");
      assert.equal(fs.existsSync(path.join(root, TARGET)), true);
      assert.equal(fs.readFileSync(path.join(root, TARGET), "utf8"), injected);
      assert.equal(fs.existsSync(path.join(root, MARKER)), false);
    });
  });

  it("removes only owned earlier copies when nested and hyphenated paths precede a late EEXIST", (t) => {
    withFixture((root) => {
      put(root, ".agent-runtime/coordination/00-first.json", '{"id":"synthetic-distinct-first"}\n');
      put(root, ".agent-runtime/coordination/a/b.json", '{"id":"synthetic-nested-source"}\n');
      put(root, ".agent-runtime/coordination/a-b.json", '{"id":"synthetic-flat-source"}\n');
      put(root, ".agent-runtime/dispatch/later.json", '{"id":"synthetic-never-attempted"}\n');
      put(root, ".agent/user-rule.md", "synthetic user-owned customization\n");

      // Derive the later path from the real planner order; never edit the plan.
      const prePlan = migration.buildMigrationPlan({ cwd: root });
      const preCopies = prePlan.actions.filter((action) => action.type === migration.ACTION_TYPES.COPY_RUNTIME_PORTABLE);
      const relatedPaths = preCopies.filter((action) => /\/a(?:\/b|-b)\.json$/.test(action.source_ref));
      assert.equal(relatedPaths.length, 2);
      const conflictTarget = relatedPaths[1].target_ref;
      put(root, conflictTarget, '{"id":"synthetic-preexisting-target-DO-NOT-DELETE"}\n');

      const before = snapshot(root);
      const plan = migration.buildMigrationPlan({ cwd: root });
      assert.deepEqual(snapshot(root), before, "planning must be zero-write");
      const copies = plan.actions.filter((action) => action.type === migration.ACTION_TYPES.COPY_RUNTIME_PORTABLE);
      const conflictIndex = copies.findIndex((action) => action.target_ref === conflictTarget);
      assert.ok(conflictIndex >= 2, "two successful copies must precede EEXIST");
      const successful = copies.slice(0, conflictIndex);
      const idCollisionObserved = successful.some((action) => action.id === copies[conflictIndex].id);
      t.diagnostic("action ID collision observed: " + idCollisionObserved);

      const result = migration.applyMigration({ cwd: root }, plan);
      const after = snapshot(root);
      assert.equal(result.ok, false);
      assert.match(result.errors[0].error, /^EEXIST:/);
      assert.equal(result.rollback.ok, true);
      assert.deepEqual(result.actions_applied, successful.map((action) => action.id));
      for (const action of successful) {
        assert.equal(Object.prototype.hasOwnProperty.call(after, action.target_ref), false, "owned successful copy must be removed");
      }
      for (const [relative, hash] of Object.entries(before)) {
        if (relative !== conflictTarget) assert.equal(after[relative], hash, "legacy and unrelated files must survive");
      }
      assert.equal(fs.existsSync(path.join(root, MARKER)), false);
      assert.equal(after[conflictTarget], before[conflictTarget], "EEXIST target was not created by this apply and must survive rollback");
      assert.deepEqual(result.rollback.rolled_back, successful.map((action) => action.target_ref));
      assert.deepEqual(after, before);
    });
  });
});
