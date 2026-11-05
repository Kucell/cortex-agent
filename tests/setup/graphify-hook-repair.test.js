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
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const graphifyHook = require("../../lib/setup/graphify-hook");
const graphifyLib = require("../../lib/graphify");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graphify-hook-"));
}

function fakeGitRepo(projectRoot) {
  execFileSync("git", ["init", "-q"], { cwd: projectRoot });
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

test("resolveGitHooksDir honors worktree git metadata and core.hooksPath", () => {
  const root = mkRoot();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "core.hooksPath", ".custom-hooks"], { cwd: root });
  assert.equal(
    graphifyLib.hook.resolveGitHooksDir(root),
    path.join(root, ".custom-hooks"),
  );
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

// ─── project-owned assets (upgrade path) ────────────────────────────────────

function writeThreshold(root, body) {
  const pluginDir = path.join(root, ".agent", "plugins", "graphify");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "threshold.json"), body, "utf8");
  return path.join(pluginDir, "threshold.json");
}

test("refreshGraphifyPluginAssets: fills in missing threshold keys, keeps project values", () => {
  const root = mkRoot();
  fakePlugin(root);
  const file = writeThreshold(root, JSON.stringify({
    min_nodes_for_check: 100,
    ratio_drop_threshold: 0.85,
    baseline_edge_node_ratio: 2.43,
    full_rebuild_timeout_seconds: 1500,
    repo: "legacy",
  }, null, 2) + "\n");

  const result = graphifyHook.refreshGraphifyPluginAssets(root);
  assert.equal(result.ok, true);
  assert.equal(result.threshold.action, "updated");

  const merged = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(merged.baseline_edge_node_ratio, 2.43, "project baseline must survive");
  assert.equal(merged.full_rebuild_timeout_seconds, 1500, "project timeout must survive");
  assert.equal(merged.repo, "legacy", "unknown project keys must survive");
  assert.ok(Array.isArray(merged.full_rebuild_args), "the rebuild args must be filled in");
  assert.equal(merged.full_rebuild_args[0], "extract");
  assert.ok(merged.full_rebuild_args.includes("--force"));
});

test("refreshGraphifyPluginAssets: never rewrites a corrupt threshold", () => {
  const root = mkRoot();
  fakePlugin(root);
  const broken = "{ not json\n";
  const file = writeThreshold(root, broken);

  const result = graphifyHook.refreshGraphifyPluginAssets(root);
  assert.equal(result.threshold.ok, false);
  assert.equal(result.threshold.reason, "threshold_unparsable");
  assert.equal(fs.readFileSync(file, "utf8"), broken, "the project's own file must stay untouched");
});

test("refreshGraphifyPluginAssets: appends only the missing ignore rules", () => {
  const root = mkRoot();
  fakePlugin(root);
  const ignore = path.join(root, ".agent", ".gitignore");
  fs.writeFileSync(ignore, "plugins/graphify/.hook-installed\n# project rule\n", "utf8");

  const result = graphifyHook.refreshGraphifyPluginAssets(root);
  assert.equal(result.ignore.action, "updated");
  const body = fs.readFileSync(ignore, "utf8");
  assert.ok(body.includes("# project rule"), "project rules must survive");
  assert.ok(body.includes("plugins/graphify/.density-worktrees/"));

  // Idempotent: a second refresh adds nothing.
  const second = graphifyHook.refreshGraphifyPluginAssets(root);
  assert.equal(second.ignore.action, "unchanged");
  assert.equal(fs.readFileSync(ignore, "utf8"), body);
});

test("ensureGraphifyIntegration: installs runtime, assets and hook in one pass", () => {
  const root = mkRoot();
  fakePlugin(root);
  fakeGitRepo(root);
  writeThreshold(root, JSON.stringify({ repo: "legacy" }, null, 2) + "\n");

  const result = graphifyHook.ensureGraphifyIntegration(root, { apply: true });
  assert.equal(result.ok, true);
  assert.equal(result.runtime.inSync, true);
  assert.equal(result.assets.action, "updated");
  assert.ok(fs.existsSync(
    path.join(root, ".agent", "plugins", "graphify", "lib", "graphify", "hook.js"),
  ));
});

test("ensureGraphifyIntegration: no-op for a project that opted out", () => {
  const root = mkRoot();
  fakeGitRepo(root);
  const result = graphifyHook.ensureGraphifyIntegration(root, { apply: true });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "graphify_not_opted_in");
  assert.equal(fs.existsSync(path.join(root, ".git", "hooks", "post-commit")), false);
});

test("planGraphifyIntegration: reports the work an update would do", () => {
  const root = mkRoot();
  fakePlugin(root);
  const plan = graphifyHook.planGraphifyIntegration(root);
  assert.equal(plan.optedIn, true);
  assert.equal(plan.needsWork, true, "a project without the runtime needs the sync");
  assert.equal(plan.runtime.inSync, false);
});
