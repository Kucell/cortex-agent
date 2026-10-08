"use strict";

// ─── local-publish-validate preflight: dirty working tree ────────────────────
//
// The dirty-tree guard, `--force`, and `--skip-commit` shipped in the initial
// commit (629555f) with zero test coverage. The workflow doc claimed
// `--skip-commit` permitted a dirty tree while the script refused it, and
// nothing caught the contradiction for the life of the feature.
//
// These tests pin the contract that the code actually implements:
//   - a dirty tree is blocked
//   - --skip-commit does NOT bypass the block (it only skips commit + tag)
//   - --force is the single, explicit opt-in
//
// The guard exits before any npm / volta / git mutation, so the script is run
// for real — but always from a throwaway git repo, never the developer's.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, describe, beforeEach, afterEach } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "bin", "local-publish-validate.cjs");

let repo;

function git(args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function makeCleanRepo() {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lpv-"));
  git(["init", "-q"]);
  git(["config", "user.email", "lpv@test"]);
  git(["config", "user.name", "lpv"]);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "lpv-fixture", version: "0.0.0" }));
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
}

function dirty() {
  fs.writeFileSync(path.join(repo, "uncommitted.txt"), "dirty\n");
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { ...r, out: (r.stdout || "") + (r.stderr || "") };
}

beforeEach(() => makeCleanRepo());
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("local-publish-validate — dirty tree preflight", () => {
  test("blocks a dirty tree", () => {
    dirty();
    const r = run(["--skip-tests"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Working tree is dirty/);
  });

  test("--skip-commit alone does NOT bypass the block", () => {
    dirty();
    const r = run(["--skip-commit", "--skip-tests"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Working tree is dirty/);
  });

  test("the block message says --skip-commit does not bypass it", () => {
    dirty();
    const r = run(["--skip-commit", "--skip-tests"]);
    assert.match(
      r.out,
      /--skip-commit does not bypass/,
      "the old message implied --skip-commit should have been enough",
    );
  });

  test("the block message points at --force", () => {
    dirty();
    const r = run(["--skip-tests"]);
    assert.match(r.out, /--force/, "the escape hatch must be named");
  });

  test("--force is accepted for a dirty tree", () => {
    dirty();
    // --dry-run short-circuits the preflight, so assert on the plan instead of
    // letting a real pack run from a fixture package.
    const r = run(["--force", "--skip-commit", "--skip-tests", "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Working tree is dirty/);
  });

  test("a clean tree produces no dirty-tree complaint", () => {
    const r = run(["--skip-tests", "--dry-run"]);
    assert.doesNotMatch(r.out, /Working tree is dirty/);
  });

  test("dry-run warns that a real run would need --force", () => {
    dirty();
    const r = run(["--skip-tests", "--dry-run"]);
    assert.match(r.out, /would need --force/);
  });
});
