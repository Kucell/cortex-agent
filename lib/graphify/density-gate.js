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
 * -- The ticket is PERMANENTLY TAKEN ------------------------------------
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
 * So the registration is ONE atomic step: the slot file is created with an
 * EXCLUSIVE create of a name that carries the ticket, and the CONTENT is
 * published in the same step. The file is created by LINKING a file that
 * is already complete, so a participant that scans the directory never
 * sees a half-written registration: the name exists only when the content
 * is there.
 *
 * A ticket is TAKEN FOR EVER. The slot file of a ticket that was used is
 * not renamed and not removed: it is marked as released, and the name
 * keeps the ticket occupied. That is what closes the window in which a
 * late participant could take a ticket that was already handed out:
 *
 *   - the participant reads the highest ticket, and pauses;
 *   - somebody else takes that ticket, uses it and releases it;
 *   - the participant resumes and creates the file of that ticket.
 *
 * The file of that ticket is still there -- released, but present -- so
 * the exclusive create fails and the late participant takes the NEXT
 * ticket. It therefore never enters the gate in front of a participant
 * that arrived earlier, and the order of the participants is the order in
 * which their tickets were taken.
 *
 * The gate is held by the participant with the LOWEST live ticket, and a
 * participant that is gone is marked as released in ITS OWN slot -- a
 * slot no other participant can ever take, because the ticket is allocated
 * by an exclusive create and the slot keeps its name.
 *
 * The removal of a participant is therefore exact: it can never take a
 * live participant's gate away, no matter how the two interleave. That is
 * the property the lock at a fixed path never had.
 *
 * -- The liveness of a participant --------------------------------------
 *
 * A participant that is gone is one whose process is not running any more
 * AND whose slot is older than the stale window. The age is what keeps a
 * process that is alive but stuck from being removed: the liveness check
 * alone would remove a participant that is about to publish. A slot whose
 * CONTENT cannot be read is a participant of unknown liveness: it is only
 * removed when it is older than the stale window, so a participant that is
 * alive but whose slot was damaged cannot lock everybody out.
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

// How many times the registration tries the next ticket before it gives up.
const REGISTRATION_ATTEMPTS = 64;

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
const USED_NAME = /^used-(\d+)(?:-[0-9a-f]+)?\.json$/;

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
    let active = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && Number.isFinite(Number(parsed.pid))) pid = Number(parsed.pid);
      // A slot that says it is released is not a participant any more. A
      // slot whose content cannot be read is a participant of UNKNOWN
      // liveness: it is only removed when it is older than the stale
      // window.
      if (parsed && parsed.active === false) active = false;
    } catch (_) {
      // The content is not readable: the liveness of the participant is
      // unknown, and an unknown participant is only removed when it is
      // older than the stale window.
      pid = null;
    }
    return { ticket: Number(current[1]), pid, ageMs, name, active, legacy: false };
  }
  const legacy = LEGACY_GATE_NAME.exec(name);
  if (legacy) {
    return { ticket: Number(legacy[1]), pid: Number(legacy[2]), ageMs, name, active: true, legacy: true };
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
  if (entry.active === false) return true;
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
 * Create a file that does not exist yet, with its content COMPLETE.
 *
 * The content is written into a temporary file first, and the temporary
 * file is LINKED to the target: the link is atomic, and it fails when the
 * target exists. The name therefore appears in the directory in the same
 * step in which the content becomes readable -- a participant that scans
 * the directory never sees a registration without a pid.
 *
 * Filesystems without hard links fall back to an exclusive create. The
 * fallback cannot publish the content in one step, so the content of a
 * registration may be read while it is written; the reader treats such a
 * registration as a participant of unknown liveness, which is the safe
 * direction.
 */
function createSlotExclusive(file, body) {
  const dir = path.dirname(file);
  const temporary = path.join(dir, ".register-" + process.pid + "-" + crypto.randomBytes(6).toString("hex") + ".tmp");
  try {
    fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
  } catch (err) {
    return { created: false, reason: err && err.code ? err.code : "write_failed" };
  }
  try {
    fs.linkSync(temporary, file);
    return { created: true };
  } catch (err) {
    const code = err && err.code ? err.code : "link_failed";
    if (code === "EEXIST") return { created: false, reason: "EEXIST" };
    if (code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "ENOSYS" || code === "EPERM" || code === "EXDEV") {
      // No hard links here: the exclusive create is the fallback.
      try {
        const handle = fs.openSync(file, "wx", 0o600);
        try {
          fs.writeFileSync(handle, body);
        } finally {
          fs.closeSync(handle);
        }
        return { created: true };
      } catch (inner) {
        return { created: false, reason: inner && inner.code ? inner.code : code };
      }
    }
    return { created: false, reason: code };
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* best-effort */ }
  }
}

/**
 * Mark a slot as released.
 *
 * The slot keeps its name -- and therefore its ticket -- and only its
 * CONTENT changes: the participant is not a participant any more, but the
 * ticket is not handed out a second time.
 */
function releaseSlot(file, ticket) {
  const body = JSON.stringify({
    ticket,
    pid: process.pid,
    active: false,
    releasedAt: new Date().toISOString(),
  });
  const temporary = file + ".release-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (_) { /* best-effort */ }
    return { ok: false, reason: err && err.code ? err.code : "release_failed" };
  }
}

/**
 * Register as a participant of the gate.
 *
 * The registration and the ticket allocation are the SAME atomic step:
 * the file is created with an exclusive create, and its name carries the
 * ticket. A participant that loses the race for a number takes the next
 * one, so the tickets are unique and ordered by the moment they were
 * taken. A ticket that was used before is NOT handed out again: its slot
 * is still in the directory, so the exclusive create of that name fails
 * and the late participant takes the next number.
 *
 * Returns { ticket, file } or null when the participant could not be
 * registered.
 */
function registerParticipant(dir, { onBeforeCreate = null } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    return null;
  }
  let ticket = highestTicket(dir) + 1;
  for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt += 1) {
    const file = path.join(dir, "gate-" + ticket + ".json");
    // A TEST SEAM: called after the ticket was decided and BEFORE the
    // slot was created. It injects the interleaving that used to hand out
    // the same ticket twice: somebody else takes the ticket in this
    // window.
    if (typeof onBeforeCreate === "function") {
      try { onBeforeCreate({ ticket, file }); } catch (_) { /* the seam must not break the registration */ }
    }
    // The exclusive create is the atomic step: the file exists from the
    // moment the ticket is taken, so every other participant sees it --
    // with its content, because the content is linked in the same step.
    const created = createSlotExclusive(file, JSON.stringify({
      ticket,
      pid: process.pid,
      active: true,
      at: new Date().toISOString(),
    }));
    if (created.created) return { ticket, file };
    // Somebody else took that number: take the next one. The create is
    // the only place where the ticket is decided, so the loser of the
    // race cannot believe that it owns a ticket that is in use.
    if (created.reason !== "EEXIST") return null;
    ticket += 1;
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
 * Mark a participant that is gone as released.
 *
 * The slot of the participant is marked as released: the ticket stays
 * taken, and the slot of ANOTHER participant is never touched. A slot of
 * the older protocol keeps its ticket as well: it is renamed to the name
 * of a used ticket, so that its number is not handed out again.
 */
function reclaimParticipant(dir, file, record) {
  if (record && record.legacy) {
    const tombstone = path.join(dir, "used-" + record.ticket + "-" + crypto.randomBytes(4).toString("hex") + ".json");
    try {
      fs.renameSync(file, tombstone);
      return { ok: true };
    } catch (_) {
      try { fs.unlinkSync(file); } catch (__) { /* best-effort */ }
      return { ok: true };
    }
  }
  return releaseSlot(file, record ? record.ticket : 0);
}

/**
 * The participants that are alive, and the removal of the ones that are
 * gone.
 *
 * A participant that is gone is marked as released in its own slot. The
 * name of that slot carries a ticket that is never handed out twice,
 * because the slot stays in the directory, so the removal can never take
 * a live participant's gate away.
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
    if (record.active === false) {
      // A released participant: the ticket is still taken, but the slot
      // holds no participant any more.
      continue;
    }
    if (gateEntryIsStale(record, staleMs)) {
      reclaimParticipant(dir, other, record);
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
function acquireGate(projectRoot, name = REBUILD_GATE, { timeoutMs = 250, staleMs = 6 * 60 * 60 * 1000, onBeforeCreate = null } = {}) {
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
  const participant = registerParticipant(dir, { onBeforeCreate });
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
    // The gate was not taken: the slot is marked as released, so the gate
    // is left exactly as it was found -- and the ticket is not handed out
    // a second time.
    releaseSlot(file, ticket);
    return null;
  }

  heldGates.set(key, { file, ticket });
  let released = false;
  return {
    name,
    ticket,
    reentrant: false,
    isHeld() {
      // The slot is there AND it still holds this participant AND no live
      // participant comes before this one: the gate belongs to this
      // participant only while it is the first one. A participant whose
      // slot was reclaimed -- by a reclaim that judged it gone -- sees that
      // here, because the reclaim marked the slot as released.
      const record = readGateEntry(file);
      if (!record) return false;
      if (record.active === false) return false;
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
      // The slot is MARKED as released, not renamed and not removed: the
      // ticket it carries is not handed out a second time, and the name of
      // a released slot is not a participant any more.
      releaseSlot(file, ticket);
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

