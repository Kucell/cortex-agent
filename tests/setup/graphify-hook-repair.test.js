"use strict";

// ─── lib/setup/graphify-hook.js integration tests (T-GWG-001) ────────────────
//
// Pins the contract that:
//   - When the project has no `.agent/plugins/graphify/` (opted out), the
//     helper is a strict no-op and never touches `.git/hooks/post-commit`.
//   - When the plugin is present and the CLI is installed, the helper
//     idempotently creates / appends / leaves the hook unchanged.
//   - On re-run the helper does not duplicate the marker or the hook.
//   - When the CLI is missing, the helper records the skip without
//     creating an empty hook stub.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const graphifyHook = require("../../lib/setup/graphify-hook");
const graphifyLib = require("../../lib/graphify");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graphify-hook-"));
}

function fakeGitRepo(projectRoot) {
  fs.mkdirSync(path.join(projectRoot, ".git", "hooks"), { recursive: true });
}

function fakePlugin(projectRoot) {
  const pluginDir = path.join(projectRoot, ".agent", "plugins", "graphify");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "config.yml"),
    "graphify:\n  version: 1\n",
  );
  return pluginDir;
}

test("isGraphifyOptedIn: false on bare project", () => {
  const root = mkRoot();
  assert.equal(graphifyHook.isGraphifyOptedIn(root), false);
});

test("isGraphifyOptedIn: true after plugin directory is laid down", () => {
  const root = mkRoot();
  fakePlugin(root);
  assert.equal(graphifyHook.isGraphifyOptedIn(root), true);
});

test("ensureGraphifyPostCommitHook: skipped when plugin missing", () => {
  const root = mkRoot();
  fakeGitRepo(root);
  const r = graphifyHook.ensureGraphifyPostCommitHook(root);
  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "graphify_not_opted_in");
  assert.equal(fs.existsSync(path.join(root, ".git", "hooks", "post-commit")), false);
});

test("ensureGraphifyPostCommitHook: skipped when CLI missing", () => {
  const root = mkRoot();
  fakePlugin(root);
  fakeGitRepo(root);
  // Detect CLI by mocking: if graphify is not installed this branch fires.
  const cliAvailable = graphifyLib.hook.graphifyCliAvailable();
  if (cliAvailable) {
    // Skip this case when CLI is actually installed (other tests cover it).
    return;
  }
  const r = graphifyHook.ensureGraphifyPostCommitHook(root);
  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "graphify_cli_missing");
  // We do NOT create a hook stub in this branch — caller can re-run init
  // after installing the CLI.
  assert.equal(fs.existsSync(path.join(root, ".git", "hooks", "post-commit")), false);
});

test("ensureGraphifyPostCommitHook: creates hook on first install when CLI present", () => {
  const root = mkRoot();
  fakePlugin(root);
  fakeGitRepo(root);
  if (!graphifyLib.hook.graphifyCliAvailable()) {
    return; // environment without Graphify binary
  }
  // Remove any pre-existing hook.
  try { fs.unlinkSync(path.join(root, ".git", "hooks", "post-commit")); } catch (_) {}
  const r = graphifyHook.ensureGraphifyPostCommitHook(root);
  assert.equal(r.status, "created");
  assert.equal(graphifyLib.hook.isHookInstalled(root), true);
  // Marker recorded.
  const status = graphifyHook.readGraphifyHookStatus(root);
  assert.equal(status.recorded, true);
  assert.equal(status.status && status.status.status, "created");
});

test("ensureGraphifyPostCommitHook: idempotent on second call", () => {
  const root = mkRoot();
  fakePlugin(root);
  fakeGitRepo(root);
  if (!graphifyLib.hook.graphifyCliAvailable()) {
    return;
  }
  try { fs.unlinkSync(path.join(root, ".git", "hooks", "post-commit")); } catch (_) {}
  const first = graphifyHook.ensureGraphifyPostCommitHook(root);
  const second = graphifyHook.ensureGraphifyPostCommitHook(root);
  assert.equal(first.status, "created");
  assert.equal(second.status, "unchanged");
});

test("ensureGraphifyPostCommitHook: appends when unrelated hook exists", () => {
  const root = mkRoot();
  fakePlugin(root);
  fakeGitRepo(root);
  if (!graphifyLib.hook.graphifyCliAvailable()) {
    return;
  }
  const hookPath = path.join(root, ".git", "hooks", "post-commit");
  fs.writeFileSync(hookPath, "#!/usr/bin/env bash\necho user-defined\n");
  fs.chmodSync(hookPath, 0o755);
  const r = graphifyHook.ensureGraphifyPostCommitHook(root);
  assert.equal(r.status, "appended");
  const text = fs.readFileSync(hookPath, "utf8");
  assert.ok(text.includes("user-defined"));
  assert.ok(text.includes("graphify"));
});