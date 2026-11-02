"use strict";

// CANDIDATE entry namespace enumeration. NOT an authority, NOT production
// wiring.
//
// The publication proposal (section 4.2) requires that the complete logical
// slot of a published entry is `(domain, store_id, sequence, attempt,
// record_type)`, and that the whole protected entry namespace is enumerated
// under an exclusive gate -- not only the name that the caller happened to
// assemble. A store that checks only the target name cannot see a second
// entry for the same slot under a different name.
//
// This module provides that enumeration and the conflict rules over it. It
// works on an already-read list of entries, so it can be used both by the
// store (which reads the journal under the coordination lock) and by tests.
// It performs no filesystem access and makes no durability claim.

const LIMITS = Object.freeze({ entries: 65536, slots: 65536, id: 128, digest: 64 });

const RECORD_TYPES = Object.freeze({ INTENT: "intent", COMMIT: "commit", ABORT: "abort" });

class EntryNamespaceError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "EntryNamespaceError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, details) { throw new EntryNamespaceError(code, details); }

function identifier(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.id) fail(code);
  return value;
}

function digest(value, code) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(code);
  return value;
}

// One entry of the protected namespace. The record type is part of the
// logical slot: an `intent` and a `commit` for the same
// `(domain, store_id, sequence, attempt)` are two records of one slot, not two
// slots.
function entry(value) {
  if (!value || typeof value !== "object") fail("ERR_ENTRY_NAMESPACE_INPUT");
  const type = value.type;
  if (!Object.values(RECORD_TYPES).includes(type)) fail("ERR_ENTRY_NAMESPACE_INPUT");
  const out = {
    domain: identifier(value.domain, "ERR_ENTRY_NAMESPACE_INPUT"),
    store_id: identifier(value.store_id, "ERR_ENTRY_NAMESPACE_INPUT"),
    sequence: value.sequence,
    attempt: value.attempt,
    type,
    body_digest: digest(value.body_digest, "ERR_ENTRY_NAMESPACE_INPUT"),
  };
  if (!Number.isSafeInteger(out.sequence) || out.sequence < 1) fail("ERR_ENTRY_NAMESPACE_INPUT");
  if (!Number.isSafeInteger(out.attempt) || out.attempt < 1) fail("ERR_ENTRY_NAMESPACE_INPUT");
  return out;
}

// The logical slot of an entry. The record type is NOT part of it: the same
// slot carries an intent and exactly one terminal record.
function slotOf(value) {
  return `${value.domain}\u0000${value.store_id}\u0000${value.sequence}\u0000${value.attempt}`;
}

// Enumerate the namespace and derive the slot map. The enumeration is
// bounded: an oversized namespace is a blocking condition, not a truncation.
function enumerate(entries, options = {}) {
  const domain = options.domain === undefined ? null : identifier(options.domain, "ERR_ENTRY_NAMESPACE_INPUT");
  if (!Array.isArray(entries)) fail("ERR_ENTRY_NAMESPACE_INPUT");
  if (entries.length > LIMITS.entries) fail("ERR_ENTRY_NAMESPACE_LIMIT");
  const slots = new Map();
  const records = [];
  for (const raw of entries) {
    const item = entry(raw);
    if (domain !== null && item.domain !== domain) continue;
    const key = slotOf(item);
    let slot = slots.get(key);
    if (!slot) {
      slot = {
        domain: item.domain,
        store_id: item.store_id,
        sequence: item.sequence,
        attempt: item.attempt,
        intents: [],
        commits: [],
        aborts: [],
        digests: new Set(),
      };
      slots.set(key, slot);
    }
    slot.digests.add(item.body_digest);
    if (item.type === RECORD_TYPES.INTENT) slot.intents.push(item);
    else if (item.type === RECORD_TYPES.COMMIT) slot.commits.push(item);
    else slot.aborts.push(item);
    records.push(item);
  }
  if (slots.size > LIMITS.slots) fail("ERR_ENTRY_NAMESPACE_LIMIT");
  return { slots, records, domain };
}

// The conflict rules of proposal section 4.2:
//
// - a slot must carry exactly one intent,
// - it must carry exactly one terminal record, `commit` XOR `abort`,
// - every record of the slot must agree on the body digest,
// - a slot that carries both a commit and an abort is a conflict.
//
// The function reports every conflict instead of the first one, so a
// recovering process sees the complete picture of what is wrong.
function findConflicts(namespace) {
  const conflicts = [];
  for (const slot of namespace.slots.values()) {
    const key = `${slot.domain}/${slot.store_id}/${slot.sequence}/${slot.attempt}`;
    if (slot.intents.length === 0) {
      conflicts.push({ slot: key, reason: "missing-intent" });
    } else if (slot.intents.length > 1) {
      conflicts.push({ slot: key, reason: "duplicate-intent", count: slot.intents.length });
    }
    if (slot.commits.length > 0 && slot.aborts.length > 0) {
      conflicts.push({ slot: key, reason: "commit-and-abort" });
    } else if (slot.commits.length > 1) {
      conflicts.push({ slot: key, reason: "duplicate-commit", count: slot.commits.length });
    } else if (slot.aborts.length > 1) {
      conflicts.push({ slot: key, reason: "duplicate-abort", count: slot.aborts.length });
    } else if (slot.commits.length === 0 && slot.aborts.length === 0) {
      conflicts.push({ slot: key, reason: "missing-terminal" });
    }
    if (slot.digests.size > 1) {
      conflicts.push({ slot: key, reason: "digest-mismatch", digests: [...slot.digests].sort() });
    }
  }
  return conflicts;
}

// The summary a caller needs to decide whether the namespace may be trusted.
// A non-empty conflict list is a blocking condition; it is never resolved by
// deleting or overwriting the offending records.
function summarize(namespace) {
  const conflicts = findConflicts(namespace);
  return Object.freeze({
    domain: namespace.domain,
    entries: namespace.records.length,
    slots: namespace.slots.size,
    conflicts: Object.freeze(conflicts),
    clean: conflicts.length === 0,
  });
}

// The attempt that a slot may still use. A new attempt is a new slot: it
// does not erase the unknown state of an earlier attempt. The counter is the
// highest attempt seen for the same `(domain, store_id, sequence)` plus one.
function nextAttemptFor(namespace, domain, storeId, sequence) {
  let highest = 0;
  for (const slot of namespace.slots.values()) {
    if (slot.domain !== domain || slot.store_id !== storeId || slot.sequence !== sequence) continue;
    if (slot.attempt > highest) highest = slot.attempt;
  }
  return highest + 1;
}

// The slots of the LATEST attempt of every sequence.
//
// An earlier attempt that never reached its terminal record is a superseded
// attempt, not a corruption: a retry of the same sequence writes a new
// intent with a higher attempt counter, and the earlier attempt is simply
// left behind. The latest attempt identifies the crash window that still
// needs recovery; corruption is checked across all attempts below.
function latestAttemptSlots(namespace) {
  const latest = new Map();
  for (const slot of namespace.slots.values()) {
    const key = `${slot.domain}\u0000${slot.store_id}\u0000${slot.sequence}`;
    const known = latest.get(key);
    if (known === undefined || slot.attempt > known.attempt) latest.set(key, slot);
  }
  return [...latest.values()];
}

// The conflicts of all attempts, split into the two kinds a caller
// has to treat differently.
//
// `unterminated` is a slot that carries an intent but no terminal record:
// the operation was interrupted between its intent and its outcome. That is
// the crash window, and it is NOT a corruption -- the caller has to recover
// it, not refuse the store.
//
// `corrupt` is everything else: a duplicated intent, a slot that carries
// both a commit and an abort, a duplicated terminal record, or a slot whose
// records disagree on the body digest. None of these can be settled by a
// recovery, because the outcome of the slot is not uniquely determined.
function partitionConflicts(namespace) {
  const corrupt = [];
  const unterminated = [];
  const latest = new Set(latestAttemptSlots(namespace));
  for (const slot of namespace.slots.values()) {
    const key = `${slot.domain}/${slot.store_id}/${slot.sequence}/${slot.attempt}`;
    if (slot.intents.length === 0) corrupt.push({ slot: key, reason: "missing-intent" });
    else if (slot.intents.length > 1) corrupt.push({ slot: key, reason: "duplicate-intent", count: slot.intents.length });
    if (slot.commits.length > 0 && slot.aborts.length > 0) {
      corrupt.push({ slot: key, reason: "commit-and-abort" });
    } else if (slot.commits.length > 1) {
      corrupt.push({ slot: key, reason: "duplicate-commit", count: slot.commits.length });
    } else if (slot.aborts.length > 1) {
      corrupt.push({ slot: key, reason: "duplicate-abort", count: slot.aborts.length });
    } else if (slot.commits.length === 0 && slot.aborts.length === 0 && latest.has(slot)) {
      unterminated.push({ slot: key, reason: "missing-terminal" });
    }
    if (slot.digests.size > 1) {
      corrupt.push({ slot: key, reason: "digest-mismatch", digests: [...slot.digests].sort() });
    }
  }
  return { corrupt, unterminated };
}

// Journal records do not carry a domain. Bind them to the caller's resolved
// domain before applying the same conflict rules used by ordinary opening.
function conflictsFor(entries, { domain }) {
  return partitionConflicts(enumerate(entries.map(item => ({ ...item, domain })), { domain }));
}

module.exports = {
  LIMITS,
  RECORD_TYPES,
  EntryNamespaceError,
  enumerate,
  findConflicts,
  summarize,
  slotOf,
  nextAttemptFor,
  latestAttemptSlots,
  partitionConflicts,
  conflictsFor,
};
