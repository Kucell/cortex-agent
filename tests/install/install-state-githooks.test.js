"use strict";

// ─── installStateGithooks tests (T-FOLLOW-002 v2) ─────────────────────────────
//
// Coverage: lib/state-sync.js installStateGithooks
//   - no .agent/ → { ok: false, reason }
//   - .agent/ exists, not a git repo → { ok, installed: true, hooksConfigured: false }
//   - .agent/ + git repo, no core.hooksPath → { ok, installed: true, hooksConfigured: true }
//   - .agent/ + git repo, core.hooksPath=.githooks already → idempotent
//   - .agent/ + git repo, custom core.hooksPath → left alone + reason
//   - .githooks/ already exists → installed: false (don't clobber user edits)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { installStateGithooks } = require("../../lib/state-sync");

function git(args, cwd) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x",
           GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function mkRoot({ withAgent = true, initAgent = true, existingHooks = null, existingHooksPath = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-install-githooks-"));
  if (withAgent) {
    const agentDir = path.join(root, ".agent");
    fs.mkdirSync(agentDir);
    if (initAgent) {
      let r = git(["init", "-q", "-b", "main"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
      r = git(["config", "user.email", "t@x"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
      r = git(["config", "user.name", "T"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
      if (existingHooksPath) {
        r = git(["config", "core.hooksPath", existingHooksPath], agentDir);
        if (r.status !== 0) throw new Error(r.stderr);
      }
    }
    if (existingHooks) {
      const hooksDir = path.join(agentDir, ".githooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      for (const [name, content] of Object.entries(existingHooks)) {
        fs.writeFileSync(path.join(hooksDir, name), content);
      }
    }
  }
  return root;
}

test("installStateGithooks: no .agent/ → ok:false, reason:'no .agent/'", () => {
  const root = mkRoot({ withAgent: false });
  const res = installStateGithooks({ cwd: root, lang: "en" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no .agent/");
  assert.equal(res.installed, false);
});

test("installStateGithooks: .agent/ but not a git repo → installed, hooksConfigured:false", () => {
  const root = mkRoot({ withAgent: true, initAgent: false });
  const res = installStateGithooks({ cwd: root, lang: "en" });
  assert.equal(res.ok, true);
  assert.equal(res.installed, true);
  assert.equal(res.hooksConfigured, false);
  // .githooks/ should have been created.
  const hooksDir = path.join(root, ".agent", ".githooks");
  assert.equal(fs.existsSync(hooksDir), true);
  assert.equal(fs.existsSync(path.join(hooksDir, "pre-commit")), true);
  assert.equal(fs.existsSync(path.join(hooksDir, "README.md")), true);
});

test("installStateGithooks: .agent/ git repo, no hooksPath → install + configure", () => {
  const root = mkRoot({ withAgent: true, initAgent: true });
  const res = installStateGithooks({ cwd: root, lang: "en" });
  assert.equal(res.ok, true);
  assert.equal(res.installed, true);
  assert.equal(res.hooksConfigured, true);
  // Verify git config was actually set.
  const cfg = git(["config", "--get", "core.hooksPath"], path.join(root, ".agent"));
  assert.equal(cfg.status, 0);
  assert.equal(cfg.stdout.trim(), ".githooks");
});

test("installStateGithooks: core.hooksPath already .githooks AND .githooks/ exists → fully idempotent", () => {
  const root = mkRoot({
    withAgent: true,
    initAgent: true,
    existingHooksPath: ".githooks",
    existingHooks: { "pre-commit": "#!/bin/sh\nexit 0\n" },
  });
  const res = installStateGithooks({ cwd: root, lang: "en" });
  assert.equal(res.ok, true);
  assert.equal(res.installed, false, "no .githooks/ copy when already present");
  assert.equal(res.hooksConfigured, true, "core.hooksPath already correct");
  // User edits preserved.
  const userContent = fs.readFileSync(
    path.join(root, ".agent", ".githooks", "pre-commit"), "utf8");
  assert.match(userContent, /^#!\/bin\/sh$/m);
});

test("installStateGithooks: core.hooksPath=.githooks but .githooks/ missing → repair (installed:true)", () => {
  const root = mkRoot({ withAgent: true, initAgent: true, existingHooksPath: ".githooks" });
  const res = installStateGithooks({ cwd: root, lang: "en" });
  assert.equal(res.ok, true);
  assert.equal(res.installed, true, "missing .githooks/ gets re-created");
  assert.equal(res.hooksConfigured, true);
  assert.equal(fs.existsSync(path.join(root, ".agent", ".githooks", "pre-commit")), true);
});

test("installStateGithooks: custom core.hooksPath → left alone, reason explains", () => {
  const root = mkRoot({ withAgent: true, initAgent: true, existingHooksPath: "my-hooks" });
  const res = installStateGithooks({ cwd: root, lang: "en" });
  assert.equal(res.ok, true);
  assert.equal(res.hooksConfigured, false);
  assert.match(res.reason, /existing core\.hooksPath=my-hooks/);
  // Verify git config was NOT changed.
  const cfg = git(["config", "--get", "core.hooksPath"], path.join(root, ".agent"));
  assert.equal(cfg.stdout.trim(), "my-hooks");
});

test("installStateGithooks: existing .githooks/ → installed:false (user edits preserved)", () => {
  const root = mkRoot({
    withAgent: true,
    initAgent: true,
    existingHooks: { "pre-commit": "#!/bin/sh\n# user-customized\nexit 0\n" },
  });
  const res = installStateGithooks({ cwd: root, lang: "en" });
  assert.equal(res.ok, true);
  assert.equal(res.installed, false, "must NOT overwrite existing .githooks/");
  // Verify user content was preserved.
  const userContent = fs.readFileSync(
    path.join(root, ".agent", ".githooks", "pre-commit"), "utf8");
  assert.match(userContent, /user-customized/);
});

test("installStateGithooks: missing template → ok:false, reason:'no template'", () => {
  const root = mkRoot({ withAgent: true, initAgent: true });
  // Temporarily move the template aside so the helper thinks it's missing.
  const tpl = path.join(__dirname, "..", "..", "templates", "_shared", ".agent", ".githooks");
  const backup = `${tpl}.bak-${Date.now()}`;
  fs.renameSync(tpl, backup);
  try {
    const res = installStateGithooks({ cwd: root, lang: "en" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "no template");
  } finally {
    fs.renameSync(backup, tpl);
  }
});
