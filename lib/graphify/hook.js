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
 * After a successful incremental update the module also runs the
 * edge-density guard (issue #154): when the incremental graph's
 * edge/node ratio drops below the recorded baseline, a DETACHED full
 * rebuild is started to restore the full edge set. The rebuild never
 * blocks the commit.
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
const densityLib = require("./density");

const HOOK_RESULT = Object.freeze({
  SKIPPED: "skipped",
  NOOP: "noop",
  INCREMENTAL_OK: "incremental_ok",
  INCREMENTAL_FAILED: "incremental_failed",
  SEMANTIC_MARKED: "semantic_marked",
  PLUGIN_REPAIR_NEEDED: "plugin_repair_needed",
  // A new result value: the incremental update succeeded AND the density
  // guard started a detached full rebuild. The commit is NOT blocked.
  DENSITY_REBUILD_STARTED: "density_rebuild_started",
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
    // The wrapper lives under <project>/.agent/plugins/graphify/scripts/.
    // The hook itself sits in <project>/.git/hooks/, so the path has to
    // climb out of .git/hooks and back into .agent/ — the previous
    // ../../plugins/... form resolved to <project>/plugins/..., which does
    // not exist, so the installed hook never reached the wrapper at all.
    "node \"$(dirname \"$0\")/../../.agent/plugins/graphify/scripts/post-commit-update.js\" || true",
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
  // A request that was deferred while the rebuild lock was busy is replayed
  // now. Its paths are merged into this run BEFORE the classification
  // decisions are made, so a deferred commit is covered exactly like a
  // fresh one -- including the semantic-only path.
  const pending = densityLib.takePendingUpdate(cwd);
  if (pending) {
    const merged = (changedPaths || [])
      .concat(pending.changedPaths);
    const reclassified = markersLib.classifyChanges([...new Set(merged)]);
    classification.code = reclassified.code;
    classification.semantic = reclassified.semantic;
    if (!sourceHead && pending.sourceHead) sourceHead = pending.sourceHead;
    if (!branch && pending.branch) branch = pending.branch;
  }
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
  //
  // The `_meta` baseline is migrated into the durable sidecar BEFORE the
  // incremental update runs. `graphify update .` rewrites graph.json and
  // drops every key the CLI does not own -- `_meta` included -- so a project
  // that carried the consumer-side convention would lose its baseline on the
  // very first commit after the upgrade, and the density guard would never
  // fire again.
  densityLib.migrateMetaBaseline(cwd);
  //
  // The incremental update takes the SAME rebuild lock the full rebuild
  // takes. Without it the two paths interleave: a full rebuild that is
  // already running would have its graph overwritten by the incremental
  // update, and the rebuild would then stamp the degraded ratio as the new
  // "full" baseline -- the state the guard exists to prevent.
  //
  // When the lock is held, the incremental update is SKIPPED rather than
  // queued: the full rebuild is about to publish a complete graph anyway,
  // so a second writer would only race it.
  const lock = densityLib.acquireRebuildLock(cwd);
  if (!lock) {
    // The request is NOT lost: it is recorded and replayed once the lock is
    // free. Silently skipping it would leave the committed changes out of
    // the graph until some later commit happened to cover them.
    densityLib.writePendingUpdate(cwd, {
      changedPaths: classification.code.concat(classification.semantic),
      sourceHead: sourceHead || null,
      branch: branch || null,
      // The attempts counter of the request this run CONSUMED is carried
      // over. Without it a request that has already failed several times
      // would get a fresh budget every time a concurrent commit happened
      // to find the lock busy -- so the bound would never be reached and
      // the request would be retried for ever.
      attempts: pending ? pending.attempts : 0,
    });
    // The claims this run consumed are handed back to the queue: the
    // request was NOT replayed, so it must stay visible. The claim files
    // are only removed once the replay actually succeeded.
    if (pending) {
      densityLib.releasePendingUpdate(cwd, pending.claims, {
        attempts: pending.attempts,
      });
      densityLib.completePendingUpdate(pending.exhaustedClaims);
    }
    // The request is queued, but a queue needs a CONSUMER. The holder of
    // the lock may have drained the queue a moment before this request was
    // published and then exited, leaving the request with nobody to replay
    // it: the commit it describes would never reach the graph.
    //
    // So the queue is checked for a live consumer. When the lock is FREE,
    // the holder is gone and a drain is started; when the lock is HELD, the
    // holder is still running and will drain the queue itself.
    if (!fs.existsSync(densityLib.rebuildLockPath(cwd))) {
      densityLib.startPendingDrain({ projectRoot: cwd });
    }
    return {
      ok: true,
      result: HOOK_RESULT.SKIPPED,
      reason: "rebuild_in_progress",
      state,
    };
  }
  let upd;
  try {
    upd = spawnSync("graphify", ["update", "."], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } finally {
    lock.release();
    // A request that arrived while this run held the lock is waiting in the
    // pending queue. Draining it here means the deferred commit reaches the
    // graph without waiting for a later commit that may never come.
    //
    // The drain is started AFTER the lock is released, and the drain takes
    // the lock itself. The drain must never run while this process still
    // holds the lock: it would publish a degraded graph in parallel with a
    // rebuild that is about to stamp its baseline, and the stamp would then
    // record the degraded ratio as the new "full" baseline.
    densityLib.startPendingDrain({ projectRoot: cwd });
  }
  if (upd.status !== 0) {
    // The replay did not succeed, so the claims are handed back to the
    // queue: the deferred request must stay visible for the next attempt.
    if (pending) {
      densityLib.releasePendingUpdate(cwd, pending.claims, {
        attempts: pending.attempts,
      });
    }
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
  // The update succeeded, so the consumed claims are removed for good.
  // Until this point they were still on disk: a hook that died during the
  // update left the deferred request recoverable instead of losing it.
  if (pending) {
    densityLib.completePendingUpdate(pending.claims);
    densityLib.completePendingUpdate(pending.exhaustedClaims);
  }
  // Successful incremental update → clear any leftover stale marker.
  markersLib.clearMarker(graphDir);
  // Edge-density guard (issue #154).
  //
  // `graphify update .` only re-extracts the files the commit touched, so
  // the global `contains` / doc-reference edges are never refreshed. The
  // edge/node ratio of an incremental graph therefore sits BELOW the ratio
  // of a fully built graph, and drifts further down with every commit.
  //
  // When the measured ratio drops below `baseline * ratio_drop_threshold`,
  // a DETACHED full rebuild is started: the rebuild restores the full edge
  // set and stamps the new baseline. The commit is never blocked, and the
  // incremental path NEVER writes the baseline -- a baseline that moved
  // down with the degraded graph would make the threshold unreachable.
  const density = densityLib.checkAndMaybeRebuild({ projectRoot: cwd });
  if (density.trigger && density.rebuild && density.rebuild.started) {
    return {
      ok: true,
      result: HOOK_RESULT.DENSITY_REBUILD_STARTED,
      density,
      state,
    };
  }
  return {
    ok: true,
    result: HOOK_RESULT.INCREMENTAL_OK,
    density,
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
