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
  const migration = densityLib.migrateMetaBaseline(cwd);
  //
  // The migration is FAIL-CLOSED. `graphify update .` rewrites graph.json
  // and drops every key the CLI does not own -- `_meta` included -- so an
  // incremental update that runs after a FAILED migration destroys the only
  // baseline the project has, and the density guard can never fire again.
  //
  // A migration that had nothing to do (the sidecar is already there, or
  // the graph never carried a `_meta` baseline) is not a failure. Every
  // other outcome -- a ticket that could not be allocated, a graph that
  // could not be read -- is: the request is queued, the failure is
  // reported, and the baseline stays where it is.
  const migrationFailed = !migration || (
    migration.migrated !== true
    && migration.reason !== "sidecar_present"
    && migration.reason !== "no_meta_baseline"
  );
  if (migrationFailed) {
    const queued = densityLib.writePendingUpdate(cwd, {
      changedPaths: classification.code.concat(classification.semantic),
      semanticPaths: classification.semantic,
      sourceHead: sourceHead || null,
      branch: branch || null,
      attempts: 0,
    });
    const failMarker = markersLib.writeMarker({
      graphDir,
      kind: markersLib.KIND.UPDATE_FAILED,
      reason: `baseline_migration_failed:${(migration && migration.reason) || "unknown"}`,
      changedPaths: classification.code.concat(classification.semantic),
      sourceHead: sourceHead || null,
      branch: branch || null,
    });
    if (queued && queued.ok) {
      densityLib.startPendingDrain({ projectRoot: cwd });
    }
    return {
      ok: false,
      result: HOOK_RESULT.INCREMENTAL_FAILED,
      reason: "baseline_migration_failed",
      marker: failMarker,
      state,
    };
  }
  //
  // The incremental update takes the SAME rebuild lock the full rebuild
  // takes. Without it the two paths interleave: a full rebuild that is
  // already running would have its graph overwritten by the incremental
  // update, and the rebuild would then stamp the degraded ratio as the new
  // "full" baseline -- the state the guard exists to prevent.
  //
  // When the lock is held, the incremental update is deferred rather than
  // executed: the full rebuild is about to publish a complete graph anyway,
  // so a second writer would only race it. The request is NOT dropped -- it
  // is queued and replayed once the lock is free.
  const lock = densityLib.acquireRebuildLock(cwd);
  if (!lock) {
    // The request is NOT lost: it is recorded and replayed once the lock is
    // free. Silently skipping it would leave the committed changes out of
    // the graph until some later commit happened to cover them.
    const queued = densityLib.writePendingUpdate(cwd, {
      changedPaths: classification.code.concat(classification.semantic),
      semanticPaths: classification.semantic,
      sourceHead: sourceHead || null,
      branch: branch || null,
      // This is a NEW request, so it starts with a fresh budget. The
      // attempt counter belongs to the request it was measured on: an
      // earlier version handed the HIGHEST counter of the queue to every
      // new request, so a request that was queued next to one that had
      // already failed four times was dropped after a single further
      // failure -- without ever having been retried properly.
      attempts: 0,
    });
    // The deferral is only safe when the request actually reached the disk.
    // A queue that could not be written (a full disk, a permission error)
    // leaves the commit's changes unrecorded, so the hook must report the
    // failure instead of claiming that the change was safely deferred.
    if (!queued || !queued.ok) {
      const failMarker = markersLib.writeMarker({
        graphDir,
        kind: markersLib.KIND.UPDATE_FAILED,
        reason: `pending_publish_failed:${(queued && queued.reason) || "unknown"}`,
        changedPaths: classification.code.concat(classification.semantic),
        sourceHead: sourceHead || null,
        branch: branch || null,
      });
      return {
        ok: false,
        result: HOOK_RESULT.INCREMENTAL_FAILED,
        reason: "pending_publish_failed",
        marker: failMarker,
        state,
      };
    }
    // The request is queued, but a queue needs a CONSUMER. The holder of
    // the lock may have drained the queue a moment before this request was
    // published and then exited, leaving the request with nobody to replay
    // it: the commit it describes would never reach the graph.
    //
    // So a drain is started. It waits for the lock and then replays the
    // queue; when the holder is still running, the holder drains the queue
    // itself and the drain finds nothing left to do.
    densityLib.startPendingDrain({ projectRoot: cwd });
    return {
      ok: true,
      result: HOOK_RESULT.SKIPPED,
      reason: "rebuild_in_progress",
      state,
    };
  }
  let upd;
  // Whether the lock was lost WHILE the update ran. The check before the
  // write is not enough: the lock can be taken away in the window between
  // the check and the write, and a request that is confirmed after that
  // is confirmed on the strength of a graph that another holder may have
  // replaced.
  let lockLostDuringUpdate = false;
  // The marker that exists BEFORE this run. A successful update may clear
  // it -- but only THAT marker: a consumer that writes a new marker while
  // this run is updating describes a different change, and an
  // unconditional clear would delete its reminder for good.
  const markerBefore = markersLib.readMarker(graphDir);
  try {
    // The FENCE: a lock can be reclaimed as stale while its holder is
    // alive, so the holder checks that it still owns the lock before it
    // writes the graph. A holder that lost it must not publish anything.
    if (!lock.isHeld()) {
      const queued = densityLib.writePendingUpdate(cwd, {
        changedPaths: classification.code.concat(classification.semantic),
        semanticPaths: classification.semantic,
        sourceHead: sourceHead || null,
        branch: branch || null,
        attempts: 0,
      });
      if (!queued || !queued.ok) {
        // The request could not be recorded, so the commit's changes would
        // be in no queue at all. The hook reports the failure instead of
        // claiming that the change was safely deferred.
        const failMarker = markersLib.writeMarker({
          graphDir,
          kind: markersLib.KIND.UPDATE_FAILED,
          reason: `pending_publish_failed:${(queued && queued.reason) || "unknown"}`,
          changedPaths: classification.code.concat(classification.semantic),
          sourceHead: sourceHead || null,
          branch: branch || null,
        });
        return {
          ok: false,
          result: HOOK_RESULT.INCREMENTAL_FAILED,
          reason: "pending_publish_failed",
          marker: failMarker,
          state,
        };
      }
      densityLib.startPendingDrain({ projectRoot: cwd });
      return {
        ok: true,
        result: HOOK_RESULT.SKIPPED,
        reason: "rebuild_lock_lost",
        state,
      };
    }
    upd = spawnSync("graphify", ["update", "."], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    // The FENCE after the write. A holder that lost the lock must not
    // publish anything -- and it must not CONFIRM a request either.
    lockLostDuringUpdate = !lock.isHeld();
  } finally {
    lock.release();
  }
  if (lockLostDuringUpdate) {
    // The update ran, but the lock was lost while it ran: the graph on
    // disk may belong to another holder now. The request is NOT
    // confirmed -- it is queued again, so a later run republishes it, and
    // the failure is recorded as a reminder.
    const queued = densityLib.writePendingUpdate(cwd, {
      changedPaths: classification.code.concat(classification.semantic),
      semanticPaths: classification.semantic,
      sourceHead: sourceHead || null,
      branch: branch || null,
      // The update DID run, so this attempt happened: the budget moves.
      attempts: 1,
    });
    if (queued && queued.ok) {
      densityLib.startPendingDrain({ projectRoot: cwd });
    }
    const failMarker = markersLib.writeMarker({
      graphDir,
      kind: markersLib.KIND.UPDATE_FAILED,
      reason: "rebuild_lock_lost_during_update",
      changedPaths: classification.code.concat(classification.semantic),
      sourceHead: sourceHead || null,
      branch: branch || null,
    });
    return {
      ok: false,
      result: HOOK_RESULT.INCREMENTAL_FAILED,
      reason: "rebuild_lock_lost_during_update",
      marker: failMarker,
      state,
    };
  }
  if (upd.status !== 0) {
    // The update did not succeed, so the commit's changes are not in the
    // graph. The request is queued so a later attempt picks it up, and the
    // attempt counter starts at 1: this attempt already happened.
    //
    // The request is written BEFORE the consumer is scheduled, so the
    // consumer never looks at an empty queue and concludes that there is
    // nothing to replay.
    const queued = densityLib.writePendingUpdate(cwd, {
      changedPaths: classification.code.concat(classification.semantic),
      semanticPaths: classification.semantic,
      sourceHead: sourceHead || null,
      branch: branch || null,
      attempts: 1,
    });
    if (queued && queued.ok) {
      densityLib.startPendingDrain({ projectRoot: cwd });
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
  // The update succeeded. A request that was deferred while this run held
  // the lock is waiting in the queue, and it needs a consumer: the drain
  // takes the lock itself, so it cannot race this run.
  //
  // The queue is checked BEFORE the consumer is scheduled, so the consumer
  // never looks at an empty queue and concludes that there is nothing to
  // replay.
  if (densityLib.hasPendingUpdate(cwd)) {
    densityLib.startPendingDrain({ projectRoot: cwd });
  }
  // Successful incremental update → clear the leftover stale marker, but
  // only the one that was already there when this run started, and only
  // when this update actually ANSWERS it.
  //
  // A SEMANTIC marker says "the semantic corpus is stale". An incremental
  // update rebuilds the CODE corpus only, so it does not answer that
  // reminder: clearing it would drop the only persistent trace of a
  // semantic change that nothing has rebuilt. Only the kinds that describe
  // the incremental path itself are cleared here.
  markersLib.clearMarkerIfUnchanged(graphDir, markerBefore.identity || null, {
    kinds: markersLib.CLEARABLE_BY_INCREMENTAL,
  });
  // A commit that carried semantic changes leaves the semantic corpus
  // stale, even when the code corpus was rebuilt. The reminder is written
  // here, so the semantic part of THIS commit is not left without a trace:
  // the incremental update does not cover it, and nothing else would
  // publish it.
  //
  // The paths of a semantic marker that was already there are carried over,
  // so the reminder keeps describing every semantic change that is still
  // unanswered.
  if (classification.semantic.length > 0) {
    // The paths of every semantic reminder that is still unanswered: the
    // one that was there when this run started, and the one that a
    // concurrent writer published while the update ran.
    // The paths of the reminders that are SEMANTIC. The derived marker
    // carries the union of every outstanding reminder, so its paths are
    // not the semantic ones: an update-failed reminder also lists code
    // paths, and a semantic reminder must not inherit them.
    const semanticPathsOf = (marker) => {
      if (!marker || !marker.ok) return [];
      if (Array.isArray(marker.records)) {
        const paths = [];
        for (const record of marker.records) {
          if (record.kind !== markersLib.KIND.SEMANTIC) continue;
          if (!Array.isArray(record.changedPaths)) continue;
          for (const p of record.changedPaths) paths.push(p);
        }
        return paths;
      }
      return marker.marker
        && marker.marker.kind === markersLib.KIND.SEMANTIC
        && Array.isArray(marker.marker.changedPaths)
        ? marker.marker.changedPaths
        : [];
    };
    const previousSemantic = semanticPathsOf(markerBefore)
      .concat(semanticPathsOf(markersLib.readMarker(graphDir)));
    const semanticMarker = markersLib.writeMarker({
      graphDir,
      kind: markersLib.KIND.SEMANTIC,
      reason: "semantic_changes_in_mixed_commit",
      changedPaths: [...new Set(previousSemantic.concat(classification.semantic))].sort(),
      sourceHead: sourceHead || null,
      branch: branch || null,
    });
    if (!semanticMarker || !semanticMarker.ok) {
      // The reminder could not be written, so the semantic change has no
      // persistent trace at all. The hook reports the failure instead of
      // claiming that everything is in order.
      return {
        ok: false,
        result: HOOK_RESULT.INCREMENTAL_FAILED,
        reason: "semantic_marker_write_failed",
        marker: semanticMarker,
        state,
      };
    }
  }
  // Edge-density guard (issue #154).
  //
  // `graphify update .` rebuilds the CODE corpus, but it never rebuilds the
  // SEMANTIC one: the global `contains` / doc-reference edges of a fully
  // built graph are not produced by an incremental update. The edge/node
  // ratio of an incremental graph therefore sits BELOW the ratio of a fully
  // built graph, and drifts further down with every commit.
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
