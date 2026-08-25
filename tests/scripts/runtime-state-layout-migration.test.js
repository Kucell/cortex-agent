"use strict";

// ─── runtime-state-layout-migration tests ──────────────────────────────────
// Validates the rollback dry-run helper used by preflight's G-Rollback gate.
// Tests use a real git repository (a temporary clone of this repo) so the
// git ls-tree / git show paths are exercised end-to-end.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

// tests/scripts/runtime-state-layout-migration.test.js sits at:
//   <repo>/tests/scripts/runtime-state-layout-migration.test.js
// SCRIPT is at:
//   <repo>/templates/_shared/.agent/skills/management-api/scripts/runtime-state-layout-migration.js
// So ROOT = __dirname/../.. (tests/scripts → repo root).
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "templates/_shared/.agent/skills/management-api/scripts/runtime-state-layout-migration.js");

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mig-"));
  // Initialize an empty repo so we control the history precisely.
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  // Mirror the relevant subtree from ROOT so the script can read it.
  const sub = "templates/_shared/.agent/contracts/runtime-state";
  const dst = path.join(root, sub);
  fs.mkdirSync(dst, { recursive: true });
  // v1: 2 contracts + the runtime-layout schema that references identity-record
  fs.writeFileSync(path.join(dst, "identity-record.schema.json"), `{ "schema": "identity-record" }\n`);
  fs.writeFileSync(path.join(dst, "logical-uri.schema.json"), `{ "schema": "logical-uri" }\n`);
  fs.writeFileSync(path.join(dst, "runtime-layout.schema.json"), JSON.stringify({ $ref: "identity-record.schema.json" }));
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "v1: 2 contracts + layout"], { cwd: root });
  // v2: add a third contract AND update runtime-layout to reference local-binding
  fs.writeFileSync(path.join(dst, "local-binding.schema.json"), `{ "schema": "local-binding" }\n`);
  fs.writeFileSync(path.join(dst, "runtime-layout.schema.json"), JSON.stringify({ $ref: "local-binding.schema.json" }));
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "v2: +local-binding, layout now references it"], { cwd: root });
  return root;
}

function run(extraArgs, repo) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: repo,
    encoding: "utf8",
  });
}

// ─── TC-001: --help prints usage ────────────────────────────────────────────
test("TC-001: --help prints usage and exits 0", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: runtime-state-layout-migration/);
  assert.match(result.stdout, /rollback/);
});

// ─── TC-002: rollback dry-run reports plan with counts ─────────────────────
// For rollback HEAD → HEAD~1: the local-binding contract was added in HEAD,
// so it appears as `added` (would be reverted away).
test("TC-002: rollback HEAD → HEAD~1 reports plan with counts", () => {
  const repo = tempRepo();
  const result = run(["rollback", "--from-policy-revision", "HEAD", "--to", "HEAD~1", "--dry-run"], repo);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "rollback");
  assert.equal(plan.dry_run, true);
  assert.equal(plan.counts.added, 1, `plan=${JSON.stringify(plan)}`);
  assert.ok(plan.added[0].includes("local-binding.schema.json"), `plan.added=${JSON.stringify(plan.added)}`);
  assert.equal(plan.counts.changed, 1);
});

// ─── TC-003: forward plan from v1 → v2 reports adds ────────────────────────
// Forward: source = HEAD~1, dest = HEAD. Adds in dest appear as `added`.
test("TC-003: forward HEAD~1 → HEAD reports plan with added contracts", () => {
  const repo = tempRepo();
  const result = run(["forward", "--from", "HEAD~1", "--to", "HEAD", "--dry-run"], repo);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "forward");
  assert.equal(plan.counts.added, 1);
  assert.ok(plan.added[0].includes("local-binding.schema.json"));
});

// ─── TC-004: no_op when source === dest ─────────────────────────────────────
test("TC-004: identical revisions return no_op=true", () => {
  const repo = tempRepo();
  const result = run(["rollback", "--from-policy-revision", "HEAD", "--to", "HEAD", "--dry-run"], repo);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.ok, true);
  assert.equal(plan.no_op, true);
});

// ─── TC-005: missing revision exits with non-zero status ──────────────────
test("TC-005: revision_not_found surfaces as exit 1", () => {
  const repo = tempRepo();
  const result = run(["rollback", "--from-policy-revision", "HEAD", "--to", "nonexistent-revision-xyz", "--dry-run"], repo);
  assert.equal(result.status, 1);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "revision_not_found");
});