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
 * -- The registration IS the ticket allocation ---------------------------
 *
 * The gate is a file per PARTICIPANT, and the NAME of that file carries
 * the ticket of the participant. The ticket is not allocated first and
 * registered afterwards: that gap is exactly where two participants end
 * up inside the gate at the same time. The first one allocates ticket 1
 * and pauses before it writes its file; the second one sees no participant
 * at all, believes that it holds the lowest ticket, and enters the
 * critical section; the first one resumes, writes its file, and enters as
 * well -- and the protocol has two holders in it.
 *
 * So the registration is ONE atomic step: the participant file is created
 * with an EXCLUSIVE create, and the name of that file IS its ticket. The
 * participant is therefore visible -- with its ticket -- at the very
 * moment it owns the ticket, and no participant can ever hold a ticket
 * that another participant also holds.
 *
 * A participant that is done does not delete its file: it RENAMES it to
 * the name of a used ticket. The tickets therefore never go backwards,
 * and the name of a used ticket is not a participant any more.
 *
 * The gate is held by the participant with the LOWEST live ticket, and a
 * participant that is gone is removed by unlinking ITS OWN file -- a path
 * no other participant can ever take, because the ticket is allocated by
 * an exclusive create.
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

// The name of a participant file carries its TICKET. The ticket is the
// only part of the name: the exclusive create of that exact name is what
// makes the ticket unique, so two participants can never hold the same
// one.
const GATE_NAME = /^gate-(\d+)\.json$/;

// The name of a participant file of an EARLIER version of this protocol.
// Such a file is still a participant -- it still holds a ticket -- and it
// is honoured in the election, so that a participant of the older
// protocol keeps the gate closed while it is alive.
const LEGACY_GATE_NAME = /^gate-(\d+)-(\d+)-[0-9a-f]+\.json$/;

// The name of a ticket that was used and released. It keeps the ticket
// numbers from going backwards; it is not a participant any more.
const USED_NAME = /^used-(\d+)\.json$/;

/**
 * The identity of a participant file.
 *
 * The ticket comes from the NAME, because a file whose content was not
 * written completely -- a short write, a full disk -- must still be
 * recognisable by the other participants: the file itself is the proof
 * that the ticket is taken. The pid comes from the CONTENT of a file of
 * this version and from the NAME of a file of the older version, and a
 * participant whose pid cannot be read is not known to be gone.
 *
 * Returns { ticket, pid, ageMs, name } or null when the file is not a
 * participant file.
 */
function readGateEntry(file) {
  const name = path.basename(file);
  let ageMs = 0;
  try {
    ageMs = Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
  } catch (_) {
    ageMs = 0;
  }
  const current = GATE_NAME.exec(name);
  if (current) {
    let pid = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && Number.isFinite(Number(parsed.pid))) pid = Number(parsed.pid);
    } catch (_) {
      // The content is not readable: the liveness of the participant is
      // unknown, and an unknown participant is only removed when it is
      // older than the stale window.
      pid = null;
    }
    return { ticket: Number(current[1]), pid, ageMs, name };
  }
  const legacy = LEGACY_GATE_NAME.exec(name);
  if (legacy) {
    return { ticket: Number(legacy[1]), pid: Number(legacy[2]), ageMs, name };
  }
  return null;
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
 * The highest ticket that was ever taken in the gate directory.
 *
 * The tickets of the participants and the tickets that were used and
 * released both count: a ticket that was taken is never handed out a
 * second time, so the order of the participants is the order in which
 * they arrived.
 */
function highestTicket(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  let highest = 0;
  for (const entry of entries) {
    const current = GATE_NAME.exec(entry);
    const legacy = LEGACY_GATE_NAME.exec(entry);
    const used = USED_NAME.exec(entry);
    const value = Number(
      current ? current[1] : legacy ? legacy[1] : used ? used[1] : NaN,
    );
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return highest;
}

/**
 * Register as a participant of the gate.
 *
 * The registration and the ticket allocation are the SAME atomic step:
 * the file is created with an exclusive create, and its name carries the
 * ticket. A participant that loses the race for a number takes the next
 * one, so the tickets are unique and ordered by the moment they were
 * taken.
 *
 * Returns { ticket, file } or null when the participant could not be
 * registered.
 */
function registerParticipant(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    return null;
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const ticket = highestTicket(dir) + 1;
    const file = path.join(dir, "gate-" + ticket + ".json");
    try {
      // The exclusive create is the atomic step: the file exists from the
      // moment the ticket is taken, so every other participant sees it.
      fs.writeFileSync(file, JSON.stringify({
        ticket,
        pid: process.pid,
        at: new Date().toISOString(),
      }), { flag: "wx", mode: 0o600 });
      return { ticket, file };
    } catch (err) {
      // Somebody else took that number: take the next one. The create is
      // the only place where the ticket is decided, so the loser of the
      // race cannot believe that it owns a ticket that is in use.
      if (err && err.code === "EEXIST") continue;
      return null;
    }
  }
  return null;
}

/**
 * Whether one participant comes before another.
 *
 * The order is by TICKET and, for two participants with the same ticket,
 * by NAME. The names are unique, so the order is TOTAL: two participants
 * can never both believe that they are the first one.
 */
function participantComesFirst(one, other) {
  if (one.ticket !== other.ticket) return one.ticket < other.ticket;
  return String(one.name) < String(other.name);
}

/**
 * The participants that are alive, and the removal of the ones that are
 * gone.
 *
 * A participant that is gone is removed by unlinking ITS OWN file. The
 * name of that file carries a ticket that is never handed out twice while
 * the file is there, so the removal can never take a live participant's
 * gate away.
 */
function liveParticipants(dir, staleMs, myFile) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const live = [];
  for (const entry of entries) {
    if (!entry.startsWith("gate-") || !entry.endsWith(".json")) continue;
    const other = path.join(dir, entry);
    if (other === myFile) continue;
    const record = readGateEntry(other);
    if (!record) {
      // A file that is not a participant file: it is not one, and it must
      // not be mistaken for one. A file without a ticket would sort before
      // every participant and keep the gate closed for good.
      continue;
    }
    if (gateEntryIsStale(record, staleMs)) {
      try { fs.unlinkSync(other); } catch (_) { /* best-effort */ }
      continue;
    }
    live.push({ file: other, ticket: record.ticket, name: record.name });
  }
  return live;
}

/**
 * Take the gate.
 *
 * Returns a handle with release() and isHeld(), or null when the gate
 * could not be taken within timeoutMs. A null return is NOT a failure:
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
  const participant = registerParticipant(dir);
  if (!participant) return null;
  const ticket = participant.ticket;
  const file = participant.file;
  const mine = { file, ticket, name: path.basename(file) };

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let winner = false;
  for (;;) {
    const live = liveParticipants(dir, staleMs, file);
    let first = true;
    for (const other of live) {
      if (participantComesFirst(other, mine)) { first = false; break; }
    }
    if (first) { winner = true; break; }
    if (Date.now() >= deadline) break;
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
      // The participant file is there AND no live participant comes before
      // this one: the gate belongs to this participant only while it is the
      // first one. A participant whose file was taken away -- by a reclaim
      // that judged it gone -- sees that here.
      try {
        fs.accessSync(file);
      } catch (_) {
        return false;
      }
      const live = liveParticipants(dir, staleMs, file);
      for (const other of live) {
        if (participantComesFirst(other, mine)) return false;
      }
      return true;
    },
    release() {
      if (released) return;
      released = true;
      heldGates.delete(key);
      // The file is RENAMED instead of deleted: the ticket it carries is
      // not handed out a second time, and the name of a used ticket is not
      // a participant any more.
      try {
        fs.renameSync(file, path.join(dir, "used-" + ticket + ".json"));
      } catch (_) {
        try { fs.unlinkSync(file); } catch (__) { /* best-effort */ }
      }
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
  readGateEntry,
  gateEntryIsStale,
  highestTicket,
  registerParticipant,
  participantComesFirst,
  acquireGate,
  gateHeld,
};

