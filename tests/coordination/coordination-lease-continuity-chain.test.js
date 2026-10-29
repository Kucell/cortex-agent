"use strict";

// ─── Lease continuity chain ────────────────────────────────────────────────
//
// A lease that reacquires a scope after another owner has held it in the
// meantime used to record no relation to anything: `recoveredFrom` stayed
// null, because that field means "this lease *directly* continues the
// previous one", and the previous one belonged to somebody else. The
// consequence was that the sequence became unauditable — after the fact
// there was no way to tell which earlier lease of the same owner the new one
// descended from, or whether the scope had been interrupted at all.
//
// The chain fixes that without weakening anything:
//
//   * `recoveredFrom` keeps its meaning — the direct predecessor, and only
//     when the same owner held the scope immediately before;
//   * `continuityFrom` records the owner's own previous lease over the same
//     scope, so the lineage is always walkable back to the owner's first
//     lease over that scope;
//   * `recoveredFrom` and `continuityFrom` can differ, and that difference is
//     exactly the signal that somebody else held the scope in between.
//
// The rebind path uses the lineage to reject a rebind onto an unrelated lease
// that merely shares the owner and the scope.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LeaseManager,
  createManualClock,
} = require("../../lib/coordination/lease");

function mk(clock) {
  return new LeaseManager({ clock: clock || createManualClock(0) });
}

test("a first lease starts an empty chain", () => {
  const lm = mk();
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.equal(lease.continuityFrom, null);
  assert.equal(lease.recoveredFrom, null);
  assert.deepEqual(lm.traceContinuityChain(lease.leaseId), [lease.leaseId]);
});

test("the same owner reacquiring an expired lease extends its chain", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001);
  const second = lm.acquire("src/", "agent-a", { ttl: 1000 });

  // Direct continuation: both fields point at the same lease.
  assert.equal(second.recoveredFrom, first.leaseId);
  assert.equal(second.continuityFrom, first.leaseId);
  assert.deepEqual(lm.traceContinuityChain(second.leaseId), [second.leaseId, first.leaseId]);
});

test("reacquiring after another owner held the scope keeps the owner's chain", () => {
  const lm = mk();
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(first.leaseId);
  const other = lm.acquire("src/", "agent-b", { ttl: 1000 });
  lm.release(other.leaseId);
  const third = lm.acquire("src/", "agent-a", { ttl: 1000 });

  // The direct predecessor belonged to somebody else, so this is not a
  // direct continuation — but it *is* the same owner's third lease over the
  // scope, and the chain says so.
  assert.equal(third.recoveredFrom, null);
  assert.equal(third.continuityFrom, first.leaseId);
  assert.deepEqual(
    lm.traceContinuityChain(third.leaseId),
    [third.leaseId, first.leaseId],
  );
  // The interrupted owner is not part of agent-a's lineage.
  assert.ok(!lm.traceContinuityChain(third.leaseId).includes(other.leaseId));
});

test("the chain spans several interruptions by other owners", () => {
  const lm = mk();
  const a1 = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(a1.leaseId);
  const b1 = lm.acquire("src/", "agent-b", { ttl: 1000 });
  lm.release(b1.leaseId);
  const a2 = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(a2.leaseId);
  const b2 = lm.acquire("src/", "agent-b", { ttl: 1000 });
  lm.release(b2.leaseId);
  const a3 = lm.acquire("src/", "agent-a", { ttl: 1000 });

  assert.equal(a3.continuityFrom, a2.leaseId);
  assert.deepEqual(
    lm.traceContinuityChain(a3.leaseId),
    [a3.leaseId, a2.leaseId, a1.leaseId],
  );
});

test("a takeover starts a lineage for the new owner, not for the displaced one", () => {
  const lm = mk();
  const first = lm.acquire("src/", "agent-a", { ttl: 10000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  const { lease } = lm.completeTakeover(req.requestId, {
    recoveryEvidence: ["./worktree-check.json"],
  });

  // The takeover lease records the lease it took over as its direct
  // predecessor, but agent-b had no earlier lease of its own over this
  // scope, so its own lineage starts here.
  assert.equal(lease.recoveredFrom, first.leaseId);
  assert.equal(lease.continuityFrom, null);
  assert.deepEqual(lm.traceContinuityChain(lease.leaseId), [lease.leaseId]);
});

test("a takeover does not erase the new owner's earlier history of the scope", () => {
  const lm = mk();
  // agent-b held the scope before and lost it.
  const b1 = lm.acquire("src/", "agent-b", { ttl: 1000 });
  lm.release(b1.leaseId);
  const a1 = lm.acquire("src/", "agent-a", { ttl: 10000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  const { lease } = lm.completeTakeover(req.requestId, {
    recoveryEvidence: ["./worktree-check.json"],
  });

  // The new lease continues agent-b's own earlier lease, not agent-a's.
  assert.equal(lease.continuityFrom, b1.leaseId);
  assert.equal(lease.recoveredFrom, a1.leaseId);
  assert.deepEqual(
    lm.traceContinuityChain(lease.leaseId),
    [lease.leaseId, b1.leaseId],
  );
});

test("assessContinuitySuccessor accepts a same-owner same-scope successor", () => {
  const lm = mk();
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(first.leaseId);
  const second = lm.acquire("src/", "agent-a", { ttl: 1000 });

  const verdict = lm.assessContinuitySuccessor(second.leaseId, first.leaseId);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.traceable, true);
  assert.ok(verdict.chain.includes(first.leaseId));
});

test("assessContinuitySuccessor rejects a lease of another owner", () => {
  const lm = mk();
  const mine = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(mine.leaseId);
  const theirs = lm.acquire("src/", "agent-b", { ttl: 1000 });

  const verdict = lm.assessContinuitySuccessor(theirs.leaseId, mine.leaseId);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "owner_mismatch");
});

test("assessContinuitySuccessor rejects a lease over a different scope", () => {
  const lm = mk();
  const mine = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(mine.leaseId);
  const other = lm.acquire("other/", "agent-a", { ttl: 1000 });

  const verdict = lm.assessContinuitySuccessor(other.leaseId, mine.leaseId);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "scope_mismatch");
});

test("assessContinuitySuccessor rejects an unknown lease", () => {
  const lm = mk();
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const verdict = lm.assessContinuitySuccessor("LEASE-999", lease.leaseId);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "lease_not_found");
});

test("assessContinuitySuccessor rejects a lease whose chain contradicts the claim", () => {
  // Same owner, same scope — but the lease carries a chain of its own and
  // the claimed predecessor is not on it. Two lines of work, not one.
  const lm = mk();
  const mine = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const forged = {
    ...mine,
    leaseId: "LEASE-9001",
    fencingToken: mine.fencingToken + 10,
    continuityFrom: null,
  };
  lm._leases.set(forged.leaseId, forged);
  lm._indexLease(forged.scope, forged.leaseId);

  const verdict = lm.assessContinuitySuccessor(forged.leaseId, mine.leaseId);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "lineage_contradiction");
  assert.equal(verdict.legacy, false);
});

test("a lease loaded from an older runtime is accepted, not refused", () => {
  // The chain of a pre-upgrade lease cannot be walked, so the relation is
  // unknown rather than broken. Refusing it would strand every Task whose
  // ownership reference predates the upgrade.
  const lm = mk();
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const state = lm.exportState();
  delete state.leases[0].continuityFrom;

  const restored = LeaseManager.fromState(state, { clock: createManualClock(0) });
  restored.release(first.leaseId);
  const second = restored.acquire("src/", "agent-a", { ttl: 1000 });

  const verdict = restored.assessContinuitySuccessor(second.leaseId, first.leaseId);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.legacy, true);
});

test("a lease persisted by an older runtime loads without a chain field", () => {
  const lm = mk();
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const state = lm.exportState();
  // Simulate a lease written before `continuityFrom` existed.
  delete state.leases[0].continuityFrom;
  delete state.leases[0].recoveredFrom;

  const restored = LeaseManager.fromState(state, { clock: createManualClock(0) });
  const loaded = restored.getLease(first.leaseId);
  assert.equal(loaded.continuityFrom, null);
  assert.equal(loaded.recoveredFrom, null);
  // The chain walk terminates instead of throwing.
  assert.deepEqual(restored.traceContinuityChain(first.leaseId), [first.leaseId]);
});

test("a lease loaded from an older runtime can still be reacquired under", () => {
  const lm = mk();
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const state = lm.exportState();
  delete state.leases[0].continuityFrom;

  const restored = LeaseManager.fromState(state, { clock: createManualClock(0) });
  restored.release(first.leaseId);
  const second = restored.acquire("src/", "agent-a", { ttl: 1000 });
  assert.equal(second.continuityFrom, first.leaseId);
  assert.equal(second.recoveredFrom, null);
});

test("the acquire audit records the chain of the new lease", () => {
  const lm = mk();
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(first.leaseId);
  const other = lm.acquire("src/", "agent-b", { ttl: 1000 });
  lm.release(other.leaseId);
  lm.acquire("src/", "agent-a", { ttl: 1000 });

  const acquired = lm.getAuditLog({ eventType: "ownership.acquired" });
  const last = acquired[acquired.length - 1];
  assert.equal(last.reason, "initial_acquire");
  assert.equal(last.details.continuityFrom, first.leaseId);
  assert.equal(last.details.recoveredFrom, null);
  // The interruption is visible: the previous owner was somebody else.
  assert.equal(last.details.previousOwner, "agent-b");
});
