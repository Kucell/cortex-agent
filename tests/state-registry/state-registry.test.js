"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  readRegistry,
  validateRegistry,
  classifyStatePath,
  isSyncableStatePath,
  syncablePathspecs,
  registrySummary,
} = require("../../lib/state-registry");

test("builtin registry validates and reports policy summary", () => {
  const registry = readRegistry();
  assert.equal(registry.schema_version, "1.0");
  assert.ok(registry.classes.length >= 20);
  const summary = registrySummary(registry);
  assert.ok(summary.policies.tracked > 0);
  assert.ok(summary.policies.local > 0);
  assert.ok(summary.policies.derived > 0);
  assert.ok(summary.policies.evidence > 0);
  assert.ok(summary.policies.legacy > 0);
});

test("classification prefers the most specific state class", () => {
  const registry = readRegistry();
  assert.equal(classifyStatePath("decisions/index.json", registry).id, "governance.decisions.index");
  assert.equal(classifyStatePath("decisions/D-1.json", registry).id, "governance.decisions");
  assert.equal(classifyStatePath(".agent/waitpoints/index.json", registry).id, "governance.waitpoints.index");
});

test("sync policy includes tracked/derived and excludes local/evidence/legacy", () => {
  const registry = readRegistry();
  assert.equal(isSyncableStatePath("operations/O-1.json", registry), true);
  assert.equal(isSyncableStatePath("decisions/index.json", registry), true);
  assert.equal(isSyncableStatePath("runtime/hosts/machine/state.json", registry), false);
  assert.equal(isSyncableStatePath("runtime-evidence/foo/run.json", registry), false);
  assert.equal(isSyncableStatePath("runtime-continuity/events/e.json", registry), false);
});

test("syncable pathspecs are derived from registry", () => {
  const specs = syncablePathspecs(readRegistry());
  assert.ok(specs.directories.includes("decisions"));
  assert.ok(specs.directories.includes("operations"));
  assert.ok(specs.directories.includes("runtime/coordination"));
  assert.equal(specs.directories.includes("runtime/hosts"), false);
  assert.ok(specs.files.includes("branches/registry.json"));
  assert.equal(specs.files.includes("decisions/index.json"), false, "covered by decisions directory");
});

test("registry validation rejects duplicate paths", () => {
  assert.throws(() => validateRegistry({
    schema_version: "1.0",
    classes: [
      { id: "a", path: "x", kind: "directory", authority: "a", sync_policy: "tracked", runtime_scope: "portable", rebuildable: false },
      { id: "b", path: "x", kind: "directory", authority: "b", sync_policy: "local", runtime_scope: "portable", rebuildable: false },
    ],
  }), /duplicate path/);
});
