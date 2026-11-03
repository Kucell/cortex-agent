"use strict";



"use strict";

/**
 * Graphify edge-density fallback (issue #154).
 *
 * `graphify update .` rebuilds the CODE corpus, but it never rebuilds the
 * SEMANTIC one: the global `contains` / doc-reference edges of a fully
 * built graph are not produced by an incremental update. The edge/node
 * ratio of an incrementally updated graph is therefore lower than the
 * ratio of a fully built graph. The gap widens with every commit, and the
 * knowledge graph degrades monotonically.
 *
 * This module owns the quality guard that closes that gap:
 *
 *   1. Read the project's threshold configuration
 *      (`.agent/plugins/graphify/threshold.json`), falling back to
 *      conservative framework defaults.
 *   2. Resolve the baseline ratio. Priority:
 *        a. the durable sidecar `.agent/plugins/graphify/.density-baseline.json`
 *        b. `graphify-out/graph.json` `_meta.edge_node_ratio`
 *        c. the configured `baseline_edge_node_ratio`
 *        d. nothing -> the check is skipped
 *   3. Compare the measured ratio against `baseline * ratio_drop_threshold`.
 *   4. When the ratio dropped, start a DETACHED full rebuild that never
 *      blocks the commit, and let the rebuild stamp the new baseline.
 *
 * -- Why the baseline does not live only in `graph.json._meta` -----------
 *
 * The reference implementation in a consumer project stored the baseline
 * in `graph.json._meta.edge_node_ratio`. That works only as long as the
 * incremental update preserves `_meta`. It does not: `graphify update .`
 * REWRITES `graph.json` from the extracted graph and drops every key the
 * CLI does not own, `_meta` included (verified against graphify 0.9.27:
 * `export.to_json` writes `node_link_data` + `hyperedges` + `built_at_commit`
 * and nothing else). A baseline kept only in `_meta` is therefore erased
 * by the very first incremental update, and the fallback would fall back
 * to the configured value forever -- or, worse, be re-stamped by the
 * degraded incremental graph and drift down with it.
 *
 * So the durable baseline lives in a SIDECAR file outside `graphify-out/`:
 * `.agent/plugins/graphify/.density-baseline.json`. The sidecar is
 * framework-owned runtime state next to the plugin, is covered by the
 * template `.gitignore`, and survives every incremental update. The
 * `_meta.edge_node_ratio` value is still READ (so a project that already
 * carries the consumer-side convention keeps working -- the hook migrates
 * it into the sidecar), but the framework never WRITES it: a mirror is a
 * read-modify-write of the whole graph file, and it can publish a stale
 * snapshot over a newer graph.
 *
 * -- The sidecar is an append-only log -----------------------------------
 *
 * The sidecar holds ONE JSON RECORD PER LINE, and a publication APPENDS
 * its record; it never replaces the file. A publisher that lost a race
 * therefore cannot destroy the record that won it -- the READER picks the
 * record that wins the order. That is what makes the order a property of
 * the records instead of of a judgement that a later publisher can
 * invalidate: comparing the timestamp and then renaming over the file is
 * a read followed by a write, and two real runners could roll the
 * baseline back through it.
 *
 * -- How a publication is ordered ---------------------------------------
 *
 * The order is a property of the RECORDS, not of a judgement that a later
 * publisher can invalidate:
 *
 *   1. the PRIORITY -- a measured baseline (1) beats a migrated one (0);
 *   2. the LOCK GENERATION -- the epoch of the lock that published it;
 *   3. the TIMESTAMP -- the measurement that is newer wins;
 *   4. the PUBLICATION SEQUENCE -- the tie-breaker for two measurements
 *      that carry the same timestamp. It is allocated by an EXCLUSIVE
 *      CREATE, so it can never go backwards, and it does not depend on the
 *      position of the record in the log.
 *
 * -- The fences ----------------------------------------------------------
 *
 * Three fences keep a displaced holder from publishing:
 *
 *   1. the EPOCH -- a counter that only ever advances. It is allocated by
 *      an exclusive create, because a counter that is read, incremented
 *      and written back is not monotonic, and a fence that goes backwards
 *      is no fence at all;
 *   2. the TOKEN -- every holder has one. A holder that lost the lock is
 *      registered by its token, and the readers drop everything it
 *      published. The token is PRECISE: the holder that lost the lock is
 *      fenced, and a healthy holder that took the lock in the meantime is
 *      not;
 *   3. the LOCK FILE -- the mutual exclusion between the full build and
 *      the incremental update.
 *
 * -- Who may write the baseline ------------------------------------------
 *
 * ONLY a full build may write it. The incremental path must not, for the
 * obvious reason: if the baseline moved down together with the degraded
 * graph, the threshold would never be crossed again and the fallback
 * would silently stop working. `stampBaseline` is therefore called from
 * the full-rebuild path only, and the incremental path is structurally
 * unable to reach it.
 *
 * The module is dependency-free (node: builtins only) so it can be
 * installed into a consumer project next to the other shared Graphify
 * modules.
 */



const fs = require("node:fs");

const path = require("node:path");

const { spawn } = require("node:child_process");



const {

  BASELINE_FILENAME,

  THRESHOLD_FILENAME,

  baselinePath,

  graphPath,

  pluginDir,

  rebuildLogDir,

  thresholdPath,

  writeFileAtomic,

  publishExclusive,

  readJsonFile,

} = require("./density-files");

const {

  acquireRebuildLock,

  rebuildLockPath,

} = require("./density-lock");

const {

  BASELINE_SCHEMA_VERSION,

  readBaselineSidecar,

  readGraphCounts,

  resolveBaseline,

  migrateMetaBaseline,

  stampBaseline,

  stampBaselineFromGraph,

} = require("./density-baseline");

const {

  pendingDir,

  writePendingUpdate,

  takePendingUpdate,

  completePendingUpdate,

  releasePendingUpdate,

  hasPendingUpdate,

  startPendingDrain,

} = require("./density-pending");



// -- Configuration ----------------------------------------------------------

// The framework defaults are deliberately CONSERVATIVE: a project that
// never configured anything must not start spawning multi-minute full
// rebuilds because of a framework default nobody chose.
const DEFAULT_THRESHOLD = Object.freeze({
  // Below this node count the graph is too small for the ratio to mean
  // anything, and the check is skipped instead of producing noise.
  min_nodes_for_check: 100,
  // The incremental graph must retain at least this fraction of the
  // baseline ratio before the fallback fires.
  ratio_drop_threshold: 0.85,
  // Fallback baseline for a project that has never recorded one. `null`
  // means "no baseline" -> the check is skipped until a full build has
  // produced one. A positive number makes the check active from the start.
  baseline_edge_node_ratio: null,
  // Upper bound for the detached full rebuild.
  full_rebuild_timeout_seconds: 1800,
  // How long to wait before a SECOND rebuild may be started. The rebuild
  // itself is asynchronous, so without this a burst of commits would
  // spawn one rebuild per commit.
  rebuild_cooldown_seconds: 1800,
});


// -- Reading ----------------------------------------------------------------

/**
 * Read the project threshold configuration, merged over the framework
 * defaults. A missing or corrupt file yields the defaults unchanged -- the
 * guard must degrade to "no fallback", never to a crash inside a git hook.
 */
function readThresholdConfig(projectRoot) {
  const config = Object.assign({}, DEFAULT_THRESHOLD);
  const file = thresholdPath(projectRoot);
  if (!fs.existsSync(file)) return config;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return config;
  }
  if (!parsed || typeof parsed !== "object") return config;
  for (const key of Object.keys(DEFAULT_THRESHOLD)) {
    if (!(key in parsed)) continue;
    const value = parsed[key];
    if (value === null || value === undefined) {
      config[key] = null;
      continue;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    config[key] = numeric;
  }
  return config;
}

/**
 * Decide whether the measured density warrants a full rebuild. Pure -- the
 * caller performs the side effect.
 *
 * Returns { trigger, reason, ratio, threshold, baseline, baselineSource }.
 */
function evaluateDensity({ projectRoot, config, counts, baseline, now = null }) {
  const timestamp = now ? new Date(now) : new Date();
  if (!baseline) {
    return { trigger: false, reason: "no_baseline", ratio: null, threshold: null, baseline: null, baselineSource: null };
  }
  const minNodes = Number(config.min_nodes_for_check);
  if (Number.isFinite(minNodes) && minNodes > 0 && counts.nodes < minNodes) {
    return {
      trigger: false,
      reason: "below_min_nodes",
      ratio: null,
      threshold: null,
      baseline: baseline.value,
      baselineSource: baseline.source,
      nodes: counts.nodes,
    };
  }
  if (counts.nodes <= 0) {
    return { trigger: false, reason: "no_nodes", ratio: null, threshold: null, baseline: baseline.value, baselineSource: baseline.source };
  }
  const ratio = counts.edges / counts.nodes;
  const dropFactor = Number.isFinite(Number(config.ratio_drop_threshold)) && Number(config.ratio_drop_threshold) > 0
    ? Number(config.ratio_drop_threshold)
    : DEFAULT_THRESHOLD.ratio_drop_threshold;
  const threshold = baseline.value * dropFactor;
  const trigger = ratio < threshold;
  return {
    trigger,
    reason: trigger ? "density_dropped" : "density_ok",
    ratio,
    threshold,
    baseline: baseline.value,
    baselineSource: baseline.source,
    nodes: counts.nodes,
    edges: counts.edges,
    dropFactor,
    timestamp: timestamp.toISOString(),
  };
}

// -- The detached full rebuild ----------------------------------------------

/**
 * Start a DETACHED full rebuild. The child is unref'd, so the git hook
 * returns immediately and the commit is never blocked.
 *
 * The rebuild runs `graphify .` (full build) and then stamps the new
 * baseline -- that is the ONLY place the baseline is written.
 *
 * Returns { started, pid, logPath, reason? }.
 */
function startFullRebuild({ projectRoot, config, now = null, spawnImpl = null }) {
  const cooldownSeconds = Number(config.rebuild_cooldown_seconds);
  if (Number.isFinite(cooldownSeconds) && cooldownSeconds > 0) {
    const last = readLastRebuildTime(projectRoot);
    if (last) {
      const elapsed = (Date.now() - last) / 1000;
      if (elapsed < cooldownSeconds) {
        return {
          started: false,
          reason: "rebuild_cooldown",
          retryAfterSeconds: Math.ceil(cooldownSeconds - elapsed),
        };
      }
    }
  }

  // Refuse when a rebuild is already running. The cooldown check above only
  // READS the state file, so two post-commit hooks running at the same time
  // both see "no recent rebuild" and both start one; the lock file is the
  // signal that one is in flight.
  //
  // The check is a REFUSAL, so a stale judgement is harmless: it can only
  // make this call skip a rebuild that another one is already doing. The
  // runner itself takes the lock, so the mutual exclusion does not depend
  // on this check.
  if (fs.existsSync(rebuildLockPath(projectRoot))) {
    return { started: false, reason: "rebuild_in_progress" };
  }

  const logDir = rebuildLogDir(projectRoot);
  let logPath;
  let out;
  let err;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = (now || new Date().toISOString()).replace(/[:.]/g, "-");
    logPath = path.join(logDir, `full-rebuild-${stamp}.log`);
    out = fs.openSync(logPath, "a");
    err = fs.openSync(logPath, "a");
  } catch (_) {
    return { started: false, reason: "log_open_failed" };
  }

  const timeoutSeconds = Number(config.full_rebuild_timeout_seconds);
  const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? Math.round(timeoutSeconds * 1000)
    : DEFAULT_THRESHOLD.full_rebuild_timeout_seconds * 1000;

  // The full build MUST be a real full build. `graphify .` is shorthand for
  // `graphify extract .`, and extract ENTERS INCREMENTAL MODE whenever a
  // graph.json already exists -- only `--force` turns that off (verified
  // against graphify 0.9.27, cli.py: incremental_mode = existing_graph and
  // not force). A "full" rebuild that silently ran incrementally would stamp
  // the DEGRADED ratio as the new baseline and the guard would never fire
  // again.
  //
  // The timeout and the lock release both belong to the PROCESS that runs
  // the rebuild -- not to an external watchdog. An external watchdog has to
  // track the child's liveness across process boundaries, and every such
  // mechanism has a failure mode of its own (an unreferenced timer exits
  // early, a mis-indexed argument reads the wrong value, a signal kills the
  // watcher without killing the child). The runner below owns the timeout,
  // the lock and the stamp in ONE process, so all three end together.
  //
  // The runner is a FILE, not an inline `node -e` script: an inline script
  // receives its arguments at `process.argv[1]`, and getting that index
  // wrong silently passes the timeout where the PID belongs.
  //
  // The runner takes the rebuild lock ITSELF. It used to inherit the lock
  // from this process through the environment, and the handover was a
  // source of a whole class of races: the parent validated the token and
  // then rewrote the lock file, so a child that had already released the
  // lock -- or exited -- saw the lock RECREATED by the parent's write. The
  // lock then looked held for the whole stale window and every drain was
  // refused. With the runner taking the lock itself there is no handover
  // and no window.
  const runner = path.join(__dirname, "full-rebuild-runner.js");
  const spawnChild = spawnImpl || spawn;
  let child;
  try {
    child = spawnChild(process.execPath, [runner], {
      cwd: projectRoot,
      stdio: ["ignore", out, err],
      detached: true,
      env: Object.assign({}, process.env, {
        GRAPHIFY_FULL_REBUILD_TIMEOUT_MS: String(timeoutMs),
      }),
    });
  } catch (_) {
    closeDescriptors(out, err);
    return { started: false, reason: "spawn_failed", logPath };
  }

  // An asynchronous spawn failure is reported through the `error` event,
  // NOT through a throw -- the try/catch above cannot see it. The listener
  // therefore has to release the lock and report the failure, otherwise the
  // lock is leaked until the stale reaper runs and every incremental update
  // is skipped in the meantime.
  child.on("error", () => {
    closeDescriptors(out, err);
    writeRebuildState(projectRoot, { startedAt: new Date().toISOString(), pid: null, logPath, failed: true });
  });
  child.unref();
  closeDescriptors(out, err);
  writeRebuildState(projectRoot, {
    startedAt: new Date().toISOString(),
    pid: child.pid,
    logPath,
  });
  return {
    started: true,
    pid: child.pid,
    logPath,
    timeoutSeconds,
    runner,
  };
}

function closeDescriptors(out, err) {
  for (const fd of [out, err]) {
    try { fs.closeSync(fd); } catch (_) { /* already closed */ }
  }
}

// The rebuild state file records when the last rebuild was started, so the
// cooldown can suppress a burst of rebuilds after a batch of commits.
function rebuildStatePath(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-rebuild-state.json");
}

function writeRebuildState(projectRoot, payload) {
  try {
    const file = rebuildStatePath(projectRoot);
    writeFileAtomic(file, JSON.stringify(payload, null, 2) + "\n");
  } catch (_) { /* best-effort */ }
}

function readLastRebuildTime(projectRoot) {
  const file = rebuildStatePath(projectRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const startedAt = parsed && parsed.startedAt ? Date.parse(parsed.startedAt) : NaN;
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch (_) {
    return null;
  }
}

// -- The public entry point ------------------------------------------------

/**
 * Run the density guard AFTER a successful incremental update.
 *
 * Never throws. Returns a structured decision the caller can log:
 *   { checked, trigger, reason, ratio, threshold, baseline, baselineSource,
 *     rebuild: { started, pid, logPath } | null }
 */
function checkAndMaybeRebuild({ projectRoot, config = null, counts = null, now = null }) {
  if (!projectRoot) {
    return { checked: false, reason: "no_project_root", trigger: false, rebuild: null };
  }
  try {
    const effectiveConfig = config || readThresholdConfig(projectRoot);
    const graphCounts = counts || readGraphCounts(projectRoot);
    if (!graphCounts.present) {
      return { checked: false, reason: "graph_missing", trigger: false, rebuild: null };
    }
    const baseline = resolveBaseline(projectRoot, effectiveConfig, graphCounts);
    const decision = evaluateDensity({
      projectRoot,
      config: effectiveConfig,
      counts: graphCounts,
      baseline,
      now,
    });
    if (!decision.trigger) {
      return Object.assign({}, decision, { checked: true, rebuild: null });
    }
    const rebuild = startFullRebuild({ projectRoot, config: effectiveConfig, now });
    return Object.assign({}, decision, { checked: true, rebuild });
  } catch (err) {
    return {
      checked: false,
      trigger: false,
      reason: "density_check_failed",
      error: err && err.message ? err.message : String(err),
      rebuild: null,
    };
  }
}



module.exports = {

  DEFAULT_THRESHOLD,

  THRESHOLD_FILENAME,

  BASELINE_FILENAME,

  BASELINE_SCHEMA_VERSION,

  readThresholdConfig,

  readBaselineSidecar,

  readGraphCounts,

  resolveBaseline,

  migrateMetaBaseline,

  evaluateDensity,

  stampBaseline,

  stampBaselineFromGraph,

  startFullRebuild,

  checkAndMaybeRebuild,

  readLastRebuildTime,

  rebuildStatePath,

  pendingDir,

  writePendingUpdate,

  takePendingUpdate,

  completePendingUpdate,

  releasePendingUpdate,

  hasPendingUpdate,

  startPendingDrain,

  writeFileAtomic,

  publishExclusive,

  readJsonFile,

  acquireRebuildLock,

  rebuildLockPath,

  pluginDir,

  thresholdPath,

  baselinePath,

  graphPath,

  rebuildLogDir,

};
