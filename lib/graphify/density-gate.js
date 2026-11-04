"use strict";

/**

 * The publication gate (issue #154).
 *
 * The rebuild lock alone does NOT serialise the publication of the graph.
 * The lock is a file at a fixed path, and a file at a fixed path can be
 * taken away by a reclaim that judged it stale -- so the reclaim and the
 * publication of the holder that was reclaimed can interleave: the holder
 * checks that it still owns the lock, the reclaim takes the lock away, and
 * the holder publishes its graph over the graph of the holder that replaced
 * it. No amount of re-checking closes that window, because the check and
 * the write are two separate steps.
 *
 * The gate removes the window. It is a MUTUAL EXCLUSION that every
 * participant of the protocol has to take:
 *
 *   - the reclaim of a stale lock,
 *   - the publication of the graph,
 *   - the publication of a baseline record.
 *
 * Inside the gate there is exactly one participant, so the check and the
 * write are one step again. Outside the gate nothing is published at all.
 *
 * -- Why the gate is not a file at a fixed path ----------------------
 *
 * A fixed path is the very thing that made the lock unsafe: the reclaim
 * removes the path, and a removal is a check-then-act on a name that other
 * participants reuse. The gate uses a file per PARTICIPANT instead, and the
 * name of that file contains a ticket that is never reused. The gate is
 * held by the participant with the LOWEST live ticket, and a participant
 * that is gone is removed by unlinking ITS OWN file -- a path no other
 * participant can ever take, because the ticket is allocated by an
 * exclusive create and the name carries the pid and a random suffix as
 * well.
 *
 * The removal of a participant is therefore exact: it can never take a
 * live participant's gate away, no matter how the two interleave. That is
 * the property the lock at a fixed path never had.
 *
 */


const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");


const {

  pluginDir,

  isProcessAlive,

} = require("./density-files");


// The name of the gate that serialises the rebuild protocol.
const REBUILD_GATE = "rebuild";

// The gates this PROCESS holds. The map makes the gate RE-ENTRANT: the
// holder of the rebuild lock publishes the graph and stamps the baseline
// while it still holds the lock, and a second acquisition of the same gate
// inside that window must not wait for itself.
const heldGates = new Map();

// How long the gate is polled before the attempt is given up.
const POLL_MS = 20;

/**
 * The directory that holds the gate files of one gate.
 */
function gateDir(projectRoot, name) {
  return path.join(pluginDir(projectRoot), ".density-gates", String(name));
}

/**
 * Allocate the next ticket of a gate.
 *
 * The ticket is allocated by an EXCLUSIVE CREATE of the file that carries
 * it, so it can never go backwards and never be handed out twice: a
 * read-modify-write counter would hand the same number to two participants,
 * and two participants that believe they hold the lowest ticket are two
 * participants in the critical section.
 */
function allocateGateTicket(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let highest = 0;
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith("ticket-")) continue;
        const value = Number(entry.slice("ticket-".length));
        if (Number.isFinite(value) && value > highest) highest = value;
      }
    } catch (_) { highest = 0; }
    const next = highest + 1;
    try {
      const handle = fs.openSync(path.join(dir, "ticket-" + next), "wx", 0o600);
      fs.closeSync(handle);
      return next;
    } catch (err) {
      // Somebody else took that number: take the next one.
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("density gate ticket allocation exhausted");
}

// The name of a participant file carries its IDENTITY:
//
//   gate-<ticket>-<pid>-<random>.json
//
// The identity is in the NAME and not in the content, because a file whose
// content was not written completely -- a short write, a full disk -- must
// still be recognisable by the other participants. A participant that
// cannot be read is invisible, and an invisible participant is a
// participant that everybody else walks into.
const GATE_NAME = /^gate-(\d+)-(\d+)-[0-9a-f]+\.json$/;

/**
 * The identity of a participant file, read from its NAME.
 *
 * Returns { ticket, pid, ageMs } or null when the file is not a
 * participant file.
 */
function readGateEntry(file) {
  const name = path.basename(file);
  const match = GATE_NAME.exec(name);
  if (!match) return null;
  let ageMs = 0;
  try {
    ageMs = Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
  } catch (_) {
    ageMs = 0;
  }
  return { ticket: Number(match[1]), pid: Number(match[2]), ageMs };
}

/**
 * Whether a gate participant is gone.
 *
 * A participant is gone when its process is not running any more AND its
 * gate file is older than the stale window. The age is what keeps a
 * process that is alive but stuck from being removed: the liveness check
 * alone would remove a participant that is about to publish.
 */
function gateEntryIsStale(entry, staleMs) {
  // A participant file that cannot be READ is not known to be gone: it is
  // only removed when it is older than the stale window, so a participant
  // that is alive but whose file was damaged cannot lock everybody out.
  if (!entry) return false;
  if (entry.pid && isProcessAlive(Number(entry.pid))) return false;
  return entry.ageMs > staleMs;
}

/**
 * Write the participant file of a gate.
 *
 * The file is written with the low-level write, and a SHORT write is
 * retried: a participant file that carries half of its content cannot be
 * read by the other participants, and a participant that cannot be read is
 * invisible to them.
 */
function writeGateFile(file, body) {
  let handle;
  try {
    handle = fs.openSync(file, "wx", 0o600);
  } catch (err) {
    return false;
  }
  try {
    // The content is informational: the identity of the participant is in
    // its NAME. A write that fails therefore does not invalidate the
    // participant -- it only makes the file less descriptive.
    try { fs.writeFileSync(handle, body); } catch (_) { /* best-effort */ }
  } catch (_) {
    // The file exists, which is what matters: the exclusive create is the
    // atomic step, and the name carries the identity.
  } finally {
    try { fs.closeSync(handle); } catch (__) { /* already closed */ }
  }
  return true;
}

/**
 * Take the gate.
 *
 * Returns a handle with `release()` and `isHeld()`, or null when the gate
 * could not be taken within `timeoutMs`. A null return is NOT a failure:
 * it says that somebody else is inside the protocol right now, and the
 * caller has to leave the graph alone.
 *
 * The gate is RE-ENTRANT inside one process: taking a gate that this
 * process already holds returns a handle that does nothing on release.
 */
function acquireGate(projectRoot, name = REBUILD_GATE, { timeoutMs = 250, staleMs = 6 * 60 * 60 * 1000 } = {}) {
  const key = path.resolve(String(projectRoot)) + "::" + String(name);
  if (heldGates.has(key)) {
    return {
      name,
      reentrant: true,
      isHeld() { return true; },
      release() { /* the outer holder keeps the gate */ },
    };
  }

  const dir = gateDir(projectRoot, name);
  let ticket;
  try {
    ticket = allocateGateTicket(dir);
  } catch (_) {
    return null;
  }

  // The name of the participant file carries the ticket, the pid and a
  // random suffix, so no other participant can ever take it.
  const file = path.join(
    dir,
    "gate-" + ticket + "-" + process.pid + "-" + crypto.randomBytes(6).toString("hex") + ".json"
  );
  const written = writeGateFile(file, JSON.stringify({
    ticket,
    pid: process.pid,
    at: new Date().toISOString(),
  }));
  if (!written) return null;

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let winner = false;
  // The number of consecutive scans in which this participant saw itself as
  // the lowest live ticket. A participant that saw itself as the lowest
  // ONCE may have missed a lower-ticket participant that had not written
  // its file yet, so the victory is only declared after a second scan that
  // is separated by a poll.
  let lowestSeen = 0;
  for (;;) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      entries = [];
    }
    const live = [];
    for (const entry of entries) {
      if (!entry.startsWith("gate-") || !entry.endsWith(".json")) continue;
      const other = path.join(dir, entry);
      if (other === file) {
        live.push({ file: other, ticket, mine: true });
        continue;
      }
      const record = readGateEntry(other);
      if (gateEntryIsStale(record, staleMs)) {
        // The participant is gone. Its file has a name no other participant
        // can take, so removing it cannot disturb anybody else.
        try { fs.unlinkSync(other); } catch (_) { /* best-effort */ }
        continue;
      }
      const otherTicket = Number(record && record.ticket);
      if (!Number.isFinite(otherTicket)) continue;
      live.push({ file: other, ticket: otherTicket, mine: false });
    }
    let lowest = null;
    for (const entry of live) {
      if (lowest === null || entry.ticket < lowest.ticket) lowest = entry;
    }
    if (lowest && lowest.mine) {
      lowestSeen += 1;
      if (lowestSeen >= 2) {
        winner = true;
        break;
      }
    } else {
      lowestSeen = 0;
    }
    if (winner) break;
    if (Date.now() >= deadline && lowestSeen === 0) break;
    sleepSync(POLL_MS);
  }

  if (!winner) {
    // The gate was not taken: the participant file is removed again, so the
    // gate is left exactly as it was found.
    try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
    return null;
  }

  heldGates.set(key, { file, ticket });
  let released = false;
  return {
    name,
    ticket,
    reentrant: false,
    isHeld() {
      try {
        fs.accessSync(file);
        return true;
      } catch (_) {
        return false;
      }
    },
    release() {
      if (released) return;
      released = true;
      heldGates.delete(key);
      // The file has a name that no other participant can take, so the
      // removal can never take a live participant's gate away.
      try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
    },
  };
}

/**
 * Sleep synchronously for a few milliseconds.
 */
function sleepSync(ms) {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  } catch (_) {
    // A host without Atomics.wait simply does not wait.
  }
}

/**
 * Whether this process holds the gate.
 */
function gateHeld(projectRoot, name = REBUILD_GATE) {
  const key = path.resolve(String(projectRoot)) + "::" + String(name);
  return heldGates.has(key);
}

module.exports = {
  REBUILD_GATE,
  gateDir,
  allocateGateTicket,
  readGateEntry,
  gateEntryIsStale,
  acquireGate,
  gateHeld,
};

