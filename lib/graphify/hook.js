"use strict";

/**
 * Git hook orchestration for Graphify (T-GWG-001 / P-001 §4.6).
 *
 * The post-commit hook is responsible for either:
 *   - re-running `graphify update .` (code changes; AST incremental), or
 *   - writing a stale marker (semantic changes: docs, proposals, rules,
 *     images, etc.).
 *
 * This module is the single source of truth shared by the hook scripts
 * under `templates/{_shared,en,zh}/.agent/plugins/graphify/scripts/`.
 * The hook scripts are thin wrappers around `runPostCommit({ cwd })`.
 *
 * The hook MUST be a no-op when Graphify is not installed (CLI binary
 * missing) or when the project has no `graphify-out/`. It never blocks
 * the commit, and it never modifies project files other than the
 * manifest / marker under `graphify-out/`.
 *
 * Optional plugin detection (T-GWG-001 §4.6 #1): a project is considered
 * "Graphify-enabled" when ALL three are true:
 *   1. `graphify --version` succeeds (machine binary present)
 *   2. `<project>/.agent/plugins/graphify/config.yml` exists
 *   3. `<project>/graphify-out/graph.json` exists
 *
 * When any condition fails the hook exits silently with code 0 — the
 * caller (init/doctor) decides whether to attempt repair.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const markersLib = require("./markers");

const HOOK_RESULT = Object.freeze({
  SKIPPED: "skipped",
  NOOP: "noop",
  INCREMENTAL_OK: "incremental_ok",
  INCREMENTAL_FAILED: "incremental_failed",
  SEMANTIC_MARKED: "semantic_marked",
  PLUGIN_REPAIR_NEEDED: "plugin_repair_needed",
});

function graphifyCliAvailable() {
  try {
    execFileSync("graphify", ["--version"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Detect whether the project is Graphify-enabled (all three conditions
 * hold). Returns a status object — never throws.
 */
function detectPluginState(projectRoot) {
  const cli = graphifyCliAvailable();
  const pluginConfig = fs.existsSync(path.join(projectRoot, ".agent", "plugins", "graphify", "config.yml"));
  const graphBuilt = fs.existsSync(path.join(projectRoot, "graphify-out", "graph.json"));
  const hooksInstalled = isHookInstalled(projectRoot);
  return {
    cli,
    pluginConfig,
    graphBuilt,
    hooksInstalled,
    enabled: cli && pluginConfig && graphBuilt,
    needsRepair: cli && pluginConfig && !graphBuilt,
    hooksNeedRepair: pluginConfig && !hooksInstalled,
  };
}

/**
 * Detect the currently installed post-commit hook. Returns true when a
 * managed hook (one of our wrappers) is present. Existing user hooks
 * are preserved by `installHook()` below.
 */
function isHookInstalled(projectRoot) {
  const hooksDir = path.join(projectRoot, ".git", "hooks");
  const postCommit = path.join(hooksDir, "post-commit");
  if (!fs.existsSync(postCommit)) return false;
  try {
    const text = fs.readFileSync(postCommit, "utf8");
    return /graphify/i.test(text);
  } catch (_) {
    return false;
  }
}

/**
 * Idempotently install the Graphify post-commit hook. If an existing
 * hook script is present and does NOT already reference graphify, we
 * chain by appending a delegating call rather than overwriting. This
 * keeps the "do not overwrite existing hooks" guarantee from P-001 §4.6.
 *
 * Returns { ok, action: "created" | "appended" | "skipped" | "unchanged" }.
 */
function installHook({ projectRoot, hookSource }) {
  if (!projectRoot) return { ok: false, reason: "project_root_required" };
  const hooksDir = path.join(projectRoot, ".git", "hooks");
  if (!fs.existsSync(hooksDir)) {
    return { ok: false, reason: "not_a_git_repo" };
  }
  const target = path.join(hooksDir, "post-commit");
  const hookScript = hookSource || defaultHookScript();
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, hookScript, { mode: 0o755 });
    return { ok: true, action: "created" };
  }
  const existing = fs.readFileSync(target, "utf8");
  if (/graphify/i.test(existing)) {
    return { ok: true, action: "unchanged" };
  }
  // Chain without overwriting: append a delegation block at the very end.
  // The original hook continues to run because we exit 0 unconditionally.
  const appended = existing.replace(/\s*$/, "") + "\n\n" +
    "# --- cortex-agent: graphify incremental update (appended, do not edit) ---\n" +
    "if [ -d .agent/plugins/graphify ] && [ -f graphify-out/graph.json ]; then\n" +
    "  node .agent/plugins/graphify/scripts/post-commit-update.js || true\n" +
    "fi\n";
  fs.writeFileSync(target, appended, { mode: 0o755 });
  return { ok: true, action: "appended" };
}

/**
 * Default post-commit hook source. Mirrors the existing
 * `templates/_shared/.agent/plugins/graphify/scripts/post-commit-update.js`
 * but reads shared logic from `lib/graphify/hook` so we don't have to
 * duplicate parsing/classification in templates.
 */
function defaultHookScript() {
  return [
    "#!/usr/bin/env bash",
    "# Installed by `cortex-agent doctor --fix` (T-GWG-001).",
    "# Do not edit by hand — re-run `doctor --fix` to refresh.",
    "set -e",
    "node \"$(dirname \"$0\")/../../plugins/graphify/scripts/post-commit-update.js\" || true",
    "",
  ].join("\n");
}

/**
 * Run the post-commit update flow. Pure orchestration — never throws,
 * always returns a structured result the hook script can print.
 *
 * The classifier decides between incremental update and stale marker.
 * The caller (the hook) passes `cwd` (the git repository root) and the
 * list of paths changed in the just-finished commit.
 */
function runPostCommit({ cwd, changedPaths, sourceHead, branch }) {
  if (!cwd) return { ok: true, result: HOOK_RESULT.SKIPPED, reason: "no_cwd" };
  const state = detectPluginState(cwd);
  if (!state.enabled) {
    return { ok: true, result: state.cli ? HOOK_RESULT.PLUGIN_REPAIR_NEEDED : HOOK_RESULT.NOOP, state };
  }
  const classification = markersLib.classifyChanges(changedPaths || []);
  const graphDir = path.join(cwd, "graphify-out");
  if (classification.code.length === 0 && classification.semantic.length === 0) {
    return { ok: true, result: HOOK_RESULT.NOOP, state };
  }
  if (classification.semantic.length > 0 && classification.code.length === 0) {
    const markerResult = markersLib.writeMarker({
      graphDir,
      kind: markersLib.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: classification.semantic,
      sourceHead: sourceHead || null,
      branch: branch || null,
    });
    return {
      ok: markerResult.ok,
      result: markerResult.ok ? HOOK_RESULT.SEMANTIC_MARKED : HOOK_RESULT.INCREMENTAL_FAILED,
      marker: markerResult,
      state,
    };
  }
  // Mixed or code-only → run `graphify update .` then clear any stale marker.
  const upd = spawnSync("graphify", ["update", "."], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (upd.status !== 0) {
    const failMarker = markersLib.writeMarker({
      graphDir,
      kind: markersLib.KIND.UPDATE_FAILED,
      reason: `graphify_update_failed:${upd.status}`,
      changedPaths: classification.code.concat(classification.semantic),
      sourceHead: sourceHead || null,
      branch: branch || null,
    });
    return {
      ok: false,
      result: HOOK_RESULT.INCREMENTAL_FAILED,
      stderr: upd.stderr || null,
      marker: failMarker,
      state,
    };
  }
  // Successful incremental update → clear any leftover stale marker.
  markersLib.clearMarker(graphDir);
  return {
    ok: true,
    result: HOOK_RESULT.INCREMENTAL_OK,
    state,
  };
}

module.exports = {
  HOOK_RESULT,
  graphifyCliAvailable,
  detectPluginState,
  isHookInstalled,
  installHook,
  defaultHookScript,
  runPostCommit,
};