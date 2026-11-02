"use strict";

// CANDIDATE control-ledger contract. NOT an authority, NOT a durability proof,
// NOT production wiring.
//
// This module defines only the *shape* of a trusted control ledger: the
// operation identity, the owner/fence, the complete logical slot, the
// immutable original bytes and the phase transitions. It performs no
// filesystem, database, network or signing access, and it never claims that
// a pending registration proves a business commit.
//
// The contract exists because the current journal/high-water pair cannot act
// as the control domain the publication proposal requires: it lives inside
// the anchor domain, its head is derived from the entries themselves, and it
// has no genesis or anti-rollback registration. Adding a `pending` record
// type to that journal would not create those properties.
//
// Everything here is a pure, synchronous state machine over an explicit
// head. The real backend must supply the trusted head, the owner/fence and
// the durable binding; this module only says what a legal transition is and
// refuses every illegal one.

const { createHash } = require("node:crypto");
const { types: { isProxy } } = require("node:util");

const LIMITS = Object.freeze({
  id: 128,
  domain: 128,
  bytes: 1024 * 1024,
  phase: 64,
  reason: 256,
  slots: 64,
});

const DOMAIN = "cortex-permit-control-ledger-v1\0";

// Phases are ordered by obligation, not by time. A transition may only move
// forward, and only to a phase whose precondition is already recorded.
const PHASES = Object.freeze({
  // Nothing has been attempted. No side effect may have happened.
  NOT_ATTEMPTED: "not-attempted",
  // The plan is registered in the control domain. Registration itself is not
  // evidence that any side effect ran, and is not evidence that the control
  // domain is durable.
  REGISTERED: "registered",
  // A specific side effect is about to be invoked. The exact side effect is
  // named so recovery can tell "not called" from "called, outcome unknown".
  CALL_POSSIBLE: "call-possible",
  // The side effect was invoked and its outcome is not yet known.
  CALLED_UNKNOWN: "called-unknown",
  // The side effect was invoked and its outcome was confirmed.
  CONFIRMED: "confirmed",
  // The operation reached a terminal business outcome. The terminal outcome
  // is recorded separately from the ledger phase because a business commit
  // and a ledger completion are different facts.
  COMPLETED: "completed",
  // The operation is permanently blocked. A blocked operation never becomes
  // completed and never authorizes a retry on its own.
  BLOCKED: "blocked",
});

// The terminal business outcomes. These are deliberately NOT ledger phases:
// the proposal requires the business commit fact, the publication fact and
// the client delivery fact to stay separable.
const OUTCOMES = Object.freeze({
  // The business commit path was never invoked by this attempt.
  NOT_ATTEMPTED: "not-attempted",
  // The business commit path was invoked and its outcome is unknown.
  COMMIT_UNKNOWN: "commit-unknown",
  // The business commit is known to have happened, but a later publication
  // or release barrier is not confirmed.
  COMMITTED_UNPUBLISHABLE: "committed-unpublishable",
  // Every required barrier for this scope was confirmed.
  CONFIRMED: "confirmed",
});

const SIDE_EFFECTS = Object.freeze({
  BOOTSTRAP_DATABASE: "bootstrap-database",
  BOOTSTRAP_COORDINATION: "bootstrap-coordination",
  BOOTSTRAP_ANCHOR_ENTRY: "bootstrap-anchor-entry",
  BOOTSTRAP_HIGH_WATER: "bootstrap-high-water",
  BOOTSTRAP_AUDIT: "bootstrap-audit",
  OPERATION_ANCHOR_INTENT: "operation-anchor-intent",
  OPERATION_AUDIT: "operation-audit",
  OPERATION_DATABASE_COMMIT: "operation-database-commit",
  OPERATION_ANCHOR_COMMIT: "operation-anchor-commit",
  OPERATION_HIGH_WATER: "operation-high-water",
  OPERATION_LOCK_RELEASE: "operation-lock-release",
  OPERATION_CLIENT_DELIVERY: "operation-client-delivery",
});

class ControlLedgerError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "ControlLedgerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, details) { throw new ControlLedgerError(code, details); }

// Reject proxies, exotic prototypes and shadowed accessors before any
// property of the input is read. A control ledger that accepts a caller
// object with getters would let the caller choose the registered bytes.
function plain(value, keys, code) {
  if (isProxy(value) || !value || typeof value !== "object") fail(code);
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length) fail(code);
  for (const name of names) {
    if (typeof name !== "string" || !keys.includes(name)) fail(code);
    const descriptor = descriptors[name];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(code);
  }
  const out = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor) fail(code);
    out[key] = descriptor.value;
  }
  return out;
}

function identifier(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.id) fail(code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) fail(code);
  return value;
}

function phaseName(value) {
  if (typeof value !== "string") fail("ERR_CONTROL_LEDGER_PHASE");
  if (!Object.values(PHASES).includes(value)) fail("ERR_CONTROL_LEDGER_PHASE");
  return value;
}

function outcomeName(value) {
  if (value === null) return null;
  if (typeof value !== "string") fail("ERR_CONTROL_LEDGER_OUTCOME");
  if (!Object.values(OUTCOMES).includes(value)) fail("ERR_CONTROL_LEDGER_OUTCOME");
  return value;
}

function sideEffect(value) {
  if (typeof value !== "string") fail("ERR_CONTROL_LEDGER_SIDE_EFFECT");
  if (!Object.values(SIDE_EFFECTS).includes(value)) fail("ERR_CONTROL_LEDGER_SIDE_EFFECT");
  return value;
}

// The original bytes are part of the registered plan, not only a digest.
// Recovery must be able to re-verify and, where the protocol allows it,
// forward-complete with the exact bytes that were intended.
function originalBytes(value) {
  if (!Buffer.isBuffer(value)) fail("ERR_CONTROL_LEDGER_BYTES");
  if (value.length > LIMITS.bytes) fail("ERR_CONTROL_LEDGER_LIMIT");
  return Buffer.from(value);
}

// A logical slot is the identity of the record a publication is about. The
// digest and the version are bound to the slot; they do not create a second
// slot. Two different slots may legitimately carry the same digest.
function slot(value) {
  const record = plain(value, ["domain", "store_id", "sequence", "attempt", "record_type"], "ERR_CONTROL_LEDGER_SLOT");
  const out = {
    domain: identifier(record.domain, "ERR_CONTROL_LEDGER_SLOT"),
    store_id: identifier(record.store_id, "ERR_CONTROL_LEDGER_SLOT"),
    sequence: record.sequence,
    attempt: record.attempt,
    record_type: record.record_type,
  };
  if (!Number.isSafeInteger(out.sequence) || out.sequence < 1) fail("ERR_CONTROL_LEDGER_SLOT");
  if (!Number.isSafeInteger(out.attempt) || out.attempt < 1) fail("ERR_CONTROL_LEDGER_SLOT");
  if (typeof out.record_type !== "string" || out.record_type.length === 0 || out.record_type.length > LIMITS.phase) {
    fail("ERR_CONTROL_LEDGER_SLOT");
  }
  return Object.freeze(out);
}

function slotKey(value) {
  return [value.domain, value.store_id, value.sequence, value.attempt, value.record_type].join("\u0000");
}

function digestOf(bytes) {
  return createHash("sha256").update(DOMAIN, "utf8").update(bytes).digest("hex");
}

// The head is what makes the ledger a control domain rather than a log. It
// must be supplied by a trusted backend and is compared, never recomputed
// from the caller's own records.
function head(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("ERR_CONTROL_LEDGER_HEAD");
  return value;
}

// An owner binding carries the generation that owns the domain plus a fence.
// A different owner generation or a stale fence must not be able to extend a
// registration, otherwise a slow writer could outlive its own successor.
function owner(value) {
  const record = plain(value, ["owner_id", "owner_generation", "fence"], "ERR_CONTROL_LEDGER_OWNER");
  const out = {
    owner_id: identifier(record.owner_id, "ERR_CONTROL_LEDGER_OWNER"),
    owner_generation: record.owner_generation,
    fence: record.fence,
  };
  if (!Number.isSafeInteger(out.owner_generation) || out.owner_generation < 1) fail("ERR_CONTROL_LEDGER_OWNER");
  if (!Number.isSafeInteger(out.fence) || out.fence < 1) fail("ERR_CONTROL_LEDGER_OWNER");
  return Object.freeze(out);
}

function ownerKey(value) {
  return [value.owner_id, value.owner_generation, value.fence].join("\u0000");
}

// A registration is the immutable plan. It is created once and never
// mutated; every later phase is a separate record that references it.
function registration(value) {
  const record = plain(value,
    ["operation_id", "domain", "kind", "owner", "slot", "original_bytes", "body_digest", "expected_head", "created_at_ms"],
    "ERR_CONTROL_LEDGER_REGISTRATION");
  const bytes = originalBytes(record.original_bytes);
  const out = {
    operation_id: identifier(record.operation_id, "ERR_CONTROL_LEDGER_REGISTRATION"),
    domain: identifier(record.domain, "ERR_CONTROL_LEDGER_REGISTRATION"),
    kind: record.kind,
    owner: owner(record.owner),
    slot: slot(record.slot),
    original_bytes: bytes,
    body_digest: digestOf(bytes),
    expected_head: head(record.expected_head),
    created_at_ms: record.created_at_ms,
  };
  if (out.kind !== "bootstrap" && out.kind !== "transaction" && out.kind !== "recovery") {
    fail("ERR_CONTROL_LEDGER_REGISTRATION");
  }
  if (!Number.isSafeInteger(out.created_at_ms) || out.created_at_ms < 0) fail("ERR_CONTROL_LEDGER_REGISTRATION");
  if (record.body_digest !== undefined && record.body_digest !== out.body_digest) {
    fail("ERR_CONTROL_LEDGER_REGISTRATION");
  }
  return Object.freeze(out);
}

// A phase record advances the ledger. `expected_head` is the head the caller
// believes it is extending; a mismatch means the domain moved underneath it
// and the transition is refused rather than merged.
function phaseRecord(value) {
  const record = plain(value,
    ["operation_id", "phase", "side_effect", "expected_head", "owner", "at_ms", "reason"],
    "ERR_CONTROL_LEDGER_PHASE");
  const out = {
    operation_id: identifier(record.operation_id, "ERR_CONTROL_LEDGER_PHASE"),
    phase: phaseName(record.phase),
    side_effect: record.side_effect === null ? null : sideEffect(record.side_effect),
    expected_head: head(record.expected_head),
    owner: owner(record.owner),
    at_ms: record.at_ms,
    reason: record.reason === null ? null : record.reason,
  };
  if (!Number.isSafeInteger(out.at_ms) || out.at_ms < 0) fail("ERR_CONTROL_LEDGER_PHASE");
  if (out.reason !== null && (typeof out.reason !== "string" || out.reason.length > LIMITS.reason)) {
    fail("ERR_CONTROL_LEDGER_PHASE");
  }
  if (out.side_effect === null && out.phase === PHASES.CALL_POSSIBLE) {
    fail("ERR_CONTROL_LEDGER_PHASE");
  }
  return Object.freeze(out);
}

// The legal transitions. Every one of them keeps the three invariants of the
// proposal: a registration never proves a business commit, an unknown call is
// never auto-aborted, and a blocked operation never becomes completed.
// The legal phase transitions. The transitions are effect-aware: after an
// effect has been confirmed, the next phase may start a *different* effect,
// while a confirmation that follows an unknown must refer to the *same*
// effect and therefore carries late evidence rather than a new step.
const TRANSITIONS = Object.freeze({
  [PHASES.NOT_ATTEMPTED]: [PHASES.REGISTERED, PHASES.BLOCKED],
  [PHASES.REGISTERED]: [PHASES.CALL_POSSIBLE, PHASES.BLOCKED],
  [PHASES.CALL_POSSIBLE]: [PHASES.CALLED_UNKNOWN, PHASES.CONFIRMED, PHASES.BLOCKED],
  // An unknown call freezes the affected scope. The publication proposal's
  // completion table requires the business COMMIT to stay `not-attempted`
  // when an earlier barrier's outcome is unknown, so no *new* side effect may
  // be declared after an unknown. Only late evidence for the same effect, or
  // an explicit block, may follow.
  [PHASES.CALLED_UNKNOWN]: [PHASES.CONFIRMED, PHASES.BLOCKED],
  [PHASES.CONFIRMED]: [PHASES.CALL_POSSIBLE, PHASES.COMPLETED, PHASES.BLOCKED],
  [PHASES.COMPLETED]: [],
  [PHASES.BLOCKED]: [],
});

// Which side effects a registration kind may declare. A transaction may not
// bootstrap a database, and a bootstrap may not run an ordinary transaction
// side effect; otherwise one registration could smuggle the other protocol's
// ordering guarantees in under the wrong name.
const ALLOWED_SIDE_EFFECTS = Object.freeze({
  bootstrap: new Set(Object.values(SIDE_EFFECTS).filter((name) => name.startsWith("bootstrap-"))),
  transaction: new Set(Object.values(SIDE_EFFECTS).filter((name) => name.startsWith("operation-"))),
  recovery: new Set(Object.values(SIDE_EFFECTS)),
});

// A ledger is the immutable registration plus its ordered phase records.
// The backend supplies the trusted head; this object never derives it.
function createLedger(registrationValue, trustedHead) {
  const reg = registration(registrationValue);
  const currentHead = head(trustedHead);
  if (reg.expected_head !== currentHead) fail("ERR_CONTROL_LEDGER_HEAD_MISMATCH");
  return Object.freeze({
    registration: reg,
    head: currentHead,
    phases: Object.freeze([]),
    outcome: null,
  });
}

function lastPhase(ledger) {
  if (!ledger.phases.length) return PHASES.NOT_ATTEMPTED;
  return ledger.phases[ledger.phases.length - 1].phase;
}

// The effect that the current phase is about, or null when the phase does not
// name one. The last phase may be `registered` or `completed`, which do not
// carry an effect, so the effect is looked up from the phase records.
function lastEffect(ledger) {
  for (let index = ledger.phases.length - 1; index >= 0; index--) {
    const entry = ledger.phases[index];
    if (entry.side_effect !== null) return entry.side_effect;
  }
  return null;
}

// The most recent phase recorded for one effect.
function phaseForEffect(ledger, effect) {
  for (let index = ledger.phases.length - 1; index >= 0; index--) {
    const entry = ledger.phases[index];
    if (entry.side_effect === effect) return entry.phase;
  }
  return null;
}

// Advance the ledger by one phase record. The record must reference the same
// operation, the same owner generation and the current head.
function advance(ledger, phaseValue) {
  const record = phaseRecord(phaseValue);
  if (record.operation_id !== ledger.registration.operation_id) fail("ERR_CONTROL_LEDGER_OPERATION_MISMATCH");
  if (ownerKey(record.owner) !== ownerKey(ledger.registration.owner)) fail("ERR_CONTROL_LEDGER_OWNER_MISMATCH");
  if (record.expected_head !== ledger.head) fail("ERR_CONTROL_LEDGER_HEAD_MISMATCH");
  const from = lastPhase(ledger);
  if (!TRANSITIONS[from].includes(record.phase)) fail("ERR_CONTROL_LEDGER_TRANSITION");
  if (record.side_effect !== null && !ALLOWED_SIDE_EFFECTS[ledger.registration.kind].has(record.side_effect)) {
    fail("ERR_CONTROL_LEDGER_SIDE_EFFECT");
  }
  if (record.phase === PHASES.REGISTERED && record.side_effect !== null) fail("ERR_CONTROL_LEDGER_PHASE");
  if ((record.phase === PHASES.CALL_POSSIBLE || record.phase === PHASES.CALLED_UNKNOWN ||
       record.phase === PHASES.CONFIRMED) && record.side_effect === null) {
    fail("ERR_CONTROL_LEDGER_PHASE");
  }
  // After an unknown, only late evidence for the same effect or an explicit
  // block may follow. Starting a different effect while an earlier one is
  // unknown would let the business COMMIT run past an unverified barrier.
  if (record.phase === PHASES.CALL_POSSIBLE && lastPhase(ledger) === PHASES.CALLED_UNKNOWN) {
    const unknownEffect = lastEffect(ledger);
    if (unknownEffect === null || record.side_effect === unknownEffect) fail("ERR_CONTROL_LEDGER_TRANSITION");
  }
  // A confirmation that follows an unknown is late evidence for that effect.
  // It must not be used to introduce an effect that was never declared.
  if (record.phase === PHASES.CONFIRMED && lastPhase(ledger) === PHASES.CALLED_UNKNOWN) {
    if (record.side_effect !== lastEffect(ledger)) fail("ERR_CONTROL_LEDGER_TRANSITION");
  }
  // A confirmation or an unknown that follows a declaration is the outcome
  // of THAT declaration. Accepting a different effect would let the ledger
  // report one side effect as confirmed while the declared one is still
  // pending, so the record would contradict its own declaration order.
  if ((record.phase === PHASES.CONFIRMED || record.phase === PHASES.CALLED_UNKNOWN) &&
      lastPhase(ledger) === PHASES.CALL_POSSIBLE) {
    if (record.side_effect !== lastEffect(ledger)) fail("ERR_CONTROL_LEDGER_TRANSITION");
  }
  // An effect may not be declared twice as call-possible: a second attempt
  // would be a new attempt, which needs a new registration.
  if (record.phase === PHASES.CALL_POSSIBLE && phaseForEffect(ledger, record.side_effect) !== null) {
    fail("ERR_CONTROL_LEDGER_TRANSITION");
  }
  return Object.freeze({
    registration: ledger.registration,
    head: ledger.head,
    phases: Object.freeze([...ledger.phases, record]),
    outcome: ledger.outcome,
  });
}

// Record the terminal business outcome. This is separate from the ledger
// phase on purpose: `committed-unpublishable` means the business commit is a
// fact while the publication is not confirmed, and a single boolean could
// not express that.
function settle(ledger, outcomeValue, expectedHead) {
  const outcome = outcomeName(outcomeValue);
  if (outcome === null) fail("ERR_CONTROL_LEDGER_OUTCOME");
  if (ledger.outcome !== null) fail("ERR_CONTROL_LEDGER_ALREADY_SETTLED");
  const current = lastPhase(ledger);
  if (current !== PHASES.CONFIRMED && current !== PHASES.CALLED_UNKNOWN &&
      current !== PHASES.BLOCKED && current !== PHASES.COMPLETED) {
    fail("ERR_CONTROL_LEDGER_TRANSITION");
  }
  if (head(expectedHead) !== ledger.head) fail("ERR_CONTROL_LEDGER_HEAD_MISMATCH");
  // A confirmed business commit may only be settled as committed-unpublishable
  // or confirmed. Reporting `not-attempted` after a confirmed commit would
  // erase a fact that already happened.
  // The check looks at the recorded history, not at the current phase: the
  // phase has already advanced to `completed` by the time the outcome is
  // settled, so the current phase no longer says whether a commit happened.
  // The phase strings and the outcome strings share the word "confirmed",
  // so the check is made on the recorded history: a business commit may only
  // be reported as confirmed when a commit side effect actually reached the
  // confirmed phase, and never while a commit call is still unknown.
  const confirmedEffects = ledger.phases.filter((entry) => entry.phase === PHASES.CONFIRMED).map((entry) => entry.side_effect);
  const unknownEffects = ledger.phases.filter((entry) => entry.phase === PHASES.CALLED_UNKNOWN).map((entry) => entry.side_effect);
  const commitConfirmed = confirmedEffects.includes(SIDE_EFFECTS.OPERATION_DATABASE_COMMIT) ||
    confirmedEffects.includes(SIDE_EFFECTS.BOOTSTRAP_DATABASE);
  const commitUnknown = unknownEffects.includes(SIDE_EFFECTS.OPERATION_DATABASE_COMMIT) ||
    unknownEffects.includes(SIDE_EFFECTS.BOOTSTRAP_DATABASE);
  if (outcome === OUTCOMES.NOT_ATTEMPTED && (confirmedEffects.length > 0 || unknownEffects.length > 0)) {
    fail("ERR_CONTROL_LEDGER_TRANSITION");
  }
  if (outcome === OUTCOMES.CONFIRMED && (!commitConfirmed || commitUnknown)) {
    fail("ERR_CONTROL_LEDGER_TRANSITION");
  }
  return Object.freeze({
    registration: ledger.registration,
    head: ledger.head,
    phases: ledger.phases,
    outcome,
  });
}

// The recovery view. It reports what a recovering process is allowed to
// conclude. It never authorizes a retry, a cleanup or an abort by itself.
function recoveryView(ledger) {
  const current = lastPhase(ledger);
  const possible = ledger.phases.filter((entry) => entry.phase === PHASES.CALL_POSSIBLE);
  const unknown = ledger.phases.filter((entry) => entry.phase === PHASES.CALLED_UNKNOWN);
  const confirmed = ledger.phases.filter((entry) => entry.phase === PHASES.CONFIRMED);
  // Classify each declared side effect by its strongest recorded outcome. An
  // unknown always wins over a confirmed one, so a later success can never
  // hide an earlier unknown for the same effect.
  const effects = new Set([...possible, ...unknown, ...confirmed].map((entry) => entry.side_effect));
  const pendingEffects = [];
  const unknownEffects = [];
  const confirmedEffects = [];
  for (const effect of effects) {
    if (unknown.some((entry) => entry.side_effect === effect)) unknownEffects.push(effect);
    else if (confirmed.some((entry) => entry.side_effect === effect)) confirmedEffects.push(effect);
    else pendingEffects.push(effect);
  }
  return Object.freeze({
    operation_id: ledger.registration.operation_id,
    kind: ledger.registration.kind,
    owner_generation: ledger.registration.owner.owner_generation,
    slot: ledger.registration.slot,
    body_digest: ledger.registration.body_digest,
    expected_head: ledger.registration.expected_head,
    phase: current,
    outcome: ledger.outcome,
    pending_side_effects: Object.freeze(pendingEffects),
    unknown_side_effects: Object.freeze(unknownEffects),
    confirmed_side_effects: Object.freeze(confirmedEffects),
    // The three invariants, restated as machine-readable flags so a caller
    // cannot re-derive them with a different interpretation.
    proves_business_commit: false,
    authorizes_retry: false,
    authorizes_cleanup: false,
    requires_independent_review: true,
  });
}

module.exports = {
  LIMITS,
  DOMAIN,
  PHASES,
  OUTCOMES,
  SIDE_EFFECTS,
  ControlLedgerError,
  createLedger,
  advance,
  settle,
  recoveryView,
  slotKey,
  digestOf,
  lastPhase,
};
