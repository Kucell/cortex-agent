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

// A claimed pending file that is older than this, and whose owner is gone,
// was left behind by a consumer that died between claiming the request and
// processing it. The request is put back instead of being lost.
const PENDING_CLAIM_STALE_MS = 6 * 60 * 60 * 1000;


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
function publishExclusive(target, body, { allowReplace = false } = {}) {
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

  // Fallback for filesystems without hard links: publish with a RENAME.
  //
  // The earlier fallback created the target exclusively and wrote into it,
  // which made the request losable: a consumer could claim the file while
  // it was still being written, read a truncated body, and delete it -- and
  // the writer went on writing into a file that was no longer linked to any
  // name. The request was then gone for good while the writer reported
  // success.
  //
  // Writing the body in ONE call does not close the window either: a large
  // body is written in several syscalls, and a consumer can claim the file
  // in the middle of them.
  //
  // A rename publishes the completed bytes in one step, so a consumer can
  // only ever observe a complete file. The body is written to a private
  // temp file first, and only the finished file is renamed into place.
  //
  // The rename REPLACES an existing target, which would clobber a
  // concurrent publication. So the name is reserved first with an exclusive
  // create of an EMPTY placeholder: if the reservation fails, somebody else
  // published first and this writer gives up. The placeholder is then
  // replaced by the finished file.
  const fallbackTemp = path.join(dir, `.${path.basename(target)}.tmp-fb-${unique}`);
  let fallbackHandle;
  try {
    fallbackHandle = fs.openSync(fallbackTemp, "wx", 0o600);
    fs.writeFileSync(fallbackHandle, body);
    fs.fsyncSync(fallbackHandle);
    fs.closeSync(fallbackHandle);
    fallbackHandle = undefined;
  } catch (err) {
    if (fallbackHandle !== undefined) {
      try { fs.closeSync(fallbackHandle); } catch (_) { /* already closed */ }
    }
    try { fs.unlinkSync(fallbackTemp); } catch (_) { /* nothing to clean up */ }
    throw err;
  }

  if (allowReplace) {
    // Replacing is the intended semantics here (a newer baseline supersedes
    // an older one), so the rename goes ahead.
    try {
      fs.renameSync(fallbackTemp, target);
      return { created: true, degraded: true };
    } catch (err) {
      try { fs.unlinkSync(fallbackTemp); } catch (_) { /* best-effort */ }
      throw err;
    }
  }

  // Reserve the name exclusively.
  let placeholder;
  try {
    placeholder = fs.openSync(target, "wx", 0o600);
    fs.closeSync(placeholder);
    placeholder = undefined;
  } catch (err) {
    try { fs.unlinkSync(fallbackTemp); } catch (_) { /* best-effort */ }
    if (err && err.code === "EEXIST") {
      return { created: false, reason: "already_exists", degraded: true };
    }
    throw err;
  }
  // The placeholder is reserved and empty; the finished file replaces it.
  try {
    fs.renameSync(fallbackTemp, target);
    return { created: true, degraded: true };
  } catch (err) {
    // The rename failed, so the placeholder stays: it is an empty file that
    // a consumer will read as a corrupt request and drop. The request is
    // therefore lost, but the writer reports the failure instead of
    // claiming success.
    try { fs.unlinkSync(fallbackTemp); } catch (_) { /* best-effort */ }
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
 * The path of the drain scheduler lock.
 *
 * It is separate from the rebuild lock because it guards a different thing:
 * the rebuild lock serialises graph WRITERS, while the scheduler lock
 * serialises the DRAINS themselves. A drain holds the rebuild lock while it
 * replays, so the two locks have different lifetimes and cannot be the
 * same file.
 */
function drainSchedulerLockPath(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-drain.lock");
}

/**
 * Acquire the drain scheduler lock -- the singleton that keeps two drains
 * from running at the same time.
 *
 * The lock records the pid of the process that HOLDS it, so a drain that
 * was killed can be replaced: the holder is gone, and the lock is older
 * than the stale window, so it is reclaimed.
 */
function acquireDrainSchedulerLock(projectRoot, { staleMs = 6 * 60 * 60 * 1000 } = {}) {
  const file = drainSchedulerLockPath(projectRoot);
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
        try {
          const current = JSON.parse(fs.readFileSync(file, "utf8"));
          if (current && current.token && current.token !== token) return false;
        } catch (err) {
          if (err && err.code === "ENOENT") return false;
        }
        try { fs.unlinkSync(file); return true; } catch (_) { return false; }
      },
    };
  } catch (err) {
    if (!err || err.code !== "EEXIST") return null;
    // A drain that was killed leaves the scheduler lock behind. It is
    // reclaimed only when its holder is provably gone AND it is older than
    // the stale window: a live drain must never be displaced.
    //
    // The reclaim is an ATOMIC MOVE, for the same reason the rebuild lock's
    // reclaim is: a judgement followed by a removal has a window in which
    // the lock file can change generation, and the reclaiming writer would
    // then remove the NEW holder's lock. A rename has no such window.
    try {
      const holder = readLockHolder(file);
      const acquiredAt = holder && holder.acquiredAt ? Date.parse(holder.acquiredAt) : NaN;
      const age = Number.isFinite(acquiredAt)
        ? Date.now() - acquiredAt
        : Date.now() - safeMtime(file);
      const holderAlive = holder && holder.pid ? isProcessAlive(holder.pid) : false;
      const reclaimable = holder && holder.pid
        ? (!holderAlive && age > staleMs)
        : age > staleMs;
      if (!reclaimable) return null;
      const grave = file + ".reclaim-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
      try {
        fs.renameSync(file, grave);
      } catch (_) {
        // Somebody else reclaimed it first.
        return null;
      }
      const moved = readLockHolder(grave);
      const movedAlive = moved && moved.pid ? isProcessAlive(moved.pid) : false;
      const movedAt = moved && moved.acquiredAt ? Date.parse(moved.acquiredAt) : NaN;
      const movedAge = Number.isFinite(movedAt)
        ? Date.now() - movedAt
        : Date.now() - safeMtime(grave);
      const movedReclaimable = moved && moved.pid
        ? (!movedAlive && movedAge > staleMs)
        : movedAge > staleMs;
      if (!movedReclaimable) {
        // It was a live lock after all: put it back and refuse.
        try {
          fs.renameSync(grave, file);
        } catch (_) {
          try { fs.unlinkSync(grave); } catch (__) { /* best-effort */ }
        }
        return null;
      }
      try { fs.unlinkSync(grave); } catch (_) { /* best-effort cleanup */ }
      return acquireDrainSchedulerLock(projectRoot, { staleMs });
    } catch (_) { /* the lock disappeared; fall through */ }
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
        // A TEST SEAM: called after the judgement and BEFORE the atomic
        // takeover. It injects the interleaving that makes the race
        // observable -- a new holder takes the lock in the window between
        // the judgement and the takeover. The window is far too narrow to
        // hit reliably by racing two processes.
        if (typeof onStaleJudged === "function") {
          try { onStaleJudged(); } catch (_) { /* the seam must not break the lock */ }
        }
        // The reclaim is an ATOMIC MOVE, not a check-then-act.
        //
        // Every earlier attempt at this was a judgement followed by a
        // removal, and every one of them had a window in which the lock
        // file could change generation between the two steps: the holder
        // could release, a new holder could take the lock, and the
        // reclaiming writer would then remove the NEW holder's lock. No
        // amount of re-checking closes that window, because the check and
        // the removal are separate operations and a new generation can
        // appear between them -- the classic ABA problem. Re-reading the
        // file just before the removal moves the window, it does not close
        // it.
        //
        // A RENAME to a name nobody else uses has no such window. The
        // rename either happens or it does not; there is no instant at
        // which the file is "about to be removed". The winner of the
        // rename OWNS the moved file, so the removal that follows can only
        // ever hit the file the winner moved -- never somebody else's
        // lock.
        //
        // The moved file is then examined. If it turns out to be a LIVE
        // lock after all -- the judgement was wrong, or the file was
        // replaced before the rename -- it is put BACK and the reclaim is
        // refused. The put-back is best-effort: losing a lock record is
        // recoverable (the next reclaim picks it up), while deleting a live
        // holder's lock is not.
        const grave = file + ".reclaim-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
        try {
          fs.renameSync(file, grave);
        } catch (_) {
          // Somebody else reclaimed it first, or the file is gone.
          return null;
        }
        const moved = readLockHolder(grave);
        const movedAlive = moved && moved.pid ? isProcessAlive(moved.pid) : false;
        const movedAt = moved && moved.acquiredAt ? Date.parse(moved.acquiredAt) : NaN;
        const movedAge = Number.isFinite(movedAt)
          ? Date.now() - movedAt
          : Date.now() - safeMtime(grave);
        const movedReclaimable = moved && moved.pid
          ? (!movedAlive && movedAge > staleMs)
          : movedAge > staleMs;
        if (!movedReclaimable) {
          // It was a live lock after all. Put it back and refuse.
          try {
            fs.renameSync(grave, file);
          } catch (_) {
            try { fs.unlinkSync(grave); } catch (__) { /* best-effort */ }
          }
          return null;
        }
        try { fs.unlinkSync(grave); } catch (_) { /* best-effort cleanup */ }
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
 * Whether the pending queue holds anything at all -- a visible request, or
 * an abandoned claim that can still be recovered.
 *
 * The abandoned claim is invisible to the queue (the claim is what makes
 * it invisible), but it still describes a commit that has to reach the
 * graph. A scheduler that only looks at the visible requests would decide
 * there is nothing to do and never recover it.
 */
function hasRecoverablePending(projectRoot) {
  if (hasPendingUpdate(projectRoot)) return true;
  try {
    const dir = pendingDir(projectRoot);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((name) => {
      if (!name.startsWith(".claimed-") || !name.endsWith(".json")) return false;
      const meta = parseClaimName(name);
      if (!meta) return false;
      // Only an abandoned claim -- one whose owner is gone and that is old
      // enough -- is worth recovering.
      return !isProcessAlive(meta.pid) && (Date.now() - meta.claimedAt) > PENDING_CLAIM_STALE_MS;
    });
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
  // Recover the requests that a consumer CLAIMED but never finished.
  recoverAbandonedClaims(projectRoot, dir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const claimed = [];
  const claims = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    // CLAIM the file by renaming it to a name only this consumer knows.
    // The rename is atomic, so exactly one consumer can move a given file
    // and only the consumer whose rename succeeded owns the request. A
    // writer that publishes a new request creates a DIFFERENT file and is
    // unaffected.
    //
    // The claim name encodes the OWNING PID and the claim time, so no
    // metadata has to be written INTO the claimed file. Writing the record
    // into the file would mean an in-place rewrite: a crash during that
    // rewrite would leave a truncated file that no recovery could parse,
    // and the request would be lost for good.
    const claimName = ".claimed-" + process.pid + "-" + Date.now()
      + "-" + crypto.randomBytes(6).toString("hex") + ".json";
    const claimedPath = path.join(dir, claimName);
    try {
      fs.renameSync(file, claimedPath);
    } catch (_) {
      continue;
    }
    const parsed = readJsonFile(claimedPath);
    if (!parsed || typeof parsed !== "object") {
      // A corrupt request is dropped; it must not block the queue forever.
      try { fs.unlinkSync(claimedPath); } catch (_) { /* best-effort */ }
      continue;
    }
    claims.push(claimedPath);
    claimed.push({
      changedPaths: Array.isArray(parsed.changedPaths) ? parsed.changedPaths : [],
      sourceHead: parsed.sourceHead || null,
      branch: parsed.branch || null,
      attempts: Number(parsed.attempts) || 0,
    });
  }
  if (claimed.length === 0) return null;
  // The EXHAUSTED requests are separated out before the merge. Merging them
  // into the batch would hand their failure history to a FRESH request that
  // happens to be in the same batch: the fresh request would inherit the
  // exhausted counter and be dropped without ever being attempted. So the
  // exhausted ones are reported on their own, and the caller drops them
  // without replaying them, while the rest are replayed as usual.
  const live = claimed.filter((c) => (c.attempts || 0) < PENDING_MAX_ATTEMPTS);
  const exhausted = claimed.filter((c) => (c.attempts || 0) >= PENDING_MAX_ATTEMPTS);
  if (live.length === 0) {
    return exhausted.length > 0
      ? { changedPaths: [], attempts: 0, exhausted, claims }
      : null;
  }
  // The requests are NOT all merged into one replay. Merging them hands the
  // highest attempt counter to every request in the batch, so a fresh
  // request that merely happened to be queued alongside a request that has
  // failed four times inherits that budget and is dropped after a single
  // further failure -- without ever having been retried properly.
  //
  // The requests are therefore replayed in groups of equal attempt count,
  // oldest first. Every request is attempted as many times as it has
  // failed, and no request inherits another one's history.
  const groups = [];
  for (const entry of live) {
    const index = claimed.indexOf(entry);
    const attempts = entry.attempts || 0;
    let group = groups.find((g) => g.attempts === attempts);
    if (!group) {
      group = { attempts, entries: [], claims: [] };
      groups.push(group);
    }
    group.entries.push(entry);
    if (index >= 0 && claims[index]) group.claims.push(claims[index]);
  }
  groups.sort((a, b) => a.attempts - b.attempts);
  const liveClaims = [];
  for (const entry of live) {
    const index = claimed.indexOf(entry);
    if (index >= 0 && claims[index]) liveClaims.push(claims[index]);
  }
  return {
    changedPaths: [...new Set(live.flatMap((c) => c.changedPaths))].sort(),
    sourceHead: (live.find((c) => c.sourceHead) || {}).sourceHead || null,
    branch: (live.find((c) => c.branch) || {}).branch || null,
    attempts: live.reduce((max, c) => Math.max(max, c.attempts || 0), 0),
    exhausted,
    // The replay groups, each with its own attempt counter and its own
    // claims.
    groups: groups.map((g) => ({
      attempts: g.attempts,
      changedPaths: [...new Set(g.entries.flatMap((c) => c.changedPaths))].sort(),
      sourceHead: (g.entries.find((c) => c.sourceHead) || {}).sourceHead || null,
      branch: (g.entries.find((c) => c.branch) || {}).branch || null,
      claims: g.claims,
    })),
    // The claim files are NOT removed here. They are removed only when the
    // caller confirms that the replay actually SUCCEEDED, so a consumer
    // that dies before the replay leaves the request on disk and it can be
    // recovered.
    claims: liveClaims,
    exhaustedClaims: claims.filter((c) => !liveClaims.includes(c)),
  };
}

/**
 * Confirm that a claimed request was replayed successfully: the claim files
 * are removed, and the request is gone for good.
 *
 * The removal is a plain unlink of files the caller OWNS -- the claim names
 * are unique per claim -- so there is nothing to check against.
 */
function completePendingUpdate(claims) {
  for (const claim of claims || []) {
    try { fs.unlinkSync(claim); } catch (_) { /* best-effort */ }
  }
}

/**
 * Give a claimed request back to the queue because the replay did NOT
 * succeed.
 *
 * The claim is renamed back into a fresh request name, so the request
 * becomes visible again and the next consumer can pick it up. The attempt
 * counter is carried over, so a request that keeps failing eventually
 * reaches the bound and is dropped instead of being retried for ever.
 */
function releasePendingUpdate(projectRoot, claims, { attempts = 0 } = {}) {
  const dir = pendingDir(projectRoot);
  for (const claim of claims || []) {
    const parsed = readJsonFile(claim);
    if (!parsed || typeof parsed !== "object") {
      try { fs.unlinkSync(claim); } catch (_) { /* best-effort */ }
      continue;
    }
    const paths = Array.isArray(parsed.changedPaths) ? parsed.changedPaths : [];
    if (paths.length === 0) {
      try { fs.unlinkSync(claim); } catch (_) { /* best-effort */ }
      continue;
    }
    const written = writePendingUpdate(projectRoot, {
      changedPaths: paths,
      sourceHead: parsed.sourceHead || null,
      branch: parsed.branch || null,
      attempts: Math.max(Number(parsed.attempts) || 0, Number(attempts) || 0),
    });
    if (written.ok) {
      try { fs.unlinkSync(claim); } catch (_) { /* best-effort */ }
    }
  }
}

/**
 * Put abandoned claims back into the queue.
 *
 * A claim records the pid that took it and when. A claim whose owner is
 * gone AND that is older than the stale window belonged to a consumer that
 * died mid-flight, so its request is returned to the queue.
 */
function recoverAbandonedClaims(projectRoot, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(".claimed-") || !name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    // The claim's owner and its claim time are encoded in the FILE NAME,
    // not in the file's content. Writing them into the content would mean
    // an in-place rewrite of the claimed file, and a crash during that
    // rewrite would leave a truncated file that no recovery could parse --
    // the request would be lost for good.
    const meta = parseClaimName(name);
    if (!meta) continue;
    const ownerAlive = isProcessAlive(meta.pid);
    if (ownerAlive) continue;
    const age = Date.now() - meta.claimedAt;
    if (age <= PENDING_CLAIM_STALE_MS) continue;
    const claim = readJsonFile(file);
    if (!claim || typeof claim !== "object") {
      // A claim that cannot be parsed carries no request, so there is
      // nothing to recover.
      try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
      continue;
    }
    const paths = Array.isArray(claim.changedPaths) ? claim.changedPaths : [];
    if (paths.length === 0) {
      try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
      continue;
    }
    // The request is returned under a fresh name, so the abandoned claim is
    // not simply renamed back into a name another writer may reuse.
    const restored = writePendingUpdate(projectRoot, {
      changedPaths: paths,
      sourceHead: claim.sourceHead || null,
      branch: claim.branch || null,
      attempts: Number(claim.attempts) || 0,
    });
    if (restored.ok) {
      try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
    }
  }
}

/**
 * Parse the owner and the claim time out of a claim file name.
 *
 * The name is `.claimed-<pid>-<epochMillis>-<random>.json`.
 */
function parseClaimName(name) {
  const match = /^\.claimed-(\d+)-(\d+)-[0-9a-f]+\.json$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  const claimedAt = Number(match[2]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(claimedAt)) return null;
  return { pid, claimedAt };
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
function startPendingDrain({ projectRoot, generation = 1 }) {
  if (!hasRecoverablePending(projectRoot)) return { started: false, reason: "nothing_pending" };

  // Only ONE drain may run at a time.
  //
  // The drain is started from several places: the post-commit hook after
  // it released the lock, the managed `graphify update`, and the runner's
  // own follow-up. Without a scheduler lock, two drains can run at once,
  // and a chain of follow-up drains -- each one started because the queue
  // was not empty when the previous one finished -- has no upper bound: the
  // queue is never empty while the lock stays busy, so every drain that
  // times out on the lock starts another one, for ever.
  //
  // The scheduler lock makes the drain a SINGLETON: a second starter finds
  // it held and does not spawn anything. The lock is released when the
  // drain process ends, so the next starter can run.
  const scheduler = acquireDrainSchedulerLock(projectRoot);
  if (!scheduler) return { started: false, reason: "drain_already_running" };

  const runner = path.join(__dirname, "full-rebuild-runner.js");
  try {
    const child = spawn(process.execPath, [runner, "--drain-pending"], {
      cwd: projectRoot,
      stdio: "ignore",
      detached: true,
      // The inherited lock belongs to the process that spawned this drain.
      // The drain takes its OWN lock, so the inherited variables are removed
      // explicitly: a child that saw them would believe it already holds
      // the lock and would run the incremental update without holding it.
      env: Object.assign({}, process.env, {
        GRAPHIFY_REBUILD_LOCK_PATH: "",
        GRAPHIFY_REBUILD_LOCK_TOKEN: "",
        GRAPHIFY_DRAIN_LOCK_PATH: scheduler.path,
        GRAPHIFY_DRAIN_LOCK_TOKEN: scheduler.token,
        // The generation of this drain in the follow-up chain, so the chain
        // has a bound.
        GRAPHIFY_DRAIN_GENERATION: String(generation),
      }),
    });
    child.unref();
    // An asynchronous spawn failure is reported through the `error` event,
    // NOT through a throw. Without a listener the unhandled `error` event
    // takes the whole process down -- and the scheduler lock would be left
    // behind, so no later drain could ever start.
    child.on("error", () => {
      scheduler.release();
    });
    // The lock is handed over to the drain process: the starter exits
    // immediately, and the drain must hold the scheduler lock for its whole
    // life so that no second drain starts while it is running.
    scheduler.transferTo(child.pid);
    return { started: true, pid: child.pid };
  } catch (_) {
    scheduler.release();
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
