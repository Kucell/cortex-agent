"use strict";

// Coverage for lib/git/index.js — git queries and local exclude management.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  hasTrackedPath,
  getIgnoreSource,
  isGitRepo,
  resolveGitExcludePath,
  applyGitExclusion,
} = require("../../lib/git/index.js");

function makeGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-git-test-"));
  execSync("git init -q", { cwd: root });
  execSync("git config user.email test@example.com", { cwd: root });
  execSync("git config user.name Test", { cwd: root });
  return root;
}

function write(root, rel, body = "x\n") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

describe("git — repository detection", () => {
  test("isGitRepo true inside a git repo, false in a plain dir", () => {
    const repo = makeGitRepo();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-nogit-"));
    assert.equal(isGitRepo(repo), true);
    assert.equal(isGitRepo(plain), false);
  });

  test("resolveGitExcludePath returns an existing path under .git", () => {
    const repo = makeGitRepo();
    const excludePath = resolveGitExcludePath(repo);
    assert.ok(excludePath);
    assert.ok(excludePath.includes("info/exclude"));
    assert.ok(path.isAbsolute(excludePath));
  });

  test("resolveGitExcludePath returns null outside a git repo", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-nogit-"));
    assert.equal(resolveGitExcludePath(plain), null);
  });
});

describe("git — tracked/ignore queries", () => {
  test("hasTrackedPath true after commit, false for untracked file", () => {
    const repo = makeGitRepo();
    write(repo, "tracked.txt");
    write(repo, "untracked.txt");
    execSync("git add tracked.txt && git commit -qm init", { cwd: repo });
    assert.equal(hasTrackedPath(repo, "tracked.txt"), true);
    assert.equal(hasTrackedPath(repo, "untracked.txt"), false);
    assert.equal(hasTrackedPath(repo, "missing.txt"), false);
  });

  test("getIgnoreSource reports the ignore rule for an ignored path", () => {
    const repo = makeGitRepo();
    write(repo, ".gitignore", "secret.log\n");
    const source = getIgnoreSource(repo, "secret.log");
    assert.ok(source.includes(".gitignore"));
    assert.equal(getIgnoreSource(repo, "not-ignored.txt"), "");
  });
});

describe("git — applyGitExclusion", () => {
  test("adds custom paths to info/exclude and is idempotent", () => {
    const repo = makeGitRepo();
    const ctx = { cwd: repo, lang: "en" };
    applyGitExclusion(ctx, ["generated-out", "cache-dir"]);

    const excludePath = resolveGitExcludePath(repo);
    const content = fs.readFileSync(excludePath, "utf8");
    assert.ok(content.includes("/generated-out"));
    assert.ok(content.includes("/cache-dir"));

    // Second run must not duplicate entries.
    applyGitExclusion(ctx, ["generated-out", "cache-dir"]);
    const after = fs.readFileSync(excludePath, "utf8");
    assert.equal(after.match(/\/generated-out/g).length, 1);
    assert.equal(after.match(/\/cache-dir/g).length, 1);
  });

  test("normalizes bare entries that lack a leading slash", () => {
    const repo = makeGitRepo();
    const excludePath = resolveGitExcludePath(repo);
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(excludePath, "legacy-out\n");

    applyGitExclusion({ cwd: repo, lang: "en" }, ["legacy-out"]);
    const content = fs.readFileSync(excludePath, "utf8");
    assert.ok(content.includes("/legacy-out"));
    assert.ok(!content.match(/^legacy-out$/m));
  });

  test("appends graphify-out when the graphify plugin is present", () => {
    const repo = makeGitRepo();
    fs.mkdirSync(path.join(repo, ".agent", "plugins", "graphify"), { recursive: true });
    applyGitExclusion({ cwd: repo, lang: "zh" }, ["only-one"]);

    const content = fs.readFileSync(resolveGitExcludePath(repo), "utf8");
    assert.ok(content.includes("/only-one"));
    assert.ok(content.includes("/graphify-out"));
  });

  test("does nothing outside a git repository", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-nogit-"));
    assert.doesNotThrow(() => applyGitExclusion({ cwd: plain, lang: "en" }, ["x"]));
  });
});
