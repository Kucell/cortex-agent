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

// The baseline log grows by one record per publication. It is NEVER
// compacted: a compaction rewrites the log, and a rewrite is a read
// followed by a write -- the very shape that lets two publishers roll the
// baseline back. The log therefore only grows, and only by a record per
// full rebuild (a handful per project and year).

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
 * Publish `body` at `target` EXCLUSIVELY: the target must not exist yet.
 *
 * Returns { created: true } when this call published the file,
 * { created: false, reason: "already_exists" } when somebody else got
 * there first. Throws when the publication failed for any other reason.
 *
 * The publication NEVER replaces an existing target. That is the whole
 * point of the function: the baseline sidecar has a fixed name, and a
 * publication that could replace it would let a stale value overwrite a
 * newer one -- which lowers the threshold and disables the guard.
 *
 * The earlier implementation reserved the name with an EMPTY placeholder
 * and then renamed the finished file over it. The reservation did not keep
 * the generation: a publisher that wrote a NEW baseline into the place
 * while the placeholder was in flight had its value replaced by the older
 * one when the rename finally landed. The baseline is exactly the value
 * that must never move backwards, so the reservation is gone: the
 * fallback creates the target exclusively and writes into it, and it never
 * renames over anything.
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
  // EXCLUSIVELY and write into it.
  //
  // The exclusive create is what keeps the "never replace" promise: the
  // fallback never renames over an existing target, so it can never
  // clobber a newer publication.
  //
  // The bytes are not published in one step, so a reader can observe the
  // file while it is being written. `readJsonFile` retries the parse, and
  // a baseline that cannot be parsed is treated as "no baseline", which
  // SKIPS the check instead of guessing. The pending queue does not use
  // this path at all: its file names are unique, so it publishes with an
  // atomic rename instead.
  let fallbackHandle;
  let fallbackCreated = false;
  try {
    fallbackHandle = fs.openSync(target, "wx", 0o600);
    fallbackCreated = true;
    fs.writeFileSync(fallbackHandle, body);
    fs.fsyncSync(fallbackHandle);
    fs.closeSync(fallbackHandle);
    fallbackHandle = undefined;
    return { created: true, degraded: true };
  } catch (err) {
    if (fallbackHandle !== undefined) {
      try { fs.closeSync(fallbackHandle); } catch (_) { /* already closed */ }
    }
    // A publication that failed half-way must not leave a file behind: a
    // truncated or empty file at a FIXED name is worse than no file at
    // all. It would be read as "a baseline exists" by the next migration
    // and would block every later attempt to publish a real one.
    if (fallbackCreated) {
      try { fs.unlinkSync(target); } catch (_) { /* best-effort */ }
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
 * The lock generation counter.
 *
 * The generation is the FENCE. A check of the lock file ("is this still my
 * lock?") is a check-then-act: the lock can be taken away between the
 * check and the write, and no amount of re-checking closes that window --
 * it is the same ABA shape as a judgement followed by a removal.
 *
 * So the generation is not a check but a VALUE that travels with every
 * artifact a holder publishes. It only changes when a stale lock is
 * RECLAIMED, which is the only way a live holder can ever be displaced.
 * A holder that was displaced therefore publishes artifacts that carry an
 * OLD generation, and every reader can tell that they were written by a
 * holder that no longer owns the lock.
 *
 * The counter lives next to the lock so that it is shared by every process
 * that works on the project, and it is allocated by an EXCLUSIVE CREATE so
 * that it can never go backwards: a counter that is read, incremented and
 * written back is not monotonic, and a fence that goes backwards is no
 * fence at all.
 */
function ticketDir(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-tickets");
}

/**
 * The highest number that was handed out for a counter.
 */
function highestTicket(projectRoot, prefix) {
  let names;
  try {
    names = fs.readdirSync(ticketDir(projectRoot));
  } catch (_) {
    return 0;
  }
  let max = 0;
  for (const name of names) {
    if (!name.startsWith(prefix + "-")) continue;
    const value = Number(name.slice(prefix.length + 1));
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/**
 * Hand out the next number of a counter.
 *
 * The number is allocated by the EXCLUSIVE CREATE of the file that carries
 * it. A counter that is read, incremented and written back is not
 * monotonic: two publishers that read the same value write the same value
 * back, and the counter goes backwards -- which is exactly what a fence
 * must never do. An exclusive create cannot: the loser of the race sees
 * the file and takes the next number.
 *
 * The allocation FAILS LOUDLY. A counter that could not be persisted
 * would let a displaced holder keep publishing, so the caller must abort
 * instead of continuing with a weaker fence.
 */
function allocateTicket(projectRoot, prefix) {
  const dir = ticketDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const next = highestTicket(projectRoot, prefix) + 1;
    const file = path.join(dir, prefix + "-" + next);
    try {
      const handle = fs.openSync(file, "wx", 0o600);
      fs.closeSync(handle);
      return next;
    } catch (err) {
      // Somebody else took that number: take the next one.
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("density ticket allocation exhausted");
}

/**
 * The current lock epoch. 0 when no reclaim ever happened.
 *
 * The epoch is allocated like every other counter, so it never goes
 * backwards. It changes only when a lock record is moved aside, which is
 * the only moment at which a live holder can be displaced.
 */
function currentGeneration(projectRoot) {
  return highestTicket(projectRoot, "epoch");
}

/**
 * Advance the lock epoch. Called by the reclaim, because a reclaim is
 * exactly the moment at which a live holder can be displaced.
 *
 * The allocation fails loudly: a fence that cannot be persisted must stop
 * the publication, not weaken it.
 */
function bumpGeneration(projectRoot) {
  return allocateTicket(projectRoot, "epoch");
}

/**
 * The registry of the holders that LOST the lock.
 *
 * A holder loses the lock in three ways: its record was reclaimed as
 * stale, its record was moved aside and could not be put back, or it
 * released a lock that already belonged to somebody else. In every one of
 * those cases the holder may still be alive and may still publish, so the
 * artifacts it publishes have to be distrusted.
 *
 * The registry is keyed by the LOCK TOKEN, which is unique per holder. It
 * is therefore PRECISE: the holder that lost the lock is fenced, and a
 * healthy holder that took the lock in the meantime is NOT. A global
 * counter cannot do that: advancing it on a displacement also fences the
 * innocent holder whose epoch happens to be the same one.
 */
function displacedDir(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-displaced");
}

/**
 * Record that the holder with this token lost the lock. Returns false when
 * the record could not be persisted -- the caller must then refuse the
 * action that displaces the holder, because an unfenced holder may publish
 * artifacts that the readers would trust.
 */
function registerDisplaced(projectRoot, token) {
  if (!token) return true;
  try {
    fs.mkdirSync(displacedDir(projectRoot), { recursive: true });
    const handle = fs.openSync(path.join(displacedDir(projectRoot), String(token)), "wx", 0o600);
    fs.closeSync(handle);
    return true;
  } catch (err) {
    // Already registered: the holder is fenced, which is what matters.
    if (err && err.code === "EEXIST") return true;
    return false;
  }
}

/**
 * Whether the holder with this token lost the lock.
 */
function isDisplaced(projectRoot, token) {
  if (!token) return false;
  try {
    return fs.existsSync(path.join(displacedDir(projectRoot), String(token)));
  } catch (_) {
    return false;
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

// How many times an acquisition retries after it reclaimed a stale lock.
// The retry is a LOOP and not a recursion: a fault injection that keeps the
// lock stale would otherwise recurse until the stack gives out.
const LOCK_ACQUIRE_ATTEMPTS = 3;

/**
 * Move the lock file aside to a name nobody else uses.
 *
 * The move is a RENAME, which is atomic: there is no instant at which the
 * lock file is "about to be removed", and the winner of the rename owns
 * the moved file. A judgement followed by a removal has a window in which
 * the lock file can change generation between the two steps -- the holder
 * releases, a new holder takes the lock, and the reclaiming writer then
 * removes the NEW holder's lock. Re-reading the file just before the
 * removal moves that window, it does not close it.
 *
 * Returns the path of the moved file, or null when the file was gone.
 */
function moveLockAside(file) {
  const grave = file + ".move-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  try {
    fs.renameSync(file, grave);
  } catch (_) {
    return null;
  }
  return grave;
}

/**
 * Put a moved-aside lock back.
 *
 * The restore uses `link()`, which refuses to replace an existing name, so
 * the record can only be restored onto a path that is FREE. It can never
 * clobber the lock of a holder that took the path in the meantime.
 *
 * When the path is taken, the displaced holder is FENCED OUT: its own
 * `isHeld()` check fails, so it aborts before it publishes anything.
 */
function restoreLockAside(grave, file) {
  try {
    fs.linkSync(grave, file);
    fs.unlinkSync(grave);
    return true;
  } catch (_) {
    try { fs.unlinkSync(grave); } catch (__) { /* best-effort */ }
    return false;
  }
}

/**
 * Whether the lock record describes a holder that is gone AND a lock that
 * is older than the stale window.
 *
 * A live holder is NEVER reclaimed, however old the lock is: a rebuild
 * that legitimately runs for hours must keep its lock.
 */
function lockRecordIsStale(holder, ageMs, staleMs) {
  if (holder && holder.pid) {
    return !isProcessAlive(holder.pid) && ageMs > staleMs;
  }
  return ageMs > staleMs;
}

/**
 * Try to acquire the rebuild lock. Returns a handle with a `release()` that
 * removes the lock file, or null when the lock is held by someone else.
 *
 * The lock file carries a random TOKEN. Every operation that acts on the
 * lock checks the token first, so a holder whose lock was reclaimed can
 * never delete the NEW holder's lock and never publishes as a second
 * holder.
 */
function acquireRebuildLock(projectRoot, { staleMs = 6 * 60 * 60 * 1000, onStaleJudged = null, onLockMoved = null } = {}) {
  const file = rebuildLockPath(projectRoot);
  const token = crypto.randomBytes(16).toString("hex");

  const handle = {
    path: file,
    token,
    // The generation this lock was taken under. It travels with every
    // artifact the holder publishes, so a displaced holder is recognisable
    // even after it lost the lock between a check and its write.
    generation: 0,
    /**
     * Whether THIS holder still owns the lock.
     *
     * This is the fence. A lock can be reclaimed as stale while its holder
     * is alive: the judgement and the takeover are separate steps, and a
     * new generation can appear between them. A holder that checks this
     * before it publishes anything notices that it lost the lock and
     * aborts, instead of carrying on as a second holder.
     */
    isHeld() {
      const current = readLockHolder(file);
      return Boolean(current && current.token === token);
    },
    /**
     * Release the lock.
     *
     * The release moves the lock aside first and then checks whose record
     * it moved. A record that belongs to somebody else is put back with
     * `link()`, which never replaces an existing name. So a holder whose
     * lock was reclaimed can never delete the NEW holder's lock.
     */
    release() {
      const grave = moveLockAside(file);
      if (!grave) return false;
      const moved = readLockHolder(grave);
      if (moved && moved.token === token) {
        try { fs.unlinkSync(grave); } catch (_) { /* best-effort */ }
        return true;
      }
      // The lock at the path was NOT ours: somebody else owns it now, so
      // this holder was DISPLACED and it does not know it. It fences itself
      // out by its token, so the artifacts it publishes from now on are
      // distrusted by the readers.
      //
      // The generation is NOT advanced here: it is shared by every holder,
      // and advancing it would also fence the healthy holder that took the
      // lock in the meantime.
      if (!registerDisplaced(projectRoot, token)) {
        // The holder could not be fenced by its token. The generation is
        // the fallback fence: it is coarser, but it keeps the displaced
        // holder from winning the readers' order.
        try { bumpGeneration(projectRoot); } catch (_) { /* best-effort */ }
      }
      restoreLockAside(grave, file);
      return false;
    },
  };

  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const generation = currentGeneration(projectRoot);
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({
          token,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          generation,
        }));
      } finally {
        fs.closeSync(fd);
      }
      // The generation is the one the lock was TAKEN under. A reclaim that
      // happens later advances the counter, and the holder's artifacts then
      // carry an older generation -- which is exactly what makes a
      // displaced holder recognisable.
      handle.generation = generation;
      return handle;
    } catch (err) {
      if (!err || err.code !== "EEXIST") return null;
      // A lock left behind by a crashed rebuild must not block the project
      // forever. It is reclaimed when its holder is provably gone AND the
      // lock is older than the stale window.
      const holder = readLockHolder(file);
      const recordedAt = holder && holder.acquiredAt ? Date.parse(holder.acquiredAt) : NaN;
      const age = Number.isFinite(recordedAt)
        ? Date.now() - recordedAt
        : Date.now() - safeMtime(file);
      if (!lockRecordIsStale(holder, age, staleMs)) return null;
      // A TEST SEAM: called after the judgement and BEFORE the atomic
      // takeover. It injects the interleaving that makes the race
      // observable -- a new holder takes the lock in the window between
      // the judgement and the takeover.
      if (typeof onStaleJudged === "function") {
        try { onStaleJudged(); } catch (_) { /* the seam must not break the lock */ }
      }
      const grave = moveLockAside(file);
      if (!grave) return null;
      // A TEST SEAM: called after the lock was moved aside and BEFORE the
      // moved record is examined. It injects the interleaving that used to
      // produce two live holders: a new holder takes the path that the
      // move just freed, and the reclaim then tries to put the old record
      // back on top of it.
      if (typeof onLockMoved === "function") {
        try { onLockMoved(); } catch (_) { /* the seam must not break the lock */ }
      }
      const moved = readLockHolder(grave);
      const movedAt = moved && moved.acquiredAt ? Date.parse(moved.acquiredAt) : NaN;
      const movedAge = Number.isFinite(movedAt)
        ? Date.now() - movedAt
        : Date.now() - safeMtime(grave);
      if (!lockRecordIsStale(moved, movedAge, staleMs)) {
        // It was a LIVE lock after all: put it back -- never on top of the
        // holder that took the path meanwhile -- and refuse the reclaim.
        const restored = restoreLockAside(grave, file);
        if (!restored) {
          // The record could NOT be put back, so its holder is displaced:
          // its lock is gone and it does not know it. It is fenced out by
          // its TOKEN, so only THAT holder is distrusted: the healthy
          // holder that took the path in the meantime keeps its epoch.
          if (!registerDisplaced(projectRoot, moved && moved.token)) {
            // The displaced holder could not be fenced by its token, so
            // the coarser generation fence is used instead.
            try { bumpGeneration(projectRoot); } catch (_) { /* best-effort */ }
          }
        }
        return null;
      }
      try { fs.unlinkSync(grave); } catch (_) { /* best-effort cleanup */ }
      // A reclaim can displace a live holder, so the generation advances:
      // every artifact the displaced holder publishes from now on carries
      // an older generation and is distrusted by its readers. The holder is
      // fenced by its token as well, so the fence does not depend on the
      // counter alone.
      const fenced = registerDisplaced(projectRoot, moved && moved.token);
      try {
        bumpGeneration(projectRoot);
      } catch (_) {
        // The counter could not be advanced. The token fence still holds,
        // so the reclaim may continue; without ANY fence the displaced
        // holder's artifacts would win the readers' order.
        if (!fenced) return null;
      }
      // The path is free now, so the next iteration tries the exclusive
      // create again. Exactly one caller can win it.
    }
  }
  return null;
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
 * Read every usable record of the baseline log.
 *
 * The sidecar is an APPEND-ONLY log: one JSON record per line. A line that
 * cannot be parsed is skipped -- a publisher that died in the middle of a
 * write leaves a partial line, and the records around it are still valid.
 */
function readBaselineRecords(projectRoot) {
  let text;
  try {
    text = fs.readFileSync(baselinePath(projectRoot), "utf8");
  } catch (_) {
    return [];
  }
  // The LEGACY format: one pretty-printed JSON object for the whole file.
  // It was written by the version that published the baseline by replacing
  // the file. It must still be read, or the guard would silently lose its
  // baseline and stop firing.
  const whole = text.trim();
  if (whole.startsWith("{") && whole.includes("\n")) {
    try {
      const parsed = JSON.parse(whole);
      const ratio = Number(parsed.edge_node_ratio);
      if (parsed && typeof parsed === "object" && Number.isFinite(ratio) && ratio > 0
        && !isDisplaced(projectRoot, parsed.lock_token)) {
        return [{ record: parsed, index: 0 }];
      }
    } catch (_) { /* not the legacy format: fall through to the log */ }
  }
  const records = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch (_) { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    const ratio = Number(parsed.edge_node_ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    // A record published by a holder that LOST the lock is dropped: the
    // holder may have published it after it was displaced, and the readers
    // must not trust it.
    if (isDisplaced(projectRoot, parsed.lock_token)) continue;
    records.push({ record: parsed, index });
  }
  return records;
}

/**
 * The order of two baseline records.
 *
 * The order is TOTAL and it is derived from the records themselves, so it
 * does not depend on a judgement that can be invalidated a moment later:
 *
 *   1. the PRIORITY -- a baseline that a full build measured (1) always
 *      beats one that was migrated from the graph meta data (0). The
 *      migration is a snapshot of an older graph, so it must never
 *      displace a measured baseline.
 *   2. the LOCK GENERATION -- the generation only advances when a live
 *      holder can be displaced, so a newer generation is a newer build.
 *   3. the TIMESTAMP -- within one generation the build that measured the
 *      newer graph is the newer one. It is compared as text, because the
 *      ISO-8601 format sorts chronologically.
 *   4. the PUBLICATION SEQUENCE -- the tie-breaker for two measurements
 *      that carry the same timestamp. It is allocated when a build hands
 *      its result over, so it does not depend on the wall clock and not on
 *      the position of the record in the log.
 */
function compareBaselineRecords(a, b) {
  const priorityA = Number(a.priority) || 0;
  const priorityB = Number(b.priority) || 0;
  if (priorityA !== priorityB) return priorityA < priorityB ? -1 : 1;
  const generationA = Number.isFinite(Number(a.lock_generation)) ? Number(a.lock_generation) : 0;
  const generationB = Number.isFinite(Number(b.lock_generation)) ? Number(b.lock_generation) : 0;
  if (generationA !== generationB) return generationA < generationB ? -1 : 1;
  const atA = String(a.baseline_locked_at || "");
  const atB = String(b.baseline_locked_at || "");
  if (atA !== atB) return atA < atB ? -1 : 1;
  // The PUBLICATION SEQUENCE breaks the tie between two measurements that
  // carry the SAME timestamp. It is allocated when a build hands its
  // result over, so it depends neither on the wall clock nor on the
  // position of the record in the log.
  //
  // It comes AFTER the timestamp on purpose: the sequence says which
  // publication came last, not which MEASUREMENT is newer. A publisher
  // that measured an older graph and published it late must not win -- that
  // is exactly the rollback the order exists to prevent.
  const sequenceA = Number.isFinite(Number(a.sequence)) ? Number(a.sequence) : 0;
  const sequenceB = Number.isFinite(Number(b.sequence)) ? Number(b.sequence) : 0;
  if (sequenceA !== sequenceB) return sequenceA < sequenceB ? -1 : 1;
  return 0;
}

/**
 * The record that wins the order -- the baseline that is in effect.
 */
function pickBaselineRecord(records) {
  let winner = null;
  for (const entry of records || []) {
    if (!winner) {
      winner = entry;
      continue;
    }
    const order = compareBaselineRecords(entry.record, winner.record);
    // The position in the log is NOT a tie-breaker: a publisher that was
    // interrupted appends its record later, and the log position would then
    // make the OLDER build win.
    if (order > 0) winner = entry;
  }
  return winner ? winner.record : null;
}

/**
 * Append a record to the baseline log.
 *
 * The append NEVER replaces the file, so a publisher that lost a race
 * cannot destroy the record that won it. The reader decides which record
 * is the baseline. That is what removes the "compare the timestamp, then
 * rename over the file" window -- a read followed by a write is not a
 * monotonic commit, and two real runners could roll the baseline back
 * through it.
 */
function appendBaselineRecord(projectRoot, record) {
  const file = baselinePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  // The log is a sequence of lines. A file that does not end with a
  // newline would swallow the next record into the last line.
  let prefix = "";
  try {
    const stat = fs.statSync(file);
    if (stat.size > 0) {
      const handle = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(handle, last, 0, 1, stat.size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(handle);
      }
    }
  } catch (_) { /* the log does not exist yet */ }
  const handle = fs.openSync(file, "a", 0o600);
  try {
    // ONE write call: with O_APPEND the offset update and the write are
    // atomic, so two publishers never interleave their records.
    const bytes = Buffer.from(prefix + line, "utf8");
    const written = fs.writeSync(handle, bytes);
    // A SHORT write is not a publication: the record on disk would be a
    // fragment, and the caller would report a success that never landed.
    if (written !== bytes.length) {
      throw new Error("short baseline append");
    }
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Read the durable baseline sidecar. Returns null when there is none or
 * when it is unusable.
 */
function readBaselineSidecar(projectRoot) {
  return pickBaselineRecord(readBaselineRecords(projectRoot));
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
  // The sidecar is an append-only log, and the record that wins the order
  // is the baseline in effect. A publisher whose lock was reclaimed cannot
  // publish at all -- the generation fence refuses its record -- so the
  // winner is always a record that a live holder wrote.
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
    let sequence;
    try {
      sequence = allocateTicket(projectRoot, "seq");
    } catch (err) {
      return { migrated: false, reason: err && err.code ? err.code : "sequence_alloc_failed" };
    }
    const payload = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      kind: "migration",
      // A migration is a snapshot of the graph meta data, so it never
      // displaces a baseline that a full build measured.
      priority: 0,
      build_kind: String(meta.build_kind || "full"),
      edge_node_ratio: Number(ratio.toFixed(4)),
      nodes,
      edges,
      baseline_locked_at: meta.baseline_locked_at || new Date().toISOString(),
      lock_generation: currentGeneration(projectRoot),
      sequence,
      migrated_from: "graph_meta",
    };
    // The migration APPENDS its record; it never replaces the log. A full
    // rebuild that finished in the meantime may already have published a
    // measured baseline, and the migration must not displace it: the
    // measured record carries the higher priority, so the reader keeps it.
    appendBaselineRecord(projectRoot, payload);
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
 * Writes the sidecar -- and NOTHING ELSE. The framework does not write
 * `graph.json`: a mirror of the baseline into the graph is a read-modify-
 * write of the whole file, and it can publish a stale snapshot over a
 * newer graph. The sidecar is the durable copy.
 *
 * Returns { ok, ratio, sidecarPath, metaStamped }.
 */
function stampBaseline(projectRoot, { nodes, edges, buildKind = "full", now = null, lockGeneration = null, lockToken = null, onBeforeAppend = null } = {}) {
  const nodeCount = Math.max(0, Number(nodes) || 0);
  const edgeCount = Math.max(0, Number(edges) || 0);
  if (nodeCount <= 0) {
    return { ok: false, reason: "no_nodes" };
  }
  const ratio = edgeCount / nodeCount;
  const timestamp = now || new Date().toISOString();
  // The PUBLICATION SEQUENCE is allocated here, when the build hands its
  // result over. It orders two builds that finished in the same millisecond
  // and it does not depend on where the record lands in the log.
  let sequence;
  try {
    sequence = allocateTicket(projectRoot, "seq");
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "sequence_alloc_failed", ratio };
  }
  const payload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: "stamp",
    // A baseline that a full build measured outranks a migrated one.
    priority: 1,
    build_kind: buildKind,
    edge_node_ratio: Number(ratio.toFixed(4)),
    nodes: nodeCount,
    edges: edgeCount,
    baseline_locked_at: timestamp,
    // The generation of the lock this baseline was written under. A holder
    // that was displaced by a reclaim keeps writing with an OLDER
    // generation, and every reader can tell that the value was not written
    // by the lock's owner.
    lock_generation: lockGeneration === null ? currentGeneration(projectRoot) : Number(lockGeneration),
    // The TOKEN of the lock that holds this publication. A holder that
    // lost the lock is registered by its token, and every artifact it
    // publishes is dropped by the readers. The token is precise: it fences
    // exactly the holder that lost the lock, and no other one.
    lock_token: lockToken || null,
    // The order of the builds themselves.
    sequence,
  };
  const sidecar = baselinePath(projectRoot);
  // The FENCE that does not depend on the shared counter: a holder that
  // lost the lock must not publish. Its artifacts are dropped by the
  // readers, so publishing here would only leave a record that is
  // distrusted.
  if (lockToken && isDisplaced(projectRoot, lockToken)) {
    return { ok: false, reason: "lock_displaced", ratio, sidecarPath: sidecar };
  }
  // The generation fence: a holder whose lock was reclaimed must not
  // publish a baseline. The check is a comparison of values, so the window
  // between it and the write is closed by the generation that travels with
  // the artifact: a baseline written by a displaced holder carries an old
  // generation and is distrusted by the reader.
  const current = currentGeneration(projectRoot);
  if (Number(payload.lock_generation) < current) {
    return { ok: false, reason: "lock_generation_stale", ratio, sidecarPath: sidecar };
  }
  // The baseline only ever moves FORWARD.
  //
  // A publication that replaces a NEWER baseline with an older one lowers
  // the threshold and weakens the guard -- the ratio the guard compares
  // against is the one the graph was measured against, and an older value
  // describes an older graph.
  //
  // The publication APPENDS its record instead of replacing the file, so a
  // publisher that lost the race cannot destroy the record that won it.
  // The reader picks the winner, which is what makes the order a property
  // of the records rather than of a judgement that a later publisher can
  // invalidate. This refusal is therefore only an optimisation: it keeps
  // the log free of records that lost the order anyway.
  const existing = readBaselineSidecar(projectRoot);
  if (existing && compareBaselineRecords(existing, payload) > 0) {
    return { ok: false, reason: "baseline_is_newer", ratio, sidecarPath: sidecar };
  }
  // A TEST SEAM: called after the comparison and BEFORE the append. It
  // injects the interleaving that makes the race observable: another
  // publisher writes its record while this one is suspended, and the
  // suspended publisher then writes its own record.
  if (typeof onBeforeAppend === "function") {
    try { onBeforeAppend(); } catch (_) { /* the seam must not break the stamp */ }
  }
  try {
    appendBaselineRecord(projectRoot, payload);
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "sidecar_write_failed", ratio };
  }
  // The baseline in effect is the winner of the log, which is not
  // necessarily the record that was just appended.
  const winner = readBaselineSidecar(projectRoot) || payload;
  return { ok: true, ratio, sidecarPath: sidecar, metaStamped: false, payload: winner };
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
function stampBaselineFromGraph(projectRoot, { expectedNodes = null, expectedEdges = null, buildKind = "full", now = null, lockGeneration = null, lockToken = null } = {}) {
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
    lockGeneration,
    lockToken,
  });
  if (!stamp.ok) return stamp;
  return Object.assign({}, stamp, { nodes: counts.nodes, edges: counts.edges });
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

function pendingFileName(changedPaths, attempts = 0) {
  const sorted = [...new Set(changedPaths.map((p) => String(p)))].sort();
  const digest = crypto.createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 32);
  const unique = process.pid + "-" + crypto.randomBytes(6).toString("hex");
  // The attempt counter lives in the NAME, not only in the content.
  //
  // Handing a request back to the queue is a RENAME, which is atomic, and
  // a rename cannot rewrite the content. An attempt counter that lived
  // only in the content could therefore not be incremented atomically: it
  // would need a separate rewrite, and a crash during that rewrite would
  // leave a truncated request that no recovery could parse.
  return digest + "-a" + (Number(attempts) || 0) + "-" + unique + ".json";
}

/**
 * Parse the digest and the attempt counter out of a pending file name.
 *
 * The name is `<digest>-a<attempts>-<pid>-<random>.json`. Returns null
 * when the name does not belong to a pending request.
 */
function parsePendingName(name) {
  const match = /^([0-9a-f]{32})-a(\d+)-[0-9]+-[0-9a-f]+\.json$/.exec(name);
  if (!match) return null;
  const attempts = Number(match[2]);
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  return { digest: match[1], attempts };
}

/**
 * Record that an incremental update still has to run.
 *
 * Returns { ok, path }.
 */
function writePendingUpdate(projectRoot, { changedPaths = [], semanticPaths = [], sourceHead = null, branch = null, attempts = 0 } = {}) {
  const paths = [...new Set(changedPaths.map((p) => String(p)).filter(Boolean))].sort();
  if (paths.length === 0) return { ok: false, reason: "no_paths" };
  const dir = pendingDir(projectRoot);
  const target = path.join(dir, pendingFileName(paths, attempts));
  const payload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    changedPaths: paths,
    // The semantic paths are kept apart: an incremental update only
    // refreshes the code graph, so a deferred SEMANTIC change needs the
    // stale marker, not another update.
    semanticPaths: [...new Set(semanticPaths.map((p) => String(p)).filter(Boolean))].sort(),
    sourceHead: sourceHead || null,
    branch: branch || null,
    attempts: Number(attempts) || 0,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // The target name is unique, so the atomic publish always succeeds:
    // two writers never collide, and a writer publishing a NEW request is
    // never affected by a consumer removing an OLD one. The publish is a
    // rename of a private temp file, so a consumer can only ever observe a
    // COMPLETE request -- the fallback path of `publishExclusive`, which
    // writes into the target in place, would expose a half-written one.
    writeFileAtomic(target, JSON.stringify(payload, null, 2) + "\n");
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
    const meta = parsePendingName(name);
    if (!meta) continue;
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
    // The attempt counter travels in the CLAIM name as well as in the
    // request name. The body of a claimed file still carries the counter it
    // was written with, and a hand-back renames the file without rewriting
    // it -- so the body alone is not authoritative, and a recovery that read
    // the body would RESET the retry budget of a request that had already
    // failed several times.
    const claimName = ".claimed-" + process.pid + "-" + Date.now()
      + "-" + crypto.randomBytes(6).toString("hex")
      + "-a" + meta.attempts + ".json";
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
      semanticPaths: Array.isArray(parsed.semanticPaths) ? parsed.semanticPaths : [],
      sourceHead: parsed.sourceHead || null,
      branch: parsed.branch || null,
      // The attempt counter in the NAME is authoritative: it is what the
      // hand-back rename could change atomically. The counter in the
      // content is the value the request was written with.
      attempts: meta.attempts,
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
    // EVERY branch returns the same contract: `claims` are the claim files
    // of the requests that are still alive, `exhaustedClaims` are the claim
    // files of the requests that are dropped. The earlier branch returned
    // the exhausted claims under `claims` and no `exhaustedClaims` at all,
    // so the caller -- which deletes `exhaustedClaims` -- never removed
    // them, and the queue accumulated claim files that nothing could ever
    // clear.
    if (exhausted.length === 0) return null;
    return {
      changedPaths: [],
      attempts: 0,
      exhausted,
      claims: [],
      exhaustedClaims: claims.slice(),
    };
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
      semanticPaths: [...new Set(g.entries.flatMap((c) => c.semanticPaths || []))].sort(),
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
 * The hand-back is a RENAME into a fresh request name: it is atomic, so
 * exactly one consumer can move a given claim, and there is no window in
 * which the request is neither claimed nor visible. The earlier
 * implementation published a NEW request and then removed the claim, and
 * two consumers could both publish in between -- the request was then
 * replayed twice, and the queue ended up with duplicates.
 *
 * The attempt counter is carried over, so a request that keeps failing
 * eventually reaches the bound and is dropped instead of being retried
 * for ever.
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
    // The base counter comes from the CLAIM NAME: the body still carries the
    // counter the request was created with, because a hand-back renames the
    // file without rewriting it. A claim that carries NO suffix is a claim
    // of the older format: its counter lives in the body.
    const meta = parseClaimName(path.basename(claim));
    const current = meta && meta.attempts !== null
      ? meta.attempts
      : (Number(parsed.attempts) || 0);
    const next = Math.max(current, Number(attempts) || 0);
    const target = path.join(dir, pendingFileName(paths, next));
    try {
      fs.renameSync(claim, target);
    } catch (_) {
      // The claim is gone -- another consumer recovered it. Nothing to do.
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
    //
    // The recovery is a RENAME: it is atomic, so exactly one consumer can
    // recover a given claim. The earlier implementation published a new
    // request and then removed the claim, and two consumers could both
    // publish -- the request was then replayed twice, from two different
    // claims.
    //
    // The attempt counter is carried over, so the retry history of the
    // request survives the recovery.
    // The attempt counter comes from the CLAIM NAME, not from the body: the
    // body was not rewritten when the request was handed back, so it still
    // carries the counter the request was created with. Reading the body
    // would reset the retry budget of a request that had already failed
    // several times. A claim of the OLDER format carries no suffix: its
    // counter lives in the body, and there it is authoritative.
    const recovered = meta.attempts !== null ? meta.attempts : (Number(claim.attempts) || 0);
    const target = path.join(dir, pendingFileName(paths, recovered));
    try {
      fs.renameSync(file, target);
    } catch (_) {
      // Somebody else recovered it first.
    }
  }
}

/**
 * Parse the owner and the claim time out of a claim file name.
 *
 * The name is `.claimed-<pid>-<epochMillis>-<random>.json`, with an
 * optional `-a<attempts>` suffix that carries the retry budget of the
 * request. A claim written by an older version carries no suffix; its
 * budget is then read from the body.
 */
function parseClaimName(name) {
  // The attempt suffix is optional: a claim that was written by an older
  // version carries no counter, and it must still be recoverable instead of
  // lingering in the queue for ever. A missing suffix is NOT a zero: the
  // counter of such a claim lives in its body, and it must be read from
  // there. An explicit `-a0` IS a zero.
  const match = /^\.claimed-(\d+)-(\d+)-[0-9a-f]+(?:-a(\d+))?\.json$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  const claimedAt = Number(match[2]);
  const attempts = match[3] === undefined ? null : Number(match[3]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(claimedAt)) return null;
  if (attempts !== null && (!Number.isFinite(attempts) || attempts < 0)) return null;
  return { pid, claimedAt, attempts };
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

  // The drain takes the REBUILD lock itself, so two drains can never write
  // the graph at the same time: the second one waits for the first to
  // finish, and by then the queue is empty and it has nothing to do.
  //
  // There used to be a second, dedicated "scheduler" lock that made the
  // drain a singleton. It guarded nothing that the rebuild lock does not
  // already guard, and its handover to the drain process carried the same
  // race as the rebuild lock's handover: the starter rewrote the lock file
  // after the child had already released it, so the lock was RECREATED and
  // every later drain was refused for the whole stale window.

  const runner = path.join(__dirname, "full-rebuild-runner.js");
  try {
    const child = spawn(process.execPath, [runner, "--drain-pending"], {
      cwd: projectRoot,
      stdio: "ignore",
      detached: true,
      env: Object.assign({}, process.env, {
        // The generation of this drain in the follow-up chain, so the chain
        // has a bound.
        GRAPHIFY_DRAIN_GENERATION: String(generation),
      }),
    });
    child.unref();
    // An asynchronous spawn failure is reported through the `error` event,
    // NOT through a throw. Without a listener the unhandled `error` event
    // takes the whole process down. The request stays queued, so the next
    // consumer picks it up.
    child.on("error", () => { /* the request stays queued for the next consumer */ });
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
