"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SyntheticState, SyntheticStateError, FLAGS, LIMITS, sqliteFixtureKernel } = require("../../lib/coordination/permit-phase-a-synthetic-state");
const A = "a".repeat(64), B = "b".repeat(64);
function configuration(lane = "consumption-fixture") {
  return { mode: "purely-synthetic", lane, authorityId: "synthetic-authority", targetId: "synthetic-target",
    storeGeneration: "store-1", runGeneration: "run-7", ownerIncarnation: "owner-3", ownerVersion: 1, grantId: "grant-1", grantVersion: 1, lifecycleVersion: 11 };
}
function machine(lane) { return new SyntheticState(configuration(lane)); }
function item(m, id = "attempt-1") { return m.snapshot().attempts.find(a => a.request.attemptId === id); }
function version(m, id) { return item(m, id).version; }
function admission(m, overrides = {}) {
  const registration = { ...configuration("registration-only"), ...m.snapshot().control };
  return { attemptId: "attempt-1", kind: "consume", checkpoint: m.snapshot().checkpoint,
    principal: "synthetic-principal", requestDigest: A, runGeneration: registration.runGeneration,
    ownerIncarnation: registration.ownerIncarnation, ownerVersion: registration.ownerVersion,
    grantId: registration.grantId, grantVersion: registration.grantVersion, lifecycleVersion: registration.lifecycleVersion,
    monotonicDeadline: 100, wallClockDeadline: 1100, permitId: "permit-1", fingerprint: A, ...overrides };
}
function admit(m, overrides = {}) { const r = admission(m, overrides); m.admit(r); return r.attemptId; }
function reserve(m, id = "attempt-1", tokenId = "token-1") { m.reserve({ attemptId: id, version: version(m, id), tokenId }); }
function delta(sequence = 1, revoked = [], clockPoisoned = false) { return { sequence, previous: sequence - 1, revoked, clockPoisoned }; }
function clock(monotonicNow, wallClockNow = 1000 + monotonicNow) { return { monotonicNow, wallClockNow }; }
function enter(m, id = "attempt-1", observation = delta(), now = 1) {
  return m.enter({ attemptId: id, version: version(m, id), clocks: typeof now === "number" ? clock(now) : now, observation });
}
function cancel(m, id = "attempt-1") { m.cancel({ attemptId: id, version: version(m, id) }); }
function registration() {
  const m = machine("registration-only"); admit(m, { kind: "register", permitId: null, fingerprint: null }); reserve(m); return m;
}
function refuses(fn, code) {
  assert.throws(fn, e => e instanceof SyntheticStateError && (!code || e.code === "ERR_SYNTHETIC_" + code));
}
function unchanged(m, fn, code) { const before = m.exportImage(); refuses(fn, code); assert.equal(m.exportImage(), before); }

test("fixture facts codec is distinct from command images and uses the same pure transition", () => {
  const k = sqliteFixtureKernel, m = machine(), body = k.initial(configuration());
  const r = admission(m); const next = k.transition(body, { type: "admit", data: r });
  m.admit(r); assert.deepEqual(k.inspect(next), { ...m.snapshot(), retainedEvents: 0 });
  assert.equal(k.inspect(body).attempts.length, 0); // input body was not mutated
  assert.throws(() => k.inspect(m.exportImage()));
  const fact = JSON.parse(next); fact.state.events = [];
  assert.throws(() => k.inspect(JSON.stringify(fact)));
  const version = JSON.parse(next); version.semanticFormat = 2;
  refuses(() => k.inspect(JSON.stringify(version)), "IMAGE_FORMAT");
  const duplicate = JSON.parse(next); duplicate.state.attempts.push(duplicate.state.attempts[0]);
  refuses(() => k.inspect(JSON.stringify(duplicate)), "FACTS");
  refuses(() => k.inspect(next + " "), "FACTS");
  let hooks = 0; const proxy = new Proxy({}, { ownKeys() { hooks++; throw Error("must not run"); } });
  refuses(() => k.normalizeCommand(proxy), "INPUT"); assert.equal(hooks, 0);
  const frozen = k.normalizeCommand({ type: "admit", data: r });
  assert.throws(() => { frozen.data.checkpoint.digest = B; }, TypeError);
});

test("fixture stale-version reducer fixes business denial independently of legal chain and wall poison", () => {
  const k = sqliteFixtureKernel, m = machine(), r = admission(m);
  let body = k.initial(configuration());
  body = k.transition(body, { type: "admit", data: r });
  body = k.transition(body, { type: "reserve", data: { attemptId: r.attemptId, version: 1, tokenId: "token-1" } });
  const c = { type: "enter", data: { attemptId: r.attemptId, version: 2, clocks: clock(1), observation: delta(1, [B]) } };
  const denied = k.inspect(k.safetyOnly(body, c, "ROW_VERSION_CONFLICT"));
  assert.equal(denied.attempts[0].commitOutcome.baseMatch, true); assert.equal(denied.attempts[0].status, "safety-only");
  assert.equal(denied.attempts[0].reason, "ROW_VERSION_CONFLICT"); assert.equal(denied.consumed.length, 0);
  assert.deepEqual(denied.revoked, [B]); assert.equal(k.inspect(body).revocationSequence, 0);
  refuses(() => k.safetyOnly(body, c, "arbitrary"), "INPUT");
  const entered = k.transition(body, c);
  const bad = { type: "commit", data: { attemptId: r.attemptId, clocks: clock(2, 1000) } };
  const poisoned = k.inspect(k.safetyOnly(entered, bad, "CHECKPOINT_CONFLICT"));
  assert.equal(poisoned.clockPoisoned, true); assert.deepEqual(poisoned.revoked, [B]);
  assert.equal(poisoned.attempts[0].reason, "WALL_CLOCK_ROLLBACK");
});

test("explicit purely synthetic mode, no authority, activation, signing, execution or provider API", () => {
  refuses(() => new SyntheticState(), "INPUT");
  refuses(() => new SyntheticState({ ...configuration(), mode: "production" }), "INPUT");
  refuses(() => new SyntheticState({ ...configuration(), provider: () => {} }), "INPUT");
  const m = machine();
  assert.deepEqual(FLAGS, { mode: "purely-synthetic", authority: false, executionAuthorized: false,
    osIdentity: false, durable: false, crossMachine: false });
  assert.equal(m.activate, undefined); assert.equal(m.sign, undefined); assert.equal(m.dispatch, undefined);
  assert.equal(m.snapshot().registrationActive, false); assert.equal(m.snapshot().publishable, false);
  assert.equal(m.snapshot().dispatchAllowed, false);
});

test("registration with a valid-looking token can only become pending; reservation remains held", () => {
  const m = registration(), handle = enter(m, "attempt-1", null); m.commit(handle, clock(2));
  const a = item(m); assert.equal(a.status, "registration-pending");
  assert.equal(a.clientOutcome, "pending-registration"); assert.equal(a.reservation.held, true);
  assert.equal(a.commitOutcome.checkpoint.revision, 2); assert.equal(m.snapshot().registrationActive, false);
  unchanged(m, () => admit(m, { attemptId: "consume", kind: "consume" }), "LANE");
});

for (const reason of ["owner-dead", "owner-restarted", "token-expired", "grant-revoked", "lifecycle-changed"]) {
  test(`invalidation ${reason} before boundary prevents entry; after boundary cannot activate`, () => {
    const m = registration(); m.invalidate({ tokenId: "token-1", reason });
    assert.equal(item(m).status, "invalidated"); assert.equal(item(m).reservation.held, true);
    unchanged(m, () => enter(m, "attempt-1", null), "STATE");
    const second = registration(), handle = enter(second, "attempt-1", null);
    second.invalidate({ tokenId: "token-1", reason }); second.commit(handle, clock(2));
    assert.equal(item(second).status, "rejected"); assert.equal(item(second).clientOutcome, "unknown");
    assert.equal(item(second).commitOutcome.status, "rejected"); assert.equal(second.snapshot().registrationActive, false);
  });
}

test("invalidation delivered after pending preserves the commit fact; duplicate evidence is inert", () => {
  const m = registration(), h = enter(m, "attempt-1", null); m.commit(h, clock(2));
  const committed = item(m).commitOutcome;
  m.invalidate({ tokenId: "token-1", reason: "owner-dead" });
  assert.equal(item(m).status, "registration-pending"); assert.deepEqual(item(m).commitOutcome, committed);
  assert.equal(item(m).clientOutcome, "unknown"); assert.equal(item(m).reservation.held, true);
  const v = version(m); m.invalidate({ tokenId: "token-1", reason: "owner-restarted" }); assert.equal(version(m), v);
});

test("pending registration cancellation retains the decision and excludes another reservation after recovery", () => {
  const m = registration(); m.commit(enter(m, "attempt-1", null), clock(2));
  const outcome = item(m).commitOutcome; cancel(m);
  assert.equal(item(m).status, "registration-pending"); assert.equal(item(m).clientOutcome, "unknown");
  assert.deepEqual(item(m).commitOutcome, outcome); assert.equal(item(m).reservation.held, true);
  const restored = SyntheticState.restore(m.exportImage());
  unchanged(restored, () => admit(restored, { attemptId: "old-owner", kind: "register", permitId: null, fingerprint: null }), "CONTROL_REVOKED");
  restored.advanceControl({ axis: "owner", expectedVersion: restored.snapshot().control.ownerVersion, identity: "owner-4" });
  admit(restored, { attemptId: "attempt-2", kind: "register", permitId: null, fingerprint: null });
  unchanged(restored, () => reserve(restored, "attempt-2", "token-2"), "RESERVATION");
  assert.deepEqual(item(restored).commitOutcome, outcome); assert.equal(restored.snapshot().registrationActive, false);
});

test("reservation serializes two admitted attempts; only proven pre-boundary cancellation releases the model slot", () => {
  const m = machine(); admit(m); admit(m, { attemptId: "attempt-2", permitId: "permit-2" }); reserve(m);
  unchanged(m, () => reserve(m, "attempt-2", "token-2"), "RESERVATION"); cancel(m);
  reserve(m, "attempt-2", "token-2"); assert.equal(item(m, "attempt-2").reservation.held, true);
  assert.equal(item(m).reservation.tombstone, true); assert.equal(m.snapshot().authority, false);
});

test("full C0 digest match precedes own legal next safety increment and consumption", () => {
  const m = machine(); admit(m); reserve(m); const c0 = m.snapshot().checkpoint;
  m.commit(enter(m, "attempt-1", delta(1, [B])), clock(2));
  assert.equal(item(m).status, "consumed-synthetic"); assert.equal(item(m).commitOutcome.baseMatch, true);
  assert.equal(m.snapshot().checkpoint.revision, c0.revision + 1);
  assert.equal(m.snapshot().revocationSequence, 1); assert.deepEqual(m.snapshot().revoked, [B]);
  assert.equal(m.snapshot().consumed.length, 1); assert.equal(m.snapshot().executionAuthorized, false);
});

test("same revision different digest refuses business yet commits applicable safety facts", () => {
  const m = machine(), cp = { ...m.snapshot().checkpoint, digest: B }; admit(m, { checkpoint: cp }); reserve(m);
  m.commit(enter(m, "attempt-1", delta(1, [B])), clock(2));
  assert.equal(item(m).commitOutcome.baseMatch, false); assert.equal(item(m).status, "safety-only");
  assert.equal(item(m).reason, "CHECKPOINT_CONFLICT"); assert.equal(m.snapshot().consumed.length, 0);
  assert.deepEqual(m.snapshot().revoked, [B]);
  const restored = SyntheticState.restore(m.exportImage()); assert.deepEqual(restored.snapshot().revoked, [B]);
  assert.deepEqual(item(restored).commitOutcome, item(m).commitOutcome);
});

test("original stale C0 after another commit does not lose next safety increment", () => {
  const m = machine(), c0 = m.snapshot().checkpoint; admit(m); reserve(m);
  m.commit(enter(m, "attempt-1", delta(1, [B])), clock(2));
  admit(m, { attemptId: "attempt-2", permitId: "permit-2", checkpoint: c0 }); reserve(m, "attempt-2", "token-2");
  m.commit(enter(m, "attempt-2", delta(2, [A, B]), 3), clock(4));
  assert.equal(item(m, "attempt-2").status, "safety-only"); assert.equal(m.snapshot().revocationSequence, 2);
  assert.equal(m.snapshot().consumed.length, 1); assert.deepEqual(m.snapshot().revoked, [A, B]);
});

for (const [name, update, reason] of [["revoked signer", delta(1, [A]), "REVOKED"], ["clock poison", delta(1, [], true), "CLOCK_POISONED"]]) {
  test(`${name} is a committed safety-only result, not rollback`, () => {
    const m = machine(); admit(m); reserve(m); m.commit(enter(m, "attempt-1", update), clock(2));
    assert.equal(item(m).status, "safety-only"); assert.equal(item(m).reason, reason);
    assert.equal(m.snapshot().consumed.length, 0); assert.equal(m.snapshot().checkpoint.revision, 2);
  });
}

test("gap/duplicate/nonmonotonic safety facts reject atomically without fabricated head", () => {
  for (const o of [{ ...delta(2), previous: 0 }, { ...delta(), sequence: 2 }, { ...delta(), previous: 1 }]) {
    const m = machine(); admit(m); reserve(m); const h = enter(m, "attempt-1", o);
    unchanged(m, () => m.commit(h, clock(2)), "CHAIN"); assert.equal(m.snapshot().revocationSequence, 0);
  }
  const m = machine(); admit(m); reserve(m); m.commit(enter(m, "attempt-1", delta(1, [B])), clock(2));
  admit(m, { attemptId: "attempt-2", permitId: "permit-2" }); reserve(m, "attempt-2", "token-2");
  const h = enter(m, "attempt-2", delta(2, []), 3); unchanged(m, () => m.commit(h, clock(4)), "CHAIN");
});

test("accepted poison and revocations survive replay and block renewed admission", () => {
  const m = machine(); admit(m); reserve(m); m.commit(enter(m, "attempt-1", delta(1, [B], true)), clock(2));
  const restored = SyntheticState.restore(m.exportImage());
  assert.equal(restored.snapshot().clockPoisoned, true); assert.deepEqual(restored.snapshot().revoked, [B]);
  unchanged(restored, () => admit(restored, { attemptId: "attempt-2", permitId: "permit-2" }), "CLOCK_POISONED");
  restored.advanceControl({ axis: "owner", expectedVersion: restored.snapshot().control.ownerVersion, identity: "owner-4" });
  unchanged(restored, () => admit(restored, { attemptId: "attempt-2", permitId: "permit-2" }), "CLOCK_POISONED");
  assert.equal(restored.snapshot().clockPoisoned, true); assert.equal(restored.snapshot().consumed.length, 0);
});

test("a fresh checkpoint cannot consume an already consumed synthetic permit again", () => {
  const m = machine(); admit(m); reserve(m); m.commit(enter(m), clock(2));
  admit(m, { attemptId: "attempt-2", requestDigest: B }); reserve(m, "attempt-2", "token-2");
  m.commit(enter(m, "attempt-2", delta(2, [B]), 3), clock(4));
  assert.equal(item(m, "attempt-2").reason, "PERMIT_REPLAY"); assert.equal(item(m, "attempt-2").status, "safety-only");
  assert.equal(m.snapshot().consumed.length, 1); assert.equal(m.snapshot().consumed[0].requestDigest, A);
  assert.deepEqual(m.snapshot().revoked, [B]);
});

test("cancel before entry wins CAS, tombstones reservation and rejects late observation", async () => {
  const m = machine(); admit(m); reserve(m); const stale = version(m);
  const late = Promise.resolve().then(() => m.enter({ attemptId: "attempt-1", version: stale, clocks: clock(1), observation: delta() }));
  cancel(m); await assert.rejects(late, { code: "ERR_SYNTHETIC_CAS" });
  assert.equal(item(m).status, "cancelled"); assert.equal(item(m).reservation.tombstone, true);
  unchanged(m, () => admit(m), "REPLAY");
  admit(m, { attemptId: "attempt-2" }); unchanged(m, () => reserve(m, "attempt-2", "token-1"), "REPLAY");
});

test("cancel after commit boundary cannot promise rollback, late commit does not revive client", () => {
  const m = machine(); admit(m); reserve(m); const h = enter(m); cancel(m);
  assert.equal(item(m).clientOutcome, "unknown"); m.commit(h, clock(2));
  assert.equal(item(m).status, "consumed-synthetic"); assert.equal(item(m).clientOutcome, "unknown");
  assert.equal(item(m).reservation.held, true); unchanged(m, () => m.commit(h, clock(3)), "HANDLE");
});

test("commit before cancel keeps the immutable committed outcome", () => {
  const m = machine(); admit(m); reserve(m); m.commit(enter(m), clock(2)); const outcome = item(m).commitOutcome;
  cancel(m); assert.deepEqual(item(m).commitOutcome, outcome);
  assert.equal(item(m).clientOutcome, "synthetic-committed"); assert.equal(m.snapshot().consumed.length, 1);
});

test("token invalidation between entry and consume commits safety only, with reservation retained", () => {
  const m = machine(); admit(m); reserve(m); const h = enter(m, "attempt-1", delta(1, [B]));
  m.invalidate({ tokenId: "token-1", reason: "grant-revoked" }); m.commit(h, clock(2));
  assert.equal(item(m).reason, "TOKEN_INVALID"); assert.equal(item(m).status, "safety-only");
  assert.equal(item(m).clientOutcome, "unknown"); assert.equal(item(m).reservation.held, true);
  assert.equal(m.snapshot().consumed.length, 0); assert.deepEqual(m.snapshot().revoked, [B]);
});

test("stale attempt versions, wrong/forged handles and another machine cannot mutate state", () => {
  const m = machine(); admit(m); reserve(m);
  unchanged(m, () => m.cancel({ attemptId: "attempt-1", version: 1 }), "CAS");
  const h = enter(m), other = machine(); unchanged(other, () => other.commit(h, clock(2)), "HANDLE");
  unchanged(m, () => m.commit({}, clock(2)), "HANDLE"); m.commit(h, clock(2));
  unchanged(m, () => enter(m, "attempt-1", delta(), 3), "STATE");
});

test("monotonic deadline and monotonic rollback have distinct terminal outcomes", () => {
  const m = machine(); admit(m); reserve(m); assert.equal(enter(m, "attempt-1", delta(), 100), null);
  assert.equal(item(m).status, "invalidated"); assert.equal(item(m).reservation.held, true);
  const b = machine(); admit(b); reserve(b); const h = enter(b, "attempt-1", delta(), 10);
  b.commit(h, clock(9, 1011));
  assert.equal(item(b).status, "safety-only"); assert.equal(item(b).reason, "MONOTONIC_ROLLBACK");
  assert.equal(b.snapshot().clockPoisoned, false); assert.equal(b.snapshot().consumed.length, 0);
  unchanged(b, () => b.commit(h, clock(12)), "HANDLE");
  const c = machine(); admit(c); reserve(c); c.commit(enter(c), clock(100));
  assert.equal(item(c).reason, "MONOTONIC_DEADLINE"); assert.equal(c.snapshot().revocationSequence, 1);
});

test("in-memory recovery at admitted/reserved/commit-possible cuts retains unknown, no old handle", () => {
  for (const cut of ["admitted", "reserved", "commit-possible"]) {
    const m = machine(); admit(m); let h;
    if (cut !== "admitted") reserve(m);
    if (cut === "commit-possible") h = enter(m);
    const restored = SyntheticState.restore(m.exportImage());
    assert.equal(item(restored).status, "unknown"); assert.equal(item(restored).clientOutcome, "unknown");
    assert.equal(restored.snapshot().consumed.length, 0); assert.equal(restored.snapshot().revocationSequence, 0);
    assert.equal(restored.snapshot().durable, false); unchanged(restored, () => enter(restored), "STATE");
    if (h) unchanged(restored, () => restored.commit(h, clock(2)), "HANDLE");
    if (cut !== "admitted") assert.equal(item(restored).reservation.held, true);
  }
});

test("restored pending registration stays pending/unknown and retains both invalidation and reservation", () => {
  const m = registration(), h = enter(m, "attempt-1", null); m.commit(h, clock(2));
  m.invalidate({ tokenId: "token-1", reason: "owner-dead" });
  const restored = SyntheticState.restore(m.exportImage());
  assert.equal(item(restored).status, "registration-pending"); assert.equal(item(restored).invalidation, "owner-dead");
  assert.equal(item(restored).reservation.held, true); assert.equal(restored.snapshot().registrationActive, false);
  unchanged(restored, () => reserve(restored), "STATE");
});

test("recovery after cancel+late commit preserves real model commit and unknown client result", () => {
  const m = machine(); admit(m); reserve(m); const h = enter(m); cancel(m); m.commit(h, clock(2));
  const restored = SyntheticState.restore(m.exportImage());
  assert.equal(restored.snapshot().consumed.length, 1); assert.equal(item(restored).clientOutcome, "unknown");
  assert.deepEqual(item(restored).commitOutcome, item(m).commitOutcome);
});

test("images are explicitly unauthenticated and cannot detect rollback of a valid prefix", () => {
  const m = machine(); const old = m.exportImage(); admit(m); reserve(m); m.commit(enter(m), clock(2));
  const restoredOldPrefix = SyntheticState.restore(old);
  assert.equal(restoredOldPrefix.snapshot().consumed.length, 0);
  assert.equal(restoredOldPrefix.snapshot().authority, false); assert.equal(restoredOldPrefix.snapshot().crossMachine, false);
});

test("strict schemas, inert objects, bounds and incomplete/corrupt images reject without invoking hooks", () => {
  const m = machine(); let hooks = 0;
  const accessor = { ...admission(m) }; Object.defineProperty(accessor, "principal", { enumerable: true, get() { hooks++; return "bad"; } });
  const proxy = new Proxy(admission(m), { ownKeys() { hooks++; throw Error("must not run"); } });
  for (const bad of [null, {}, [], accessor, proxy, Object.create(admission(m)), { ...admission(m), extra: true },
    { ...admission(m), monotonicDeadline: NaN }, { ...admission(m), lifecycleVersion: -0 },
    { ...admission(m), requestDigest: "X".repeat(64) }, { ...admission(m), then() { hooks++; } }]) unchanged(m, () => m.admit(bad), "INPUT");
  assert.equal(hooks, 0);
  for (const patch of [{ storeGeneration: "other" }, { authorityId: "other" }, { targetId: "other" }]) {
    unchanged(m, () => admit(m, { checkpoint: { ...m.snapshot().checkpoint, ...patch } }), "BINDING");
  }
  for (const patch of [{ runGeneration: "other" }, { ownerIncarnation: "other" }, { lifecycleVersion: 12 }]) unchanged(m, () => admit(m, patch), "BINDING");
  admit(m); reserve(m);
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  unchanged(m, () => enter(m, "attempt-1", delta(1, revoked.proxy)), "INPUT");
  for (const bad of [[B, A], [A, A], Array(1), Array(33).fill(A)]) unchanged(m, () => enter(m, "attempt-1", delta(1, bad)), "INPUT");
  unchanged(m, () => enter(m, "attempt-1", null), "INPUT");
  for (const bad of ["", "{", "{}", " "+m.exportImage(), m.exportImage().replace('"format":3', '"format":4'),
    m.exportImage().replace('"format":3', '"format":3,"format":3'), "x".repeat(LIMITS.imageBytes + 1)]) refuses(() => SyntheticState.restore(bad));
});

test("input/output copies do not alias internal observations and every log is lifetime bounded", () => {
  const m = machine(), r = admission(m); r.checkpoint = { ...r.checkpoint };
  m.admit(r); r.checkpoint.digest = B; reserve(m);
  const o = delta(1, [B]), h = enter(m, "attempt-1", o); o.revoked[0] = A; m.commit(h, clock(2));
  assert.equal(item(m).status, "consumed-synthetic"); assert.deepEqual(m.snapshot().revoked, [B]);
  assert.throws(() => { m.snapshot().attempts[0].status = "active"; }, TypeError);
  const empty = machine(); for (let i = 0; i < LIMITS.attempts; i++) admit(empty, { attemptId: `attempt-${i}` });
  unchanged(empty, () => admit(empty, { attemptId: "overflow" }), "LIMIT");
  const limited = machine(); admit(limited); reserve(limited); limited.invalidate({ tokenId: "token-1", reason: "owner-dead" });
  while (limited.snapshot().retainedEvents < LIMITS.events) limited.invalidate({ tokenId: "token-1", reason: "owner-dead" });
  unchanged(limited, () => limited.invalidate({ tokenId: "token-1", reason: "owner-dead" }), "LIMIT");
  refuses(() => SyntheticState.restore(limited.exportImage()), "INPUT"); // no spare recovery record, never drop history
});

test("wall deadline expires independently while monotonic deadline remains valid", () => {
  for (const boundary of ["enter", "commit"]) {
    const m = machine(); admit(m); reserve(m);
    if (boundary === "enter") assert.equal(enter(m, "attempt-1", delta(), clock(1, 1100)), null);
    else m.commit(enter(m), clock(2, 1100));
    assert.equal(item(m).reason, "WALL_CLOCK_DEADLINE");
    assert.equal(m.snapshot().consumed.length, 0); assert.equal(m.snapshot().clockPoisoned, false);
  }
});

test("wall rollback commits poison even with invalid staged chain and cannot reuse handle", () => {
  const m = machine(); admit(m); reserve(m);
  const h = enter(m, "attempt-1", delta(5), clock(10, 1050));
  const revision = m.snapshot().checkpoint.revision;
  m.commit(h, clock(11, 1049));
  assert.equal(item(m).reason, "WALL_CLOCK_ROLLBACK");
  assert.equal(item(m).commitOutcome.baseMatch, true);
  assert.equal(item(m).staged, null); assert.equal(item(m).reservation.held, true);
  assert.equal(m.snapshot().clockPoisoned, true);
  assert.equal(m.snapshot().checkpoint.revision, revision + 1);
  assert.equal(m.snapshot().revocationSequence, 0); assert.equal(m.snapshot().consumed.length, 0);
  unchanged(m, () => m.commit(h, clock(12, 1051)), "HANDLE");
  const restored = SyntheticState.restore(m.exportImage());
  assert.equal(restored.snapshot().clockPoisoned, true);
  assert.equal(restored.snapshot().clocks.wallClockHighWater, 1050);
  assert.equal(restored.snapshot().clocks.monotonicNow, 0);
  assert.deepEqual(item(restored).commitOutcome, item(m).commitOutcome);
  unchanged(restored, () => restored.commit(h, clock(12, 1051)), "HANDLE");
  unchanged(restored, () => admit(restored, { attemptId: "after-recovery" }), "CLOCK_POISONED");
});

test("wall rollback at entry latches replayable poison; monotonic rollback only invalidates that observation", () => {
  for (const axis of ["wall", "monotonic"]) {
    const m = machine(); admit(m); reserve(m); m.commit(enter(m, "attempt-1", delta(), clock(10, 1050)), clock(11, 1051));
    admit(m, { attemptId: "attempt-2", permitId: "permit-2" }); reserve(m, "attempt-2", "token-2");
    const sample = axis === "wall" ? clock(12, 1050) : clock(10, 1052);
    assert.equal(enter(m, "attempt-2", delta(2), sample), null);
    assert.equal(item(m, "attempt-2").reason, axis === "wall" ? "WALL_CLOCK_ROLLBACK" : "MONOTONIC_ROLLBACK");
    assert.equal(m.snapshot().clockPoisoned, axis === "wall");
    const restored = SyntheticState.restore(m.exportImage());
    assert.equal(restored.snapshot().clockPoisoned, axis === "wall");
    assert.equal(item(restored, "attempt-2").status, "invalidated");
  }
});

for (const axis of ["owner", "grant", "lifecycle"]) for (const operation of ["advanceControl", "revokeControl"]) {
  test(`${operation} ${axis} invalidates old observations and rejects old binding after recovery`, () => {
    const m = machine(); const old = admission(m); admit(m); reserve(m);
    const staleVersion = version(m);
    const expectedVersion = m.snapshot().control[axis + "Version"];
    const command = { axis, expectedVersion };
    if (operation === "advanceControl") command.identity = axis === "lifecycle" ? null : axis + "-next";
    m[operation](command);
    unchanged(m, () => m[operation](command), "CAS");
    unchanged(m, () => m.enter({ attemptId: "attempt-1", version: staleVersion, clocks: clock(1), observation: delta() }), "CAS");
    assert.equal(item(m).status, "invalidated"); assert.equal(item(m).reservation.held, true);
    const stale = { ...old, attemptId: "old-new-attempt", checkpoint: m.snapshot().checkpoint };
    unchanged(m, () => m.admit(stale), operation === "revokeControl" ? "CONTROL_REVOKED" : "BINDING");
    const restored = SyntheticState.restore(m.exportImage());
    unchanged(restored, () => restored.admit({ ...stale, checkpoint: restored.snapshot().checkpoint }), "CONTROL_REVOKED");
    restored.advanceControl({ axis: "owner", expectedVersion: restored.snapshot().control.ownerVersion, identity: "recovered-owner" });
    unchanged(restored, () => restored.admit({ ...stale, checkpoint: restored.snapshot().checkpoint }), operation === "revokeControl" && axis !== "owner" ? "CONTROL_REVOKED" : "BINDING");
  });
}

test("global change after commit boundary preserves applicable safety facts but refuses business", () => {
  for (const axis of ["owner", "grant", "lifecycle"]) {
    const m = machine(); admit(m); reserve(m); const h = enter(m, "attempt-1", delta(1, [B]));
    m.revokeControl({ axis, expectedVersion: m.snapshot().control[axis + "Version"] });
    m.commit(h, clock(2));
    assert.equal(item(m).status, "safety-only"); assert.equal(item(m).commitOutcome.baseMatch, false);
    assert.equal(item(m).clientOutcome, "unknown"); assert.equal(item(m).reservation.held, true);
    assert.equal(m.snapshot().consumed.length, 0); assert.deepEqual(m.snapshot().revoked, [B]);
    assert.equal(SyntheticState.restore(m.exportImage()).snapshot().control[axis + "Revoked"], true);
  }
});

test("recovery freezes owner even on empty image; fresh controlled binding is required", () => {
  const restored = SyntheticState.restore(machine().exportImage());
  unchanged(restored, () => admit(restored), "CONTROL_REVOKED");
  restored.advanceControl({ axis: "owner", expectedVersion: restored.snapshot().control.ownerVersion, identity: "owner-4" });
  unchanged(restored, () => admit(restored, { ownerIncarnation: "owner-3", ownerVersion: 1 }), "BINDING");
  restored.revokeControl({ axis: "grant", expectedVersion: 1 });
  unchanged(restored, () => admit(restored), "CONTROL_REVOKED");
  restored.advanceControl({ axis: "grant", expectedVersion: 2, identity: "grant-2" });
  unchanged(restored, () => restored.advanceControl({ axis: "grant", expectedVersion: 3, identity: "grant-1" }), "REPLAY");
  admit(restored); reserve(restored); restored.commit(enter(restored), clock(2));
  assert.equal(item(restored).status, "consumed-synthetic"); assert.equal(restored.snapshot().durable, false);
});

test("legacy images and ambiguous numeric clock API are refused", () => {
  const m = machine(); admit(m); reserve(m); const h = enter(m);
  unchanged(m, () => m.commit(h, 2), "INPUT");
  const image = JSON.parse(m.exportImage());
  for (const format of [1, 2]) refuses(() => SyntheticState.restore(JSON.stringify({ ...image, format })), "IMAGE_FORMAT");
});

test("image semantic format 3 rejects old command logs before applying the changed safety/clock semantics", () => {
  const m = machine(); admit(m); reserve(m);
  const h = enter(m, "attempt-1", delta(1, [B]), clock(10, 1050));
  m.commit(h, clock(9, 1049));
  const image = JSON.parse(m.exportImage());
  assert.equal(image.format, 3);
  // v2 had this command layout too, but different replay effects when a legal
  // next revocation coincided with a failed clock check. Never reinterpret it.
  const legacy = { ...image, format: 2 };
  refuses(() => SyntheticState.restore(JSON.stringify(legacy)), "IMAGE_FORMAT");
  // The semantic version gate precedes command validation and replay.
  legacy.events = [{ type: "must-not-be-replayed", data: {} }];
  refuses(() => SyntheticState.restore(JSON.stringify(legacy)), "IMAGE_FORMAT");
  assert.deepEqual(m.snapshot().revoked, [B]); assert.equal(m.snapshot().revocationSequence, 1);
});

test("image semantic format 3 replays accepted revocation plus clock poison and terminal result", () => {
  const m = machine(); admit(m); reserve(m);
  const h = enter(m, "attempt-1", delta(1, [B]), clock(10, 1050));
  m.commit(h, clock(9, 1049));
  const image = m.exportImage(); assert.equal(JSON.parse(image).format, 3);
  const restored = SyntheticState.restore(image);
  assert.equal(JSON.parse(restored.exportImage()).format, 3);
  assert.deepEqual(restored.snapshot().revoked, [B]); assert.equal(restored.snapshot().revocationSequence, 1);
  assert.equal(restored.snapshot().clockPoisoned, true); assert.equal(restored.snapshot().consumed.length, 0);
  assert.equal(item(restored).status, "safety-only"); assert.deepEqual(item(restored).commitOutcome, item(m).commitOutcome);
  assert.equal(item(restored).reservation.held, true);
  unchanged(restored, () => restored.commit(h, clock(11, 1051)), "HANDLE");
});

test("registration wall rollback rejects pending business and latches safety poison", () => {
  const m = registration(); const h = enter(m, "attempt-1", null, clock(1, 1050));
  m.commit(h, clock(2, 1049));
  assert.equal(item(m).status, "rejected"); assert.equal(item(m).reason, "WALL_CLOCK_ROLLBACK");
  assert.equal(m.snapshot().clockPoisoned, true); assert.equal(m.snapshot().registrationActive, false);
  unchanged(m, () => m.commit(h, clock(3, 1051)), "HANDLE");
  assert.equal(SyntheticState.restore(m.exportImage()).snapshot().clockPoisoned, true);
});

test("simultaneous clock regressions retain wall poison, consumed history and control revocation", () => {
  const m = machine(); admit(m); reserve(m); m.commit(enter(m), clock(10, 1050));
  const committed = item(m).commitOutcome;
  admit(m, { attemptId: "attempt-2", permitId: "permit-2" }); reserve(m, "attempt-2", "token-2");
  const h = enter(m, "attempt-2", delta(2), clock(11, 1051));
  m.revokeControl({ axis: "grant", expectedVersion: 1 });
  m.commit(h, clock(9, 1049));
  assert.equal(item(m, "attempt-2").reason, "WALL_CLOCK_ROLLBACK");
  assert.equal(m.snapshot().clockPoisoned, true); assert.equal(m.snapshot().control.grantRevoked, true);
  assert.equal(m.snapshot().consumed.length, 1); assert.deepEqual(item(m).commitOutcome, committed);
  const restored = SyntheticState.restore(m.exportImage());
  assert.equal(restored.snapshot().control.grantRevoked, true); assert.equal(restored.snapshot().consumed.length, 1);
});

for (const boundary of ["enter", "commit"]) for (const failure of ["monotonic", "wall", "monotonic-deadline", "wall-deadline"]) {
  for (const chain of ["legal", "gap", "duplicate", "drops-revocation"]) {
    test(`${boundary} ${failure} with ${chain} chain atomically replays only valid safety facts`, () => {
      const m = machine(); admit(m); reserve(m);
      m.commit(enter(m, "attempt-1", delta(1, [B]), clock(10, 1050)), clock(11, 1051));
      const history = item(m).commitOutcome;
      admit(m, { attemptId: "attempt-2", permitId: "permit-2" }); reserve(m, "attempt-2", "token-2");
      const o = chain === "legal" ? delta(2, [A, B]) : chain === "gap" ? delta(3, [A, B], true) :
        chain === "duplicate" ? delta(1, [A, B], true) : delta(2, [A], true);
      const h = boundary === "commit" ? enter(m, "attempt-2", o, clock(12, 1052)) : null;
      const before = m.snapshot();
      const sample = failure === "monotonic" ? clock(9, 1053) : failure === "wall" ? clock(13, 1049) :
        failure === "monotonic-deadline" ? clock(100, 1053) : clock(13, 1100);
      if (boundary === "commit") m.commit(h, sample);
      else assert.equal(enter(m, "attempt-2", o, sample), null);
      const after = m.snapshot(); const a = item(m, "attempt-2");
      assert.equal(a.reason, { monotonic: "MONOTONIC_ROLLBACK", wall: "WALL_CLOCK_ROLLBACK",
        "monotonic-deadline": "MONOTONIC_DEADLINE", "wall-deadline": "WALL_CLOCK_DEADLINE" }[failure]);
      assert.equal(a.status, boundary === "commit" ? "safety-only" : "invalidated");
      assert.equal(a.reservation.held, true); assert.equal(a.staged, null);
      assert.equal(after.revocationSequence, chain === "legal" ? 2 : 1);
      assert.deepEqual(after.revoked, chain === "legal" ? [A, B] : [B]);
      assert.equal(after.clockPoisoned, failure === "wall"); // invalid chain's poison is not evidence
      assert.equal(after.checkpoint.revision, before.checkpoint.revision + (chain === "legal" || failure === "wall" ? 1 : 0));
      assert.equal(after.consumed.length, 1); assert.deepEqual(item(m).commitOutcome, history);
      if (boundary === "commit") {
        assert.deepEqual(a.commitOutcome.checkpoint, after.checkpoint);
        unchanged(m, () => m.commit(h, clock(101, 1101)), "HANDLE");
      }
      const restored = SyntheticState.restore(m.exportImage()); const replay = restored.snapshot();
      assert.deepEqual(replay.revoked, after.revoked); assert.equal(replay.revocationSequence, after.revocationSequence);
      assert.equal(replay.clockPoisoned, after.clockPoisoned); assert.deepEqual(replay.consumed, after.consumed);
      assert.deepEqual(item(restored, "attempt-2"), a);
      if (h) unchanged(restored, () => restored.commit(h, clock(101, 1101)), "HANDLE");
    });
  }
}

test("schema/CAS/handle errors with rollback samples never partially apply clock or safety state", () => {
  const m = machine(); admit(m); reserve(m); const h = enter(m, "attempt-1", delta(1, [B]), clock(10, 1050));
  unchanged(m, () => m.commit(h, { ...clock(9, 1049), extra: true }), "INPUT");
  unchanged(m, () => m.commit({}, clock(9, 1049)), "HANDLE");
  unchanged(m, () => m.enter({ attemptId: "attempt-1", version: 1, clocks: clock(9, 1049), observation: delta(1, [B]) }), "CAS");
  m.commit(h, clock(11, 1051));
  assert.equal(item(m).status, "consumed-synthetic"); assert.deepEqual(m.snapshot().revoked, [B]);
  assert.equal(m.snapshot().clockPoisoned, false);
});

test("legal safety-chain poison also survives monotonic failure in the same revision", () => {
  const m = machine(); admit(m); reserve(m);
  const h = enter(m, "attempt-1", delta(1, [B], true), clock(10, 1050));
  const revision = m.snapshot().checkpoint.revision;
  m.commit(h, clock(9, 1051));
  assert.equal(item(m).reason, "MONOTONIC_ROLLBACK");
  assert.equal(m.snapshot().clockPoisoned, true); assert.deepEqual(m.snapshot().revoked, [B]);
  assert.equal(m.snapshot().checkpoint.revision, revision + 1);
  const restored = SyntheticState.restore(m.exportImage());
  assert.equal(restored.snapshot().clockPoisoned, true); assert.equal(restored.snapshot().revocationSequence, 1);
  assert.equal(restored.snapshot().consumed.length, 0);
});
