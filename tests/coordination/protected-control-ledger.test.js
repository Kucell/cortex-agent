"use strict";

// Contract tests for the candidate control ledger. Pure state machine only:
// no filesystem, no database, no authority, no durability claim.
const test = require("node:test");
const assert = require("node:assert");
const ledger = require("../../lib/coordination/protected-control-ledger");

const HEAD = "a".repeat(64);
const NEXT = "b".repeat(64);

function owner(generation = 1, fence = 7) {
  return { owner_id: "service-a", owner_generation: generation, fence };
}

function slot() {
  return { domain: "domain-a", store_id: "store-a", sequence: 3, attempt: 1, record_type: "intent" };
}

function registration(overrides = {}) {
  const bytes = Buffer.from('{"schema":1}\n');
  return {
    operation_id: "op-1",
    domain: "domain-a",
    kind: "transaction",
    owner: owner(),
    slot: slot(),
    original_bytes: bytes,
    body_digest: ledger.digestOf(bytes),
    expected_head: HEAD,
    created_at_ms: 1000,
    ...overrides,
  };
}

function phase(overrides = {}) {
  return {
    operation_id: "op-1",
    phase: ledger.PHASES.REGISTERED,
    side_effect: null,
    expected_head: HEAD,
    owner: owner(),
    at_ms: 1001,
    reason: null,
    ...overrides,
  };
}

test("a ledger starts at not-attempted and never proves a business commit", () => {
  const view = ledger.recoveryView(ledger.createLedger(registration(), HEAD));
  assert.strictEqual(view.phase, ledger.PHASES.NOT_ATTEMPTED);
  assert.strictEqual(view.outcome, null);
  assert.strictEqual(view.proves_business_commit, false);
  assert.strictEqual(view.authorizes_retry, false);
  assert.strictEqual(view.authorizes_cleanup, false);
  assert.strictEqual(view.requires_independent_review, true);
});

test("registration binds the complete logical slot and the original bytes", () => {
  const reg = ledger.createLedger(registration(), HEAD).registration;
  assert.strictEqual(reg.slot.sequence, 3);
  assert.strictEqual(reg.slot.attempt, 1);
  assert.strictEqual(reg.slot.record_type, "intent");
  assert.ok(Buffer.isBuffer(reg.original_bytes));
  assert.strictEqual(reg.body_digest, ledger.digestOf(reg.original_bytes));
  // Two different slots may legitimately carry the same digest.
  const other = ledger.createLedger(registration({ slot: { ...slot(), sequence: 4 } }), HEAD).registration;
  assert.strictEqual(other.body_digest, reg.body_digest);
  assert.notStrictEqual(ledger.slotKey(other.slot), ledger.slotKey(reg.slot));
});

test("a digest that does not match the registered bytes is refused", () => {
  assert.throws(
    () => ledger.createLedger(registration({ body_digest: "c".repeat(64) }), HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_REGISTRATION",
  );
});

test("a stale expected head is refused", () => {
  assert.throws(
    () => ledger.createLedger(registration(), NEXT),
    (error) => error.code === "ERR_CONTROL_LEDGER_HEAD_MISMATCH",
  );
});

test("the legal path is registered then call-possible then confirmed", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  assert.strictEqual(ledger.lastPhase(state), ledger.PHASES.REGISTERED);
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CONFIRMED, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  assert.strictEqual(ledger.lastPhase(state), ledger.PHASES.CONFIRMED);
  state = ledger.advance(state, phase({ phase: ledger.PHASES.COMPLETED }));
  assert.strictEqual(ledger.lastPhase(state), ledger.PHASES.COMPLETED);
});

test("a call cannot be confirmed without first declaring it possible", () => {
  const state = ledger.createLedger(registration(), HEAD);
  assert.throws(
    () => ledger.advance(state, phase({ phase: ledger.PHASES.CONFIRMED, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT })),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
});

test("an unknown call is never silently confirmed and never auto-aborted", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALLED_UNKNOWN, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  const view = ledger.recoveryView(state);
  assert.deepStrictEqual([...view.unknown_side_effects], [ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT]);
  assert.strictEqual(view.outcome, null);
  // An unknown call can only be confirmed or blocked. There is no automatic
  // abort phase, so a recovery cannot decide the call did not happen.
  assert.throws(
    () => ledger.advance(state, phase({ phase: ledger.PHASES.REGISTERED })),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
});

test("a blocked operation can never become completed", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase({ phase: ledger.PHASES.BLOCKED, reason: "owner fenced" }));
  assert.throws(
    () => ledger.advance(state, phase({ phase: ledger.PHASES.REGISTERED })),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  assert.throws(
    () => ledger.advance(state, phase({ phase: ledger.PHASES.COMPLETED })),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
});

test("a completed operation cannot be advanced again", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CONFIRMED, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.COMPLETED }));
  assert.throws(
    () => ledger.advance(state, phase({ phase: ledger.PHASES.BLOCKED })),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
});

test("an owner generation mismatch is refused", () => {
  const state = ledger.createLedger(registration(), HEAD);
  assert.throws(
    () => ledger.advance(state, phase({ owner: owner(2) })),
    (error) => error.code === "ERR_CONTROL_LEDGER_OWNER_MISMATCH",
  );
});

test("a fence mismatch is refused even with the same owner id", () => {
  const state = ledger.createLedger(registration(), HEAD);
  assert.throws(
    () => ledger.advance(state, phase({ owner: owner(1, 8) })),
    (error) => error.code === "ERR_CONTROL_LEDGER_OWNER_MISMATCH",
  );
});

test("a head that moved underneath the caller is refused", () => {
  const state = ledger.createLedger(registration(), HEAD);
  assert.throws(
    () => ledger.advance(state, phase({ expected_head: NEXT })),
    (error) => error.code === "ERR_CONTROL_LEDGER_HEAD_MISMATCH",
  );
});

test("a bootstrap registration may not declare an ordinary transaction side effect", () => {
  const state = ledger.createLedger(registration({ kind: "bootstrap" }), HEAD);
  const registered = ledger.advance(state, phase());
  assert.throws(
    () => ledger.advance(registered, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT })),
    (error) => error.code === "ERR_CONTROL_LEDGER_SIDE_EFFECT",
  );
});

test("a transaction registration may not declare a bootstrap side effect", () => {
  const state = ledger.createLedger(registration(), HEAD);
  const registered = ledger.advance(state, phase());
  assert.throws(
    () => ledger.advance(registered, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.BOOTSTRAP_DATABASE })),
    (error) => error.code === "ERR_CONTROL_LEDGER_SIDE_EFFECT",
  );
});

test("a confirmed commit cannot be settled as not-attempted", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CONFIRMED, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  assert.throws(
    () => ledger.settle(state, ledger.OUTCOMES.NOT_ATTEMPTED, HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
});

test("committed-unpublishable is a legal outcome of a confirmed call", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CONFIRMED, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.settle(state, ledger.OUTCOMES.COMMITTED_UNPUBLISHABLE, HEAD);
  assert.strictEqual(state.outcome, ledger.OUTCOMES.COMMITTED_UNPUBLISHABLE);
});

test("a confirmed outcome requires a confirmed phase", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALLED_UNKNOWN, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  assert.throws(
    () => ledger.settle(state, ledger.OUTCOMES.CONFIRMED, HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
});

test("an outcome can only be settled once", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase({ phase: ledger.PHASES.BLOCKED, reason: "blocked" }));
  state = ledger.settle(state, ledger.OUTCOMES.COMMIT_UNKNOWN, HEAD);
  assert.throws(
    () => ledger.settle(state, ledger.OUTCOMES.COMMIT_UNKNOWN, HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_ALREADY_SETTLED",
  );
});

test("a proxy input is rejected without invoking its traps", () => {
  const trap = () => { throw new Error("trap must not run"); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  assert.throws(
    () => ledger.createLedger(registration({ owner: proxy }), HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_OWNER",
  );
});

test("an exotic prototype is rejected", () => {
  class Weird {}
  assert.throws(
    () => ledger.createLedger(registration({ owner: new Weird() }), HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_OWNER",
  );
});

test("a shadowed accessor is rejected", () => {
  const value = { owner_id: "a", owner_generation: 1, fence: 1 };
  Object.defineProperty(value, "fence", { get() { throw new Error("getter must not run"); }, enumerable: true });
  assert.throws(
    () => ledger.createLedger(registration({ owner: value }), HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_OWNER",
  );
});

test("an unknown key is rejected", () => {
  assert.throws(
    () => ledger.createLedger(registration({ extra: 1 }), HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_REGISTRATION",
  );
});

test("a non-buffer original is rejected", () => {
  assert.throws(
    () => ledger.createLedger(registration({ original_bytes: "text" }), HEAD),
    (error) => error.code === "ERR_CONTROL_LEDGER_BYTES",
  );
});

test("an unknown side effect freezes the scope: no further effect may be declared", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_AUDIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALLED_UNKNOWN, side_effect: ledger.SIDE_EFFECTS.OPERATION_AUDIT }));
  // The publication proposal requires the business COMMIT to stay
  // `not-attempted` while an earlier barrier is unknown, so no further side
  // effect may be declared after an unknown.
  assert.throws(
    () => ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT })),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  const view = ledger.recoveryView(state);
  assert.deepStrictEqual([...view.unknown_side_effects], [ledger.SIDE_EFFECTS.OPERATION_AUDIT]);
  assert.deepStrictEqual([...view.pending_side_effects], []);
  assert.strictEqual(view.proves_business_commit, false);
});

test("the recovery view separates pending from confirmed effects", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_AUDIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CONFIRMED, side_effect: ledger.SIDE_EFFECTS.OPERATION_AUDIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT }));
  const view = ledger.recoveryView(state);
  assert.deepStrictEqual([...view.confirmed_side_effects], [ledger.SIDE_EFFECTS.OPERATION_AUDIT]);
  assert.deepStrictEqual([...view.pending_side_effects], [ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT]);
  assert.deepStrictEqual([...view.unknown_side_effects], []);
});

test("a later confirmation cannot hide an earlier unknown for the same effect", () => {
  let state = ledger.createLedger(registration(), HEAD);
  state = ledger.advance(state, phase());
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALL_POSSIBLE, side_effect: ledger.SIDE_EFFECTS.OPERATION_AUDIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CALLED_UNKNOWN, side_effect: ledger.SIDE_EFFECTS.OPERATION_AUDIT }));
  state = ledger.advance(state, phase({ phase: ledger.PHASES.CONFIRMED, side_effect: ledger.SIDE_EFFECTS.OPERATION_AUDIT }));
  const view = ledger.recoveryView(state);
  assert.deepStrictEqual([...view.unknown_side_effects], [ledger.SIDE_EFFECTS.OPERATION_AUDIT]);
  assert.deepStrictEqual([...view.confirmed_side_effects], []);
});
