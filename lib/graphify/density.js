"use strict";

/**
 * Graphify edge-density fallback (issue #154).
 *
 * `graphify update .` only re-extracts the files that the last commit
 * touched. Global `contains` / doc-reference edges are therefore NOT
 * refreshed, so the edge/node ratio of an incrementally updated graph
 * is lower than the ratio of a fully built graph. The gap widens with
 * every commit, and the knowledge graph degrades monotonically.
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
 * carries the consumer-side convention keeps working), but it is never
 * written by the incremental path.
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
const crypto = require("node:crypto");

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

const THRESHOLD_FILENAME = "threshold.json";
const BASELINE_FILENAME = ".density-baseline.json";
const BASELINE_SCHEMA_VERSION = "1.0";

// How many times a deferred update may be replayed before the runner stops
// respawning itself for it. Without a bound, a permanently failing
// `graphify update .` would make every runner start another runner, and
// the project would spawn processes forever.
const PENDING_MAX_ATTEMPTS = 5;

// How long a trim mutex left behind by a crashed reclaimer is honoured
// before it is removed. The mutex is held for the duration of a judgement
// and a file removal, so a minute is already an eternity for it.
const TRIM_MUTEX_STALE_MS = 60 * 1000;

// Where the detached rebuild writes its log. The framework's runtime
// artifact convention requires every artifact to live under `.agent/`,
// never in the temp directory.
function rebuildLogDir(projectRoot) {
  return path.join(projectRoot, ".agent", "logs", "graphify");
}

function pluginDir(projectRoot) {
  return path.join(projectRoot, ".agent", "plugins", "graphify");
}

function thresholdPath(projectRoot) {
  return path.join(pluginDir(projectRoot), THRESHOLD_FILENAME);
}

function baselinePath(projectRoot) {
  return path.join(pluginDir(projectRoot), BASELINE_FILENAME);
}

function graphPath(projectRoot) {
  return path.join(projectRoot, "graphify-out", "graph.json");
}

// -- Atomic, exclusive writes ------------------------------------------------

/**
 * Write a file atomically, using a temp name that NO other writer can use.
 *
 * A shared temp name (`target.tmp`) is not safe under concurrency: writer A
 * can finish its temp file and rename it while writer B is still writing into
 * the SAME path, so A publishes B's half-written file and B's rename then
 * publishes nothing. The result is a corrupt state file that a reader cannot
 * parse. Making the temp name unique per writer (pid + random suffix) makes
 * the rename publish exactly the bytes that writer wrote.
 *
 * The temp file is removed when the write fails, so a crashed writer never
 * leaves a stale temp file behind.
 */
function writeFileAtomic(target, body) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const unique = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = path.join(dir, `.${path.basename(target)}.tmp-${unique}`);
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, target);
  } catch (err) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch (_) { /* already closed */ }
    }
    try { fs.unlinkSync(temporary); } catch (_) { /* nothing to clean up */ }
    throw err;
  }
}

// -- Exclusive publication ---------------------------------------------------

// Publish a file so that exactly one writer wins and the CONTENT is never
// observed half-written.
//
// `link()` is the primitive that gives both properties at once: it fails
// with EEXIST when the target exists, and it publishes the temp file's
// bytes in one atomic step. But hard links are not available on every
// filesystem (FAT32, some network mounts, some container volumes), and
// `linkSync` there fails with EOPNOTSUPP / ENOSYS / EPERM. A publication
// that only works on link-capable filesystems silently loses data
// elsewhere -- the baseline would never be written and the pending queue
// would never be filled, while the caller carried on as if it had worked.
//
// So the link is the fast path, and a direct exclusive create is the
// fallback. The fallback cannot be atomic in the same way, so a reader
// has to tolerate a momentarily incomplete file: `readJsonFile` retries
// the parse a few times before giving up.
function isLinkUnsupported(err) {
  if (!err || !err.code) return false;
  return err.code === "EOPNOTSUPP"
    || err.code === "ENOTSUP"
    || err.code === "ENOSYS"
    || err.code === "EPERM"
    || err.code === "EXDEV"
    || err.code === "EACCES";
}

/**
 * Publish `body` at `target` exclusively.
 *
 * Returns { created: true } when this call published the file,
 * { created: false, reason: "already_exists" } when somebody else got
 * there first. Throws when the publication failed for any other reason.
 */
function publishExclusive(target, body) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const unique = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = path.join(dir, `.${path.basename(target)}.tmp-${unique}`);
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (err) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch (_) { /* already closed */ }
    }
    try { fs.unlinkSync(temporary); } catch (_) { /* nothing to clean up */ }
    throw err;
  }

  try {
    // link() fails when the target already exists, so a concurrent writer
    // wins instead of being overwritten.
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    return { created: true, degraded: false };
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (_) { /* nothing to clean up */ }
    if (err && err.code === "EEXIST") {
      return { created: false, reason: "already_exists", degraded: false };
    }
    if (!isLinkUnsupported(err)) throw err;
  }

  // Fallback for filesystems without hard links: create the target
  // EXCLUSIVELY and write into it. The name is reserved atomically, so
  // two writers still cannot both publish; only the window in which a
  // reader can observe a partially written file is larger, which is why
  // `readJsonFile` retries the parse.
  let targetHandle;
  try {
    targetHandle = fs.openSync(target, "wx", 0o600);
    fs.writeFileSync(targetHandle, body);
    fs.fsyncSync(targetHandle);
    fs.closeSync(targetHandle);
    targetHandle = undefined;
    return { created: true, degraded: true };
  } catch (err) {
    if (targetHandle !== undefined) {
      try { fs.closeSync(targetHandle); } catch (_) { /* already closed */ }
    }
    if (err && err.code === "EEXIST") {
      return { created: false, reason: "already_exists", degraded: true };
    }
    throw err;
  }
}

/**
 * Sleep synchronously for a few milliseconds. Used to let a concurrent
 * writer finish the file it is publishing before the parse is retried.
 */
function sleepSync(ms) {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  } catch (_) {
    // A host without Atomics.wait simply does not wait; the retry loop
    // still gives the writer another chance.
  }
}

/**
 * Read and parse a JSON file, retrying briefly when the parse fails.
 *
 * A file published through the non-atomic fallback path can be observed
 * for a moment before its content is complete. Retrying turns that into
 * a non-event; a genuinely corrupt file still yields null.
 *
 * Returns the parsed value, or null when it cannot be read or parsed.
 */
function readJsonFile(file, { attempts = 5, delayMs = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (_) {
      if (attempt + 1 < attempts) sleepSync(delayMs);
    }
  }
  return null;
}

// -- The rebuild lock --------------------------------------------------------

// The lock serialises the FULL rebuild against itself and against the
// incremental update. Without it the two paths interleave: the incremental
// update can publish a degraded graph between the full build's write and its
// baseline stamp, and the stamp then records the DEGRADED ratio as the new
// "full" baseline -- exactly the state the guard exists to prevent.
//
// The lock is an exclusive-create file. `open(..., "wx")` is atomic on every
// supported platform, so exactly one writer wins and the losers degrade to
// "skip" instead of corrupting the graph or the baseline.
function rebuildLockPath(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-rebuild.lock");
}

/**
 * The trim mutex: a short-lived lock that serialises the RECLAIM of a stale
 * rebuild lock.
 *
 * It is a separate file next to the lock, because the lock itself is the
 * thing being reclaimed -- a mutex on the lock file could not protect the
 * removal of that very file. It is held only for the duration of the
 * judgement and the removal, so it never blocks a writer that finds a
 * healthy lock.
 *
 * Returns a handle with `release()`, or null when another reclaimer holds
 * the mutex (in which case the caller simply gives up: the other reclaimer
 * is already handling the stale lock).
 */
function acquireTrimMutex(lockFile) {
  const file = lockFile + ".trim";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(handle);
    }
    return {
      path: file,
      release() {
        try { fs.unlinkSync(file); return true; } catch (_) { return false; }
      },
    };
  } catch (err) {
    if (err && err.code === "EEXIST") {
      // Another reclaimer is working on it. A trim mutex left behind by a
      // crashed process would block the reclaim forever, so an old one is
      // removed -- but only when it is demonstrably old.
      const age = safeMtime(file);
      if (Number.isFinite(age) && Date.now() - age > TRIM_MUTEX_STALE_MS) {
        try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
      }
      return null;
    }
    return null;
  }
}

/**
 * The mtime of a file, or NaN when it cannot be read.
 */
function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return NaN;
  }
}

/**
 * Try to acquire the rebuild lock. Returns a handle with a `release()` that
 * removes the lock file, or null when the lock is held by someone else.
 *
 * The lock file carries a random TOKEN. `release()` removes the file only
 * when the token still matches, so a holder whose lock was reclaimed as
 * stale cannot delete the NEW holder's lock. Without the token, the
 * sequence "A releases, B acquires, A releases again" would leave B
 * believing it holds the lock while the file is gone -- and a third writer
 * would then acquire it, so the mutual exclusion would silently break.
 */
function acquireRebuildLock(projectRoot, { staleMs = 6 * 60 * 60 * 1000, onStaleJudged = null } = {}) {
  const file = rebuildLockPath(projectRoot);
  const token = crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }));
    } finally {
      fs.closeSync(handle);
    }
    return {
      path: file,
      token,
      /**
       * Hand the lock over to another process.
       *
       * The lock records the PID of the process that HOLDS it, because that
       * is what the stale reaper checks. The hook that starts a detached
       * rebuild exits immediately, so a lock that still named the hook's PID
       * would look abandoned while the rebuild is still running -- and the
       * next hook would reclaim it and race the rebuild.
       *
       * The token is deliberately NOT changed: the lock is the SAME lock,
       * now owned by the rebuild process.
       */
      transferTo(pid) {
        if (!Number.isFinite(pid) || pid <= 0) return false;
        try {
          const current = JSON.parse(fs.readFileSync(file, "utf8"));
          if (!current || current.token !== token) return false;
          fs.writeFileSync(file, JSON.stringify({
            token,
            pid,
            acquiredAt: current.acquiredAt || new Date().toISOString(),
            transferredAt: new Date().toISOString(),
          }));
          return true;
        } catch (_) {
          return false;
        }
      },
      release() {
        // Only remove the lock when it is still OURS. A lock that was
        // reclaimed as stale belongs to somebody else now.
        try {
          const current = JSON.parse(fs.readFileSync(file, "utf8"));
          if (current && current.token && current.token !== token) return false;
        } catch (err) {
          if (err && err.code === "ENOENT") return false;
          // A corrupt lock file is removed: it cannot be attributed to any
          // holder, and leaving it would block every future writer.
        }
        try { fs.unlinkSync(file); return true; } catch (_) { return false; }
      },
    };
  } catch (err) {
    if (!err || err.code !== "EEXIST") return null;
    // A lock left behind by a crashed rebuild must not block the project
    // forever. Reclaim it when it is clearly older than the longest
    // plausible rebuild OR when the process that held it is gone.
    try {
      const holder = readLockHolder(file);
      // The age comes from the lock's OWN record, not from the file's mtime:
      // the mtime is whenever the holder last wrote the file, which for a
      // handed-over lock is the handover, not the acquisition.
      const recordedAt = holder && holder.acquiredAt ? Date.parse(holder.acquiredAt) : NaN;
      const age = Number.isFinite(recordedAt)
        ? Date.now() - recordedAt
        : Date.now() - fs.statSync(file).mtimeMs;
      const holderAlive = holder && holder.pid ? isProcessAlive(holder.pid) : false;
      // A lock is reclaimed only when its holder is GONE. Age alone is not
      // enough: a rebuild that legitimately runs for hours would have its
      // lock reclaimed under it, and the next writer would race it.
      //
      // The age is only consulted for a lock that names no live process at
      // all -- a lock written by a crashed process, or one whose holder
      // cannot be identified (an old-format lock without a PID).
      const reclaimable = holder && holder.pid
        ? (!holderAlive && age > staleMs)
        : age > staleMs;
      if (reclaimable) {
        // The reclaim is serialised by a SECOND, short-lived mutex -- the
        // "trim" mutex. Without it the reclaim is a check-then-act: two
        // writers can both read the same dead lock, both conclude it is
        // stale, and the second one then removes the NEW lock the first one
        // just took -- so both believe they hold the lock and the mutual
        // exclusion is silently gone.
        //
        // The trim mutex makes the reclaim safe by construction:
        //
        //   1. only one reclaimer runs at a time, so no two writers can
        //      interleave their judgements;
        //   2. the judgement is RE-READ under the mutex, so the reclaim
        //      acts on the generation it actually re-checked, not on the
        //      one it saw before waiting;
        //   3. while the lock file exists, a new holder CANNOT create it
        //      (the create is exclusive), and the holder is dead so it
        //      will not release it -- so the file cannot change between
        //      the re-read and the removal.
        const trim = acquireTrimMutex(file);
        if (!trim) return null;
        try {
          const current = readLockHolder(file);
          const currentAt = current && current.acquiredAt ? Date.parse(current.acquiredAt) : NaN;
          const currentAge = Number.isFinite(currentAt)
            ? Date.now() - currentAt
            : Date.now() - safeMtime(file);
          const currentAlive = current && current.pid ? isProcessAlive(current.pid) : false;
          const stillReclaimable = current && current.pid
            ? (!currentAlive && currentAge > staleMs)
            : currentAge > staleMs;
          if (!stillReclaimable) return null;
          // A TEST HOOK: called after the final judgement and BEFORE the
          // removal. It lets a test inject the interleaving that makes the
          // race observable -- without it, the window between the judgement
          // and the removal is far too narrow to hit reliably.
          if (typeof onStaleJudged === "function") {
            try { onStaleJudged(); } catch (_) { /* the hook must not break the lock */ }
          }
          try {
            fs.unlinkSync(file);
          } catch (_) {
            return null;
          }
        } finally {
          trim.release();
        }
        // The lock file is free now, so the exclusive create below
        // succeeds for exactly one caller.
        return acquireRebuildLock(projectRoot, { staleMs, onStaleJudged });
      }
    } catch (_) { /* the lock disappeared; fall through */ }
    return null;
  }
}

/**
 * Read the lock holder record. Returns null when the file is unreadable.
 */
function readLockHolder(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * Whether a process is still running. Signal 0 performs the permission and
 * existence checks without delivering a signal.
 */
function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return Boolean(err && err.code === "EPERM");
  }
}

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
 * Read the durable baseline sidecar. Returns null when there is none or
 * when it is unusable.
 */
function readBaselineSidecar(projectRoot) {
  const file = baselinePath(projectRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const ratio = Number(parsed.edge_node_ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Read the node / edge counts and `_meta` from `graphify-out/graph.json`.
 * Never throws -- a corrupt graph simply yields zero counts.
 */
function readGraphCounts(projectRoot) {
  const file = graphPath(projectRoot);
  const empty = { nodes: 0, edges: 0, meta: {}, present: false };
  if (!fs.existsSync(file)) return empty;
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return empty;
  }
  if (!graph || typeof graph !== "object") return empty;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  // Graphify writes `links`; older/other shapes use `edges`.
  const edges = Array.isArray(graph.links)
    ? graph.links.length
    : (Array.isArray(graph.edges) ? graph.edges.length : 0);
  const meta = (graph._meta && typeof graph._meta === "object") ? graph._meta : {};
  return { nodes, edges, meta, present: true };
}

/**
 * Resolve the baseline ratio and its provenance.
 *
 * Priority (highest first):
 *   1. the durable sidecar -- survives the incremental update that erases
 *      `graph.json._meta`;
 *   2. `graph.json._meta.edge_node_ratio` -- the consumer-side convention,
 *      honoured when a project already carries it;
 *   3. the configured `baseline_edge_node_ratio`;
 *   4. nothing -> the caller skips the check.
 */
function resolveBaseline(projectRoot, config, counts) {
  const sidecar = readBaselineSidecar(projectRoot);
  if (sidecar) {
    return { value: Number(sidecar.edge_node_ratio), source: "density_baseline_sidecar" };
  }
  const metaRatio = counts && counts.meta ? Number(counts.meta.edge_node_ratio) : NaN;
  if (Number.isFinite(metaRatio) && metaRatio > 0) {
    return { value: metaRatio, source: "graph_meta" };
  }
  const configRatio = Number(config.baseline_edge_node_ratio);
  if (Number.isFinite(configRatio) && configRatio > 0) {
    return { value: configRatio, source: "threshold_config" };
  }
  return null;
}

/**
 * Migrate a `graph.json._meta.edge_node_ratio` baseline into the durable
 * sidecar.
 *
 * This has to happen BEFORE the incremental update, not after. `graphify
 * update .` rewrites graph.json and drops every key the CLI does not own,
 * `_meta` included. A project that carried the consumer-side convention
 * (`_meta`) and has no sidecar yet would therefore lose its baseline on
 * the very first commit after the upgrade -- the guard would report
 * `no_baseline` and never fire again.
 *
 * The migration only ever ADDS the sidecar when there is none; an existing
 * sidecar is authoritative and is never overwritten by a `_meta` value.
 *
 * Returns { migrated, reason, ratio? }.
 */
function migrateMetaBaseline(projectRoot, counts = null) {
  try {
    if (readBaselineSidecar(projectRoot)) {
      return { migrated: false, reason: "sidecar_present" };
    }
    const graphCounts = counts || readGraphCounts(projectRoot);
    const meta = graphCounts && graphCounts.meta ? graphCounts.meta : {};
    const ratio = Number(meta.edge_node_ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return { migrated: false, reason: "no_meta_baseline" };
    }
    const nodes = Number(meta.nodes) || graphCounts.nodes || 0;
    const edges = Number(meta.edges) || Math.round(ratio * (graphCounts.nodes || 0));
    const payload = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      build_kind: String(meta.build_kind || "full"),
      edge_node_ratio: Number(ratio.toFixed(4)),
      nodes,
      edges,
      baseline_locked_at: meta.baseline_locked_at || new Date().toISOString(),
      migrated_from: "graph_meta",
    };
    // The migration is a CREATE, never an overwrite. A full rebuild that
    // finished in the meantime may already have published a newer baseline;
    // replacing it with the older _meta value would LOWER the threshold
    // and weaken the guard. An exclusive create loses the race harmlessly:
    // the newer baseline stays.
    // The migration is a CREATE, never an overwrite. A full rebuild that
    // finished in the meantime may already have published a newer baseline;
    // replacing it with the older _meta value would LOWER the threshold
    // and weaken the guard. The exclusive create loses the race harmlessly:
    // the newer baseline stays.
    const published = publishExclusive(
      baselinePath(projectRoot),
      JSON.stringify(payload, null, 2) + "\n",
    );
    if (!published.created) {
      return { migrated: false, reason: "sidecar_present" };
    }
    return { migrated: true, reason: "migrated", ratio };
  } catch (err) {
    return {
      migrated: false,
      reason: err && err.code ? err.code : "migration_failed",
    };
  }
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

// -- Writing the baseline (full builds only) --------------------------------

/**
 * Stamp the measured ratio as the new baseline. Called ONLY after a FULL
 * build has completed. The incremental path never reaches this function,
 * which is what keeps the baseline from drifting down with the graph.
 *
 * Writes the sidecar AND mirrors the value into `graph.json._meta`, so a
 * project that reads the consumer-side convention still finds it. The
 * `_meta` mirror is best-effort: the incremental update erases it again,
 * and the sidecar is the durable copy.
 *
 * Returns { ok, ratio, sidecarPath, metaStamped }.
 */
function stampBaseline(projectRoot, { nodes, edges, buildKind = "full", now = null } = {}) {
  const nodeCount = Math.max(0, Number(nodes) || 0);
  const edgeCount = Math.max(0, Number(edges) || 0);
  if (nodeCount <= 0) {
    return { ok: false, reason: "no_nodes" };
  }
  const ratio = edgeCount / nodeCount;
  const timestamp = now || new Date().toISOString();
  const payload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    build_kind: buildKind,
    edge_node_ratio: Number(ratio.toFixed(4)),
    nodes: nodeCount,
    edges: edgeCount,
    baseline_locked_at: timestamp,
  };
  const sidecar = baselinePath(projectRoot);
  try {
    writeFileAtomic(sidecar, JSON.stringify(payload, null, 2) + "\n");
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "sidecar_write_failed", ratio };
  }
  const metaStamped = stampGraphMeta(projectRoot, payload);
  return { ok: true, ratio, sidecarPath: sidecar, metaStamped, payload };
}

/**
 * Stamp the baseline from the CURRENT graph file, but only when the graph
 * still holds the counts the caller measured.
 *
 * The rebuild and the incremental update can interleave: the full build
 * writes the graph, and an incremental update that started earlier
 * publishes its own (degraded) graph before the rebuild reads it back. The
 * rebuild would then stamp the DEGRADED ratio as the new "full" baseline,
 * and the guard would never fire again.
 *
 * The caller therefore passes the counts it measured right after the build.
 * If the graph no longer matches them, the stamp is refused: the baseline
 * stays at the previous value, which is conservative (the guard keeps
 * firing) instead of being dragged down with the degraded graph.
 *
 * Returns { ok, ratio?, reason? }.
 */
function stampBaselineFromGraph(projectRoot, { expectedNodes = null, expectedEdges = null, buildKind = "full", now = null } = {}) {
  const counts = readGraphCounts(projectRoot);
  if (!counts.present) {
    return { ok: false, reason: "graph_missing" };
  }
  if (expectedNodes !== null && Number(expectedNodes) !== counts.nodes) {
    return { ok: false, reason: "graph_changed_during_rebuild", nodes: counts.nodes };
  }
  if (expectedEdges !== null && Number(expectedEdges) !== counts.edges) {
    return { ok: false, reason: "graph_changed_during_rebuild", edges: counts.edges };
  }
  const stamp = stampBaseline(projectRoot, {
    nodes: counts.nodes,
    edges: counts.edges,
    buildKind,
    now,
  });
  if (!stamp.ok) return stamp;
  return Object.assign({}, stamp, { nodes: counts.nodes, edges: counts.edges });
}

/**
 * Mirror the baseline into `graph.json._meta`. Best-effort: the file may be
 * rewritten by the next incremental update, which is expected and handled
 * by the sidecar.
 *
 * The mirror must NOT roll the graph back. A read-modify-write of the whole
 * graph file publishes the snapshot that was READ, so a graph that was
 * replaced between the read and the write is silently reverted -- a newer,
 * larger graph replaced by an older one.
 *
 * The primary protection is the rebuild lock: the full rebuild and the
 * incremental update both hold it, so no other writer can be inside this
 * read-modify-write window. The byte comparison below is defence in depth
 * for a writer that does not take the lock.
 */
function stampGraphMeta(projectRoot, payload) {
  const file = graphPath(projectRoot);
  if (!fs.existsSync(file)) return false;
  let raw;
  let identity;
  try {
    raw = fs.readFileSync(file, "utf8");
    const stat = fs.statSync(file);
    identity = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (_) {
    return false;
  }
  try {
    const graph = JSON.parse(raw);
    if (!graph || typeof graph !== "object") return false;
    graph._meta = Object.assign({}, graph._meta || {}, {
      build_kind: payload.build_kind,
      edge_node_ratio: payload.edge_node_ratio,
      baseline_locked_at: payload.baseline_locked_at,
    });
    // Compare-and-swap on the CONTENT. The bytes that were parsed are
    // compared with the bytes on disk: a writer that replaced the graph in
    // the meantime leaves different content, and publishing our snapshot
    // would roll that newer graph back.
    let currentRaw;
    try {
      currentRaw = fs.readFileSync(file, "utf8");
    } catch (_) {
      return false;
    }
    if (currentRaw !== raw) return false;
    writeFileAtomic(file, JSON.stringify(graph, null, 2));
    return true;
  } catch (_) {
    return false;
  }
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

  // Claim the rebuild slot BEFORE spawning. The cooldown check above only
  // READS the state file, so two post-commit hooks running at the same time
  // both see "no recent rebuild" and both start one. The claim below is an
  // exclusive create: exactly one writer wins, the other skips.
  const lock = acquireRebuildLock(projectRoot);
  if (!lock) {
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
    lock.release();
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
        GRAPHIFY_REBUILD_LOCK_PATH: lock.path,
        GRAPHIFY_REBUILD_LOCK_TOKEN: lock.token,
      }),
    });
  } catch (_) {
    closeDescriptors(out, err);
    lock.release();
    return { started: false, reason: "spawn_failed", logPath };
  }

  // An asynchronous spawn failure is reported through the `error` event,
  // NOT through a throw -- the try/catch above cannot see it. The listener
  // therefore has to release the lock and report the failure, otherwise the
  // lock is leaked until the stale reaper runs and every incremental update
  // is skipped in the meantime.
  child.on("error", () => {
    closeDescriptors(out, err);
    lock.release();
    writeRebuildState(projectRoot, { startedAt: new Date().toISOString(), pid: null, logPath, failed: true });
  });
  child.unref();
  closeDescriptors(out, err);
  // Hand the lock over to the DETACHED runner. The hook that started it
  // exits immediately, so a lock that still named the HOOK's pid would look
  // abandoned while the rebuild is still running -- and the next hook would
  // reclaim it and race the rebuild. The runner's own pid is what the stale
  // reaper must see.
  lock.transferTo(child.pid);
  // The lock is owned by the DETACHED runner from here on: the runner takes
  // it over so the full build and the incremental update stay mutually
  // exclusive for the whole rebuild, not just for the spawn.
  writeRebuildState(projectRoot, {
    startedAt: new Date().toISOString(),
    pid: child.pid,
    logPath,
    lockPath: lock.path,
  });
  // The lock is owned by the DETACHED child from here on: the wrapper takes
  // it over so the full build and the incremental update stay mutually
  // exclusive for the whole rebuild, not just for the spawn.
  return {
    started: true,
    pid: child.pid,
    logPath,
    timeoutSeconds,
    runner,
    lockPath: lock.path,
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

// -- The pending update queue ------------------------------------------------

// When the rebuild lock is held, an incremental update cannot run: the full
// rebuild that holds the lock is about to publish a complete graph, and a
// second writer would only race it. The request is not LOST, though -- it
// is recorded in a pending queue and replayed once the lock is free.
//
// The queue is a DIRECTORY of one-file-per-request, not a single JSON
// document. A single document cannot express the state transitions safely:
// two writers would overwrite each other's paths, a consumer that read the
// document and then deleted it would also delete whatever a writer had
// published in between, and two consumers would both claim the same
// request. One file per request removes all three races:
//
//   - a writer creates its file EXCLUSIVELY, so two writers never collide;
//   - a consumer removes the file it read, and only the consumer whose
//     removal succeeds owns the request;
//   - a writer publishing a NEW file is unaffected by a consumer removing an
//     OLD one.
//
// The file name is derived from the request's paths, so two requests for the
// same paths collapse into one -- they describe the same work.
//
// The name also carries a UNIQUE suffix. Without it, a file name identifies
// the request only as long as it is the only file with that name: a
// consumer that read the file, then a writer that removed and recreated the
// SAME name, then the consumer's unlink would delete the NEW file while the
// consumer processed the OLD content -- the new request is lost and the old
// one is replayed twice. The unique suffix makes every generation of a
// request a distinct file, so a consumer can only ever remove the exact
// file it read.
function pendingDir(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-pending");
}

function pendingFileName(changedPaths) {
  const sorted = [...new Set(changedPaths.map((p) => String(p)))].sort();
  const digest = crypto.createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 32);
  const unique = process.pid + "-" + crypto.randomBytes(6).toString("hex");
  return digest + "-" + unique + ".json";
}

/**
 * Record that an incremental update still has to run.
 *
 * Returns { ok, path }.
 */
function writePendingUpdate(projectRoot, { changedPaths = [], sourceHead = null, branch = null, attempts = 0 } = {}) {
  const paths = [...new Set(changedPaths.map((p) => String(p)).filter(Boolean))].sort();
  if (paths.length === 0) return { ok: false, reason: "no_paths" };
  const dir = pendingDir(projectRoot);
  const target = path.join(dir, pendingFileName(paths));
  const payload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    changedPaths: paths,
    sourceHead: sourceHead || null,
    branch: branch || null,
    attempts: Number(attempts) || 0,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // The target name is unique, so the exclusive create always succeeds:
    // two writers never collide, and a writer publishing a NEW request is
    // never affected by a consumer removing an OLD one.
    publishExclusive(target, JSON.stringify(payload, null, 2) + "\n");
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "pending_write_failed" };
  }
}

/**
 * Whether the pending queue holds at least one request.
 */
function hasPendingUpdate(projectRoot) {
  try {
    const dir = pendingDir(projectRoot);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch (_) {
    return false;
  }
}

/**
 * Claim the pending requests. A request is owned by the caller that
 * successfully REMOVED its file, so two consumers never process the same
 * request.
 *
 * Returns a merged request, or null when there is nothing queued.
 */
function takePendingUpdate(projectRoot) {
  const dir = pendingDir(projectRoot);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const claimed = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    // CLAIM the file by renaming it to a name only this consumer knows.
    // The rename is atomic, so exactly one consumer can move a given file
    // and only the consumer whose rename succeeded owns the request. A
    // writer that publishes a new request creates a DIFFERENT file and is
    // unaffected.
    //
    // The earlier implementation read the file and then unlinked it, which
    // is a check-then-act: between the read and the unlink the file could
    // have been removed and RECREATED under the same name, so the unlink
    // deleted the new request while the consumer replayed the old content.
    // The unique file names make that race impossible to express, and the
    // rename claim makes it impossible to win anyway.
    const claimedPath = path.join(
      dir,
      ".claimed-" + process.pid + "-" + crypto.randomBytes(6).toString("hex") + ".json",
    );
    try {
      fs.renameSync(file, claimedPath);
    } catch (_) {
      continue;
    }
    const parsed = readJsonFile(claimedPath);
    try {
      fs.unlinkSync(claimedPath);
    } catch (_) {
      // The claimed file stays behind if it cannot be removed; it is dot
      // prefixed and never read again, so it cannot block the queue.
    }
    if (!parsed || typeof parsed !== "object") continue;
    try {
      claimed.push({
        changedPaths: Array.isArray(parsed.changedPaths) ? parsed.changedPaths : [],
        sourceHead: parsed.sourceHead || null,
        branch: parsed.branch || null,
        attempts: Number(parsed.attempts) || 0,
      });
    } catch (_) {
      // A corrupt request is dropped; it must not block the queue forever.
    }
  }
  if (claimed.length === 0) return null;
  return {
    changedPaths: [...new Set(claimed.flatMap((c) => c.changedPaths))].sort(),
    sourceHead: (claimed.find((c) => c.sourceHead) || {}).sourceHead || null,
    branch: (claimed.find((c) => c.branch) || {}).branch || null,
    attempts: claimed.reduce((max, c) => Math.max(max, c.attempts || 0), 0),
  };
}

/**
 * Start a DETACHED drain of the pending queue.
 *
 * A request that arrived while the lock was busy waits in the queue. The
 * holder of the lock drains it when it releases, so the request is not left
 * waiting for a later commit that may never come.
 *
 * The drain runs in the framework's own runner, in its "--drain-pending"
 * mode: it takes the lock itself, so it cannot race a rebuild that is
 * starting at the same time.
 *
 * Returns { started, pid } or { started: false, reason }.
 */
function startPendingDrain({ projectRoot }) {
  if (!hasPendingUpdate(projectRoot)) return { started: false, reason: "nothing_pending" };

  const runner = path.join(__dirname, "full-rebuild-runner.js");
  try {
    const child = spawn(process.execPath, [runner, "--drain-pending"], {
      cwd: projectRoot,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return { started: true, pid: child.pid };
  } catch (_) {
    return { started: false, reason: "drain_spawn_failed" };
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
  stampGraphMeta,
  startFullRebuild,
  checkAndMaybeRebuild,
  readLastRebuildTime,
  rebuildStatePath,
  pendingDir,
  writePendingUpdate,
  takePendingUpdate,
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
