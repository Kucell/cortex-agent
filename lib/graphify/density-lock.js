"use strict";

/**

 * The rebuild lock and its fences (issue #154).

 *

 * The lock serialises the FULL rebuild against itself and against the

 * incremental update. Beside the lock live the fences that keep a

 * displaced holder from publishing: the ticket counters (the epoch and the

 * publication sequence) and the registry of the holders that lost the

 * lock.

 */



const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");



const { pluginDir } = require("./density-files");



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
 * The registry of the sequences that a holder actually PUBLISHED.
 *
 * A publication sequence is allocated when a build hands its result over,
 * but the ALLOCATION and the PUBLICATION are two different moments: a
 * holder can be allocated a sequence and be displaced before its record
 * ever reaches the log. A displacement threshold that is built from the
 * allocated numbers therefore treats an unpublished record as if it had
 * been published before the loss, and the reader would trust it.
 *
 * This registry records the sequences that were really appended, so the
 * threshold of a displaced holder is the highest sequence it PUBLISHED --
 * and a record it appends after the loss is dropped, because that sequence
 * is not in the registry.
 */
function publishedDir(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-published");
}

/**
 * Register that the holder with this token published a record with this
 * sequence. Returns false when the registration could not be persisted --
 * the caller may then publish, but the record is distrusted by a reader
 * that fences this holder, which is the conservative outcome.
 */
function registerPublishedSequence(projectRoot, token, sequence) {
  if (!token) return false;
  const value = Number(sequence);
  if (!Number.isFinite(value)) return false;
  try {
    fs.mkdirSync(publishedDir(projectRoot), { recursive: true });
    const handle = fs.openSync(path.join(publishedDir(projectRoot), String(token)), "a", 0o600);
    try {
      fs.writeSync(handle, value + "\n");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * The highest sequence the holder with this token really published.
 */
function highestPublishedSequence(projectRoot, token) {
  if (!token) return 0;
  let raw;
  try {
    raw = fs.readFileSync(path.join(publishedDir(projectRoot), String(token)), "utf8");
  } catch (_) {
    return 0;
  }
  let max = 0;
  for (const line of String(raw).split("\n")) {
    const value = Number(line.trim());
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
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
    const file = path.join(displacedDir(projectRoot), String(token));
    // The THRESHOLD is the highest publication sequence that the holder
    // REALLY published when it lost the lock. Everything it published
    // BEFORE that moment was published while it still had the authority,
    // so it stays valid; everything it publishes afterwards is dropped.
    //
    // Without the threshold the registration would invalidate the WHOLE
    // history of that holder -- including a baseline it published
    // successfully, which is the very record the guard needs.
    //
    // The threshold is NOT the highest sequence that was HANDED OUT: a
    // sequence is allocated before the record is appended, so a holder
    // that was allocated one and then displaced would have its
    // unpublished record counted as a publication, and the reader would
    // trust a measurement that was made without the authority.
    const threshold = String(highestPublishedSequence(projectRoot, token));
    let handle;
    try {
      handle = fs.openSync(file, "wx", 0o600);
    } catch (err) {
      // Already registered: the holder is fenced, which is what matters.
      if (err && err.code === "EEXIST") return true;
      throw err;
    }
    try {
      fs.writeFileSync(handle, threshold + "\n");
    } finally {
      fs.closeSync(handle);
    }
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * The publication sequence at which the holder with this token lost the
 * lock. Null when the holder never lost it.
 */
function displacedThreshold(projectRoot, token) {
  if (!token) return false;
  let raw;
  try {
    raw = fs.readFileSync(path.join(displacedDir(projectRoot), String(token)), "utf8");
  } catch (_) {
    return null;
  }
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * Whether the holder with this token lost the lock.
 */
function isDisplaced(projectRoot, token) {
  return displacedThreshold(projectRoot, token) !== null;
}

/**
 * Whether a published record must be dropped because the holder that
 * published it had already lost the lock.
 *
 * A record that was published BEFORE the holder lost the lock stays valid:
 * it was published while the holder still had the authority, and it may be
 * the only baseline the project has. A record that was published AFTER the
 * loss is dropped.
 */
function isDisplacedRecord(projectRoot, record) {
  const token = record && record.lock_token;
  if (!token) return false;
  const threshold = displacedThreshold(projectRoot, token);
  if (threshold === null) return false;
  const sequence = Number(record.sequence);
  // A record without a publication sequence cannot be placed after the
  // loss, so it is not trusted.
  if (!Number.isFinite(sequence)) return true;
  return sequence > threshold;
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
      // The release only ever touches ITS OWN lock. A holder that lost the
      // lock must not move the NEW holder's record away: that is what
      // breaks the mutual exclusion for the new holder, and it is how a
      // displaced holder used to displace the healthy one that took the
      // path in the meantime.
      const current = readLockHolder(file);
      if (!current || current.token !== token) {
        // This holder is not the holder any more. It fences itself out, so
        // the artifacts it publishes from now on are distrusted.
        //
        // The generation is NOT advanced here: it is shared by every
        // holder, and advancing it would also fence the healthy holder
        // that took the path in the meantime.
        if (!registerDisplaced(projectRoot, token)) {
          // The holder could not be fenced by its token. The generation is
          // the fallback fence: it is coarser, but it keeps the displaced
          // holder from winning the readers' order.
          try { bumpGeneration(projectRoot); } catch (_) { /* best-effort */ }
        }
        return false;
      }
      const grave = moveLockAside(file);
      if (!grave) return false;
      const moved = readLockHolder(grave);
      if (moved && moved.token === token) {
        try { fs.unlinkSync(grave); } catch (_) { /* best-effort */ }
        return true;
      }
      // The record that was moved away is NOT ours: somebody replaced the
      // lock in the window between the check and the move. It is put back,
      // and the holder it belongs to is fenced when it cannot be put back.
      const restored = restoreLockAside(grave, file);
      if (!restored && moved && moved.token) {
        if (!registerDisplaced(projectRoot, moved.token)) {
          try { bumpGeneration(projectRoot); } catch (_) { /* best-effort */ }
        }
      }
      // And this holder was displaced in the meantime.
      if (!registerDisplaced(projectRoot, token)) {
        try { bumpGeneration(projectRoot); } catch (_) { /* best-effort */ }
      }
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
      // The record that was JUDGED and the record that was MOVED must be
      // the SAME one. The window between the judgement and the move is
      // real: a new holder can take the path in it. Moving that new
      // holder's lock aside would break the mutual exclusion -- two
      // holders would write the graph, and the loser of the race would
      // publish its stale measurement as the newest one.
      //
      // The TOKEN identifies the record exactly, so the comparison is a
      // value comparison and not a judgement that can go stale.
      if (!moved || !holder || moved.token !== holder.token) {
        // The path was taken by somebody else in the window. The record
        // that was moved belongs to that holder: it is put back, and the
        // reclaim is refused.
        const restored = restoreLockAside(grave, file);
        if (!restored && moved && moved.token) {
          // The record could NOT be put back, so its holder is displaced:
          // its lock is gone and it does not know it. It is fenced out by
          // its TOKEN, so only THAT holder is distrusted: the healthy
          // holder that took the path in the meantime keeps its epoch.
          if (!registerDisplaced(projectRoot, moved.token)) {
            // The displaced holder could not be fenced by its token, so
            // the coarser generation fence is used instead.
            try { bumpGeneration(projectRoot); } catch (_) { /* best-effort */ }
          }
        }
        return null;
      }
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
      // The holder of the reclaimed record is GONE -- that is why the record
      // was judged stale -- so it cannot publish anything any more and it
      // does not have to be fenced.
      //
      // The generation is deliberately NOT advanced here. The generation is
      // shared by every holder: advancing it would also invalidate the
      // healthy holder that took the path in the window between the
      // judgement and the move, and that holder never lost anything. The
      // fence that is precise -- the TOKEN -- is registered below.
      const fenced = registerDisplaced(projectRoot, moved && moved.token);
      if (!fenced) {
        // The token fence could not be persisted, so the coarse generation
        // fence is the only one left. It cannot be advanced without
        // harming the healthy holder, so the reclaim is refused instead:
        // the stale lock stays until the window expires on its own.
        return null;
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



module.exports = {

  acquireRebuildLock,

  rebuildLockPath,

  ticketDir,

  highestTicket,

  allocateTicket,

  currentGeneration,

  bumpGeneration,

  displacedDir,

  publishedDir,

  registerPublishedSequence,

  highestPublishedSequence,

  registerDisplaced,

  displacedThreshold,

  isDisplaced,

  isDisplacedRecord,

  safeMtime,

  LOCK_ACQUIRE_ATTEMPTS,

  moveLockAside,

  restoreLockAside,

  lockRecordIsStale,

  readLockHolder,

  isProcessAlive,

};
