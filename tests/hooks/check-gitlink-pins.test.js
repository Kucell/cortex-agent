"use strict";

// Tests for scripts/check-gitlink-pins.js.
//
// The gate exists because the release acceptance workflows compare the
// `.agent` blob inside the packed tarball with EXPECTED_GITLINK. A gitlink
// bump without a matching pin turns those jobs red for a reason that has
// nothing to do with the product, so the invariant "pin == staged `.agent`
// gitlink" is enforced at commit time.
//
// Every case runs against a scratch git repository so the suite never touches
// the real checkout. A real submodule is not needed: `git update-index
// --cacheinfo 160000,<sha>,.agent` produces the same index entry.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, describe, beforeEach, afterEach } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CHECKER = path.join(ROOT, "scripts", "check-gitlink-pins.js");

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";
const SHA_C = "3333333333333333333333333333333333333333";

let scratch;

function git(args, cwd = scratch) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function runChecker(args = []) {
  return spawnSync(process.execPath, [CHECKER, ...args, "--root", scratch], {
    encoding: "utf8",
  });
}

function writePinFile(rel, sha, extra = "") {
  const abs = path.join(scratch, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    [
      "name: acceptance",
      "jobs:",
      "  build:",
      "    steps:",
      `      EXPECTED_GITLINK: ${sha}`,
      extra,
      "      - run: echo done",
      "",
    ].join("\n")
  );
  return abs;
}

function stageGitlink(sha) {
  git(["update-index", "--add", "--cacheinfo", `160000,${sha},.agent`]);
}

function readPin(rel) {
  const text = fs.readFileSync(path.join(scratch, rel), "utf8");
  const m = text.match(/EXPECTED_GITLINK:\s*([0-9a-f]{40})/);
  return m ? m[1] : null;
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gitlink-pins-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["config", "commit.gpgsign", "false"]);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("check-gitlink-pins", () => {
  test("no .agent gitlink in the index → no-op", () => {
    writePinFile(".github/workflows/offline-package-acceptance.yml", SHA_B);
    git(["add", "-A"]);
    const r = runChecker();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /未检测到 \.agent gitlink/);
    assert.equal(readPin(".github/workflows/offline-package-acceptance.yml"), SHA_B);
  });

  test("pin equal to the staged gitlink → no-op", () => {
    writePinFile(".github/workflows/offline-package-acceptance.yml", SHA_A);
    git(["add", ".github"]);
    stageGitlink(SHA_A);
    const r = runChecker();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /一致/);
  });

  test("drifted pin is rewritten to the staged gitlink and re-staged", () => {
    const rel = ".github/workflows/offline-package-acceptance.yml";
    writePinFile(rel, SHA_B);
    git(["add", ".github"]);
    stageGitlink(SHA_A);
    const r = runChecker();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /已同步到 \.agent 指针/);
    // Working tree rewritten…
    assert.equal(readPin(rel), SHA_A);
    // …and the index rewritten too, so the commit ships the aligned pin.
    const staged = git(["show", `:${rel}`]);
    assert.match(staged, new RegExp(`EXPECTED_GITLINK: ${SHA_A}`));
  });

  test("every pin file is aligned, not just the first", () => {
    const a = ".github/workflows/offline-package-acceptance.yml";
    const b = ".github/workflows/registry-upgrade-acceptance.yml";
    writePinFile(a, SHA_B);
    writePinFile(b, SHA_B);
    git(["add", ".github"]);
    stageGitlink(SHA_C);
    const r = runChecker();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readPin(a), SHA_C);
    assert.equal(readPin(b), SHA_C);
  });

  test("multiple EXPECTED_GITLINK lines in one file are all aligned", () => {
    const rel = ".github/workflows/offline-package-acceptance.yml";
    writePinFile(rel, SHA_B, `      SECOND_PIN: yes\n      EXPECTED_GITLINK: ${SHA_C}\n`);
    git(["add", ".github"]);
    stageGitlink(SHA_A);
    const r = runChecker();
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(path.join(scratch, rel), "utf8");
    assert.equal((text.match(new RegExp(SHA_A, "g")) || []).length, 2);
  });

  test("--check reports drift and exits non-zero without writing", () => {
    const rel = ".github/workflows/offline-package-acceptance.yml";
    writePinFile(rel, SHA_B);
    git(["add", ".github"]);
    stageGitlink(SHA_A);
    const r = runChecker(["--check"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不一致/);
    assert.equal(readPin(rel), SHA_B, "--check must not rewrite the file");
  });

  test("--check exits 0 when the pin already matches", () => {
    writePinFile(".github/workflows/offline-package-acceptance.yml", SHA_A);
    git(["add", ".github"]);
    stageGitlink(SHA_A);
    const r = runChecker(["--check"]);
    assert.equal(r.status, 0, r.stderr);
  });

  test("a pin file with unstaged edits is refused, not swept into the commit", () => {
    const rel = ".github/workflows/offline-package-acceptance.yml";
    writePinFile(rel, SHA_B);
    git(["add", ".github"]);
    stageGitlink(SHA_A);
    // An unrelated in-progress edit the developer has not staged yet.
    fs.appendFileSync(path.join(scratch, rel), "      - run: echo in-progress\n");
    const r = runChecker();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /未暂存改动/);
    assert.equal(readPin(rel), SHA_B, "the file must be left untouched");
  });

  test("a non-gitlink .agent entry is ignored", () => {
    writePinFile(".github/workflows/offline-package-acceptance.yml", SHA_B);
    fs.mkdirSync(path.join(scratch, ".agent"));
    fs.writeFileSync(path.join(scratch, ".agent", "README.md"), "plain directory\n");
    git(["add", "-A"]);
    const r = runChecker();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /未检测到 \.agent gitlink/);
  });

  test("repos without workflow pins are a no-op", () => {
    stageGitlink(SHA_A);
    const r = runChecker();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /未找到 EXPECTED_GITLINK/);
  });
});
