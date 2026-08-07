"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  SCHEMA_VERSION,
  VALID_STATUSES,
  VALID_TYPES,
  defaultRegistry,
  registryPath,
  readRegistry,
  writeRegistry,
  listBranches,
  getBranch,
  upsertBranch,
  updateBranch,
  removeBranch,
} = require("../../lib/branch-registry");

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-branch-registry-"));
}

// ─── Constants & defaults ────────────────────────────────────────────────────

test("branch-registry: SCHEMA_VERSION is 1", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("branch-registry: defaultRegistry has empty branches + updated_at", () => {
  const r = defaultRegistry();
  assert.equal(r.schema_version, 1);
  assert.deepEqual(r.branches, {});
  assert.ok(r.updated_at);
});

test("branch-registry: registryPath joins .agent/branches/registry.json", () => {
  const p = registryPath("/tmp/proj");
  assert.equal(p, "/tmp/proj/.agent/branches/registry.json");
});

test("branch-registry: VALID_STATUSES contains active/merge_ready/merged/archived", () => {
  assert.deepEqual(VALID_STATUSES, ["active", "merge_ready", "merged", "archived"]);
});

test("branch-registry: VALID_TYPES contains feat/fix/release/hotfix/chore", () => {
  assert.deepEqual(VALID_TYPES, ["feat", "fix", "release", "hotfix", "chore"]);
});

// ─── readRegistry ────────────────────────────────────────────────────────────

test("branch-registry: readRegistry creates missing registry by default", () => {
  const cwd = project();
  const r = readRegistry(cwd);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.deepEqual(r.registry.branches, {});
});

test("branch-registry: readRegistry returns missing error when createIfMissing=false", () => {
  const cwd = project();
  const r = readRegistry(cwd, { createIfMissing: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, "registry_missing");
});

test("branch-registry: readRegistry returns existing valid registry", () => {
  const cwd = project();
  const reg = defaultRegistry();
  reg.branches["feat/x"] = { name: "feat/x", type: "feat", status: "active" };
  writeRegistry(cwd, reg);
  const r = readRegistry(cwd, { createIfMissing: false });
  assert.equal(r.ok, true);
  assert.equal(r.recovered, false);
  assert.equal(r.registry.branches["feat/x"].name, "feat/x");
});

// ─── writeRegistry ───────────────────────────────────────────────────────────

test("branch-registry: writeRegistry writes valid JSON file", () => {
  const cwd = project();
  const reg = defaultRegistry();
  reg.branches["feat/test"] = { name: "feat/test", type: "feat", status: "active" };
  const w = writeRegistry(cwd, reg);
  assert.equal(w.ok, true);
  const written = fs.readFileSync(registryPath(cwd), "utf8");
  const parsed = JSON.parse(written);
  assert.equal(parsed.branches["feat/test"].name, "feat/test");
});

test("branch-registry: writeRegistry updates updated_at on each write", async () => {
  const cwd = project();
  writeRegistry(cwd, defaultRegistry());
  const before = JSON.parse(fs.readFileSync(registryPath(cwd), "utf8")).updated_at;
  await new Promise((resolve) => setTimeout(resolve, 15));
  writeRegistry(cwd, defaultRegistry());
  const after = JSON.parse(fs.readFileSync(registryPath(cwd), "utf8")).updated_at;
  assert.notEqual(before, after);
});

test("branch-registry: atomic write uses tmp+rename (no leftover tmp)", () => {
  const cwd = project();
  writeRegistry(cwd, defaultRegistry());
  const files = fs.readdirSync(path.join(cwd, ".agent", "branches"));
  const tmpFiles = files.filter((f) => f.includes(".tmp-"));
  assert.equal(tmpFiles.length, 0);
});

test("branch-registry: writeRegistry creates parent dir", () => {
  const cwd = project();
  assert.equal(fs.existsSync(path.join(cwd, ".agent", "branches")), false);
  writeRegistry(cwd, defaultRegistry());
  assert.ok(fs.existsSync(path.join(cwd, ".agent", "branches")));
});

// ─── corrupt recovery ────────────────────────────────────────────────────────

test("branch-registry: readRegistry recovers from corrupt JSON by backing up", () => {
  const cwd = project();
  const target = registryPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{not valid json", "utf8");
  const r = readRegistry(cwd);
  assert.equal(r.ok, true);
  assert.equal(r.recovered, true);
  assert.ok(r.backup);
  assert.ok(fs.existsSync(r.backup));
  // registry should now be valid empty schema
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(parsed.branches, {});
});

test("branch-registry: readRegistry recovers from invalid shape (no branches key)", () => {
  const cwd = project();
  const target = registryPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ schema_version: 1, no_branches: true }), "utf8");
  const r = readRegistry(cwd);
  assert.equal(r.ok, true);
  assert.equal(r.recovered, true);
});

test("branch-registry: readRegistry without recovery returns corrupt error", () => {
  const cwd = project();
  const target = registryPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{not valid json", "utf8");
  const r = readRegistry(cwd, { recover: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, "registry_corrupt");
});

test("branch-registry: readRegistry without recovery returns shape error", () => {
  const cwd = project();
  const target = registryPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ schema_version: 1 }), "utf8");
  const r = readRegistry(cwd, { recover: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, "registry_shape_invalid");
});

// ─── listBranches ────────────────────────────────────────────────────────────

test("branch-registry: listBranches returns empty array on missing registry", () => {
  const cwd = project();
  const r = listBranches(cwd);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries, []);
});

test("branch-registry: listBranches returns all entries on empty filter", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/a", type: "feat" });
  upsertBranch(cwd, { name: "fix/b", type: "fix" });
  const r = listBranches(cwd);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
});

test("branch-registry: listBranches filters by type", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/a", type: "feat" });
  upsertBranch(cwd, { name: "fix/b", type: "fix" });
  const r = listBranches(cwd, { type: "feat" });
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].type, "feat");
});

test("branch-registry: listBranches filters by status", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/a", type: "feat", status: "active" });
  upsertBranch(cwd, { name: "feat/b", type: "feat", status: "merged" });
  const r = listBranches(cwd, { status: "merged" });
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
});

test("branch-registry: listBranches filters by missionId", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/a", type: "feat", mission_id: "M-016" });
  upsertBranch(cwd, { name: "feat/b", type: "feat", mission_id: "M-002" });
  const r = listBranches(cwd, { missionId: "M-016" });
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
});

// ─── getBranch ───────────────────────────────────────────────────────────────

test("branch-registry: getBranch returns entry", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/test", type: "feat" });
  const r = getBranch(cwd, "feat/test");
  assert.equal(r.ok, true);
  assert.equal(r.entry.name, "feat/test");
});

test("branch-registry: getBranch returns not_found", () => {
  const cwd = project();
  const r = getBranch(cwd, "feat/missing");
  assert.equal(r.ok, false);
  assert.equal(r.error, "branch_not_found");
});

// ─── upsertBranch ────────────────────────────────────────────────────────────

test("branch-registry: upsertBranch creates a new entry", () => {
  const cwd = project();
  const r = upsertBranch(cwd, {
    name: "feat/branch-management",
    type: "feat",
    base_branch: "main",
    base_commit: "abc123",
    proposal_ref: ".agent/plans/proposals/cortex-agent-branch-management-proposal.md",
    mission_id: "M-016",
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.entry.name, "feat/branch-management");
  assert.equal(r.entry.status, "active");
  assert.equal(r.entry.commits_ahead, 0);
  assert.equal(r.entry.mission_id, "M-016");
});

test("branch-registry: upsertBranch updates existing entry (preserves created_at)", () => {
  const cwd = project();
  const first = upsertBranch(cwd, { name: "feat/test", type: "feat" });
  const before = first.entry.created_at;
  const r = upsertBranch(cwd, { name: "feat/test", type: "feat", commits_ahead: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(r.entry.commits_ahead, 5);
  assert.equal(r.entry.created_at, before);
});

test("branch-registry: upsertBranch rejects invalid branch name", () => {
  const cwd = project();
  const r = upsertBranch(cwd, { name: "feature/bad-prefix", type: "feat" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_branch_name");
});

test("branch-registry: upsertBranch rejects invalid type", () => {
  const cwd = project();
  const r = upsertBranch(cwd, { name: "feat/x", type: "feature" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_branch_type");
});

test("branch-registry: upsertBranch rejects invalid status", () => {
  const cwd = project();
  const r = upsertBranch(cwd, { name: "feat/x", type: "feat", status: "weird" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_branch_status");
});

test("branch-registry: upsertBranch rejects non-object entry", () => {
  const cwd = project();
  assert.equal(upsertBranch(cwd, null).ok, false);
});

// ─── updateBranch ────────────────────────────────────────────────────────────

test("branch-registry: updateBranch patches fields and preserves created_at + type", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/test", type: "feat" });
  const before = getBranch(cwd, "feat/test").entry;
  const r = updateBranch(cwd, "feat/test", { commits_ahead: 3, status: "merge_ready" });
  assert.equal(r.ok, true);
  assert.equal(r.entry.commits_ahead, 3);
  assert.equal(r.entry.status, "merge_ready");
  assert.equal(r.entry.created_at, before.created_at);
  assert.equal(r.entry.type, "feat"); // type cannot be changed
});

test("branch-registry: updateBranch returns not_found", () => {
  const cwd = project();
  const r = updateBranch(cwd, "feat/missing", { commits_ahead: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "branch_not_found");
});

test("branch-registry: updateBranch rejects non-object patch", () => {
  const cwd = project();
  assert.equal(updateBranch(cwd, "feat/x", null).ok, false);
});

// ─── removeBranch ────────────────────────────────────────────────────────────

test("branch-registry: removeBranch soft-archives by default", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/test", type: "feat" });
  const r = removeBranch(cwd, "feat/test");
  assert.equal(r.ok, true);
  assert.equal(r.archived, true);
  const after = getBranch(cwd, "feat/test");
  assert.equal(after.ok, true);
  assert.equal(after.entry.status, "archived");
});

test("branch-registry: removeBranch with hard:true deletes entry", () => {
  const cwd = project();
  upsertBranch(cwd, { name: "feat/test", type: "feat" });
  const r = removeBranch(cwd, "feat/test", { hard: true });
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  const after = getBranch(cwd, "feat/test");
  assert.equal(after.ok, false);
});

test("branch-registry: removeBranch returns not_found", () => {
  const cwd = project();
  const r = removeBranch(cwd, "feat/missing");
  assert.equal(r.ok, false);
  assert.equal(r.error, "branch_not_found");
});

// ─── round-trip ──────────────────────────────────────────────────────────────

test("branch-registry: round-trip — upsert then read returns same data", () => {
  const cwd = project();
  const entry = {
    name: "feat/branch-management",
    type: "feat",
    base_branch: "main",
    base_commit: "deadbeef",
    proposal_ref: ".agent/plans/proposals/cortex-agent-branch-management-proposal.md",
    mission_id: "M-016",
    purpose: "M-016 implementation",
  };
  upsertBranch(cwd, entry);
  const r = readRegistry(cwd);
  assert.equal(r.ok, true);
  const stored = r.registry.branches["feat/branch-management"];
  assert.equal(stored.mission_id, "M-016");
  assert.equal(stored.purpose, "M-016 implementation");
  assert.equal(stored.base_commit, "deadbeef");
});

test("branch-registry: round-trip — preserves shipped array", () => {
  const cwd = project();
  const ship = [{ commit: "abc123", summary: "feat: x" }];
  upsertBranch(cwd, { name: "feat/x", type: "feat", shipped: ship });
  const r = readRegistry(cwd);
  assert.equal(r.ok, true);
  assert.deepEqual(r.registry.branches["feat/x"].shipped, ship);
});
