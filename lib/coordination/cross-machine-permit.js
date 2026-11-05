// The cross-machine registration and key retrieval path.
//
// Step 1 built the signing core: the batch key pair, the signed permit,
// the verifier and the revocation bookkeeping. This module is the half
// that crosses the machine boundary:
//
//   - REGISTRATION: the Mac side asks the Windows side to register the
//     batch public key. The judgement and the write happen on the target
//     side inside its protected critical section. The initiator never
//     reports a conclusion of its own.
//   - KEY RETRIEVAL: the verifier takes the public key from the PIN and
//     from nowhere else. A list that carries its own key is refused.
//   - REVOCATION PULL: the verifier pulls the revocation list over the
//     protected service channel, verifies it against a pin key, and
//     commits it inside the same critical section.
//
// The rule that shapes most of this module is the design's rule that a
// fact that cannot be decided is handled as NOT satisfied (design section
// 2.2.2). Every judgement below therefore distinguishes "decided false"
// from "not decided", and only the second one is allowed to keep a route
// alive.

"use strict";

const { CoordinationError } = require("./errors");
const delivery = require("./permit-delivery");

function fail(code) { throw new CoordinationError(code); }

// The pull timeout. The design gives it a default of 5000ms and requires
// it to be configured explicitly and recorded (design section 2.3.1
// R3-B2 ruling 1).
const DEFAULT_REVOCATION_PULL_TIMEOUT_MS = 5000;

// Register the batch public key on the target side.
//
// The whole function runs inside the target side's protected critical
// section: the exclusivity check, the pin verification and the state
// advance are one atomic step. Splitting them would leave a window in
// which the check has passed and the write has not happened yet -- which
// is exactly the TOCTOU that design counterexample 17 is about.
//
// The exclusivity precondition has three clauses and each of them has its
// own domain of decided values:
//
//   existingPin       -- whether a pin for this key is already registered
//   targetHasProcess  -- whether the target instance has a live process
//   targetHasPriorRun -- whether the target instance has a prior run
//
// A clause that was not decided blocks the route. The check lives in
// step 1's assertPinExclusive; this function only supplies the facts and
// lets that function decide.
function registerOnTarget(options) {
  const {
    pinStore,
    batchIdentity,
    publicKeyPem,
    targetHasProcess,
    targetHasPriorRun,
    write,
    nowMs,
    bootstrap,
    // The registration action carries the design's field table (section
    // 2.2). source_digest / deployment_digest / valid_from / valid_until
    // are new inputs; run_id / generation are the signed binding values
    // passed through unchanged -- they are not new fields.
    sourceDigest,
    deploymentDigest,
    runId,
    generation,
    validFrom,
    validUntil,
  } = options;
  if (!pinStore || typeof pinStore.criticalSection !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  return pinStore.criticalSection(() => {
    assertBootstrapNotUnverifiable(bootstrap, batchIdentity, pinStore);
    // The existing pin is looked up inside the critical section. It is the
    // target side that decides, and it decides from its own state -- not
    // from a conclusion the initiator reported.
    const existing = pinStore.batchIdentityFor(batchIdentity.fingerprint);

    // The batch comparison comes BEFORE the exclusivity clauses.
    //
    // The order matters, because the two clauses answer different
    // questions. The batch question is "is the pin that is already here
    // ours?" -- and the answer has two possible shapes:
    //
    //   the same triple  -> this is a reconnect; the pin is reused and the
    //                       registration succeeds without a new write;
    //   a different triple -> a different batch is trying to take over a
    //                       pin that is not its own; the route stops with
    //                       ERR_PIN_BATCH_MISMATCH and nothing is
    //                       overwritten.
    //
    // The exclusivity question is "may a pin be registered at all?" and it
    // only has a meaning when there is NO pin yet. Asking it first made
    // every existing pin a plain ERR_PIN_NOT_EXCLUSIVE, which meant the
    // batch comparison was never reached: a reconnect failed, and a
    // foreign batch was reported as a generic exclusivity failure instead
    // of the specific "not your pin" refusal the design names.
    if (existing) {
      if (!sameBatchTriple(existing, batchIdentity)) {
        // The pin belongs to another batch. It is never overwritten.
        fail("ERR_PIN_BATCH_MISMATCH");
      }
      // The same batch. That ALONE does not make this a reconnect.
      //
      // Two competitors of the same batch arrive here too: the second
      // one to run finds the pin the first one just wrote. If the same
      // triple were enough to reuse the pin, the loser of that race
      // would be told it had succeeded -- and the exclusivity guarantee
      // would stop being a guarantee.
      //
      // A RECONNECT is a later action of the same batch, and the design
      // gives it its own evidence: the bootstrap snapshot. The snapshot's
      // state plus whether the target can independently verify the pin
      // is what separates a normal reconnect from crash residue (design
      // section 2.2.3, R3-B3 revision 2). Without that evidence the
      // route is a FRESH registration that found an existing pin, and the
      // exclusivity clauses apply.
      if (!isReconnectOfThisBatch(bootstrap, batchIdentity, existing)) {
        // The exclusivity clauses describe a fresh registration, and a
        // fresh registration needs no existing pin.
        fail("ERR_PIN_NOT_EXCLUSIVE");
      }
      // A verified reconnect: the pin is reused, not rewritten, and the
      // exclusivity clauses do not apply to it.
      const receiptDigest = receiptDigestFor({
        decisionId: batchIdentity.decision_id,
        instanceId: batchIdentity.instance_id,
        fingerprint: batchIdentity.fingerprint,
      });
      // The advanceability is decided before anything is touched, for the
      // same reason as on the fresh-registration path.
      //
      // This is the RECONNECT path, so the snapshot may already be in a
      // terminal state ("consumed", or gone after the cleanup). Those
      // states are the normal end of the snapshot's life and the design
      // admits a reconnect there -- the pin is reused and the snapshot is
      // NOT advanced, because advancing it back to "registered" would be
      // a backward move the state machine forbids.
      let advanceSnapshot = false;
      if (bootstrap) {
        const advanceable = require("./bootstrap-snapshot").assertSnapshotAdvanceable({
          snapshotDir: bootstrap.snapshotDir,
          nextState: "registered",
          receiptDigest,
          allowReuse: true,
        });
        advanceSnapshot = advanceable.advance === true;
      }
      const reused = pinStore.registerPin({
        batchIdentity,
        publicKeyPem,
        nowMs,
        write,
        sourceDigest,
        deploymentDigest,
        runId,
        generation,
        validFrom,
        validUntil,
      });
      if (bootstrap && advanceSnapshot) {
        require("./bootstrap-snapshot").advanceSnapshot({
          snapshotDir: bootstrap.snapshotDir,
          nextState: "registered",
          receiptDigest,
          nowMs,
        });
      }
      return Object.assign({}, reused, { receiptDigest, reused: true });
    }
    const verdict = delivery.assertPinExclusive({
      // An existing pin is a decided fact when the store could read its
      // state. A pin that exists but belongs to ANOTHER batch is a
      // different case: that is the "do not overwrite" rule, not the
      // exclusivity rule.
      existingPin: existing ? true : null,
      targetHasProcess,
      targetHasPriorRun,
    });
    if (!verdict.exclusive) {
      // The route stops. The bootstrap snapshot, if there is one, records
      // why.
      fail("ERR_PIN_NOT_EXCLUSIVE");
    }
    // The bootstrap snapshot is CREATED here, by the registration path.
    //
    // The design gives the snapshot a writer: the same unique identity
    // that registers the pin creates the snapshot, with O_EXCL, inside the
    // protected critical section (design section 2.2.3). Without a
    // creation step in the product path the snapshot state machine had no
    // reachable starting point: the "created" state that the rest of the
    // machine reasons about could only be produced by a caller that
    // reached into the library directly.
    //
    // The order matters. The snapshot is created AFTER the exclusivity
    // clauses are satisfied and BEFORE the pin is written, so that a
    // crash in between leaves the snapshot in the "created" state with no
    // pin -- a state the target side can decide (the pin is not ours, the
    // registration never landed, and the attempt may be repeated). The
    // reverse order would leave a pin without a snapshot, which is the
    // undecidable state the design names.
    //
    // A snapshot that already exists is left alone: that is the reconnect
    // or the crash-residue case, and both are decided above.
    if (bootstrap && bootstrap.snapshotDir) {
      const snapshotModule = require("./bootstrap-snapshot");
      if (!snapshotModule.readSnapshot(bootstrap.snapshotDir)) {
        snapshotModule.createSnapshot({
          snapshotDir: bootstrap.snapshotDir,
          batchIdentity: {
            decision_id: batchIdentity.decision_id,
            instance_id: batchIdentity.instance_id,
            fingerprint: batchIdentity.fingerprint,
          },
          runId,
          generation,
          nowMs,
        });
      }
    }
    // The snapshot's advanceability is decided BEFORE the pin is written.
    //
    // The pin write and the snapshot advance are two halves of one
    // protected critical section, and the advance is the half that can
    // fail for reasons the pin write knows nothing about. If the advance
    // were only attempted afterwards and it failed, the pin would already
    // be on disk and the domain would be left in the "created + pin
    // present" state the design names as undecidable. Deciding it here
    // means a snapshot that cannot be read, or cannot move forward, stops
    // the route with nothing written.
    //
    // It runs AFTER the creation above because a fresh registration has no
    // snapshot to advance until this step created it.
    if (bootstrap) {
      require("./bootstrap-snapshot").assertSnapshotAdvanceable({
        snapshotDir: bootstrap.snapshotDir,
        nextState: "registered",
        receiptDigest: receiptDigestFor({
          decisionId: batchIdentity.decision_id,
          instanceId: batchIdentity.instance_id,
          fingerprint: batchIdentity.fingerprint,
        }),
      });
    }
    const result = pinStore.registerPin({
      batchIdentity,
      publicKeyPem,
      nowMs,
      write,
      sourceDigest,
      deploymentDigest,
      runId,
      generation,
      validFrom,
      validUntil,
    });
    // The receipt digest is what lets a later reconnect tell this
    // registration apart from a different one. It is computed from the
    // facts that identify the registration.
    const receiptDigest = receiptDigestFor({
      decisionId: batchIdentity.decision_id,
      instanceId: batchIdentity.instance_id,
      fingerprint: batchIdentity.fingerprint,
    });
    if (bootstrap) {
      // The receipt digest and the state advance happen inside the SAME
      // critical section as the pin verification. If they were split, a
      // crash between them would leave "created" with a pin present, which
      // is the undecidable state the design calls out.
      require("./bootstrap-snapshot").advanceSnapshot({
        snapshotDir: bootstrap.snapshotDir,
        nextState: "registered",
        receiptDigest,
        nowMs,
      });
    }
    return Object.assign({}, result, { receiptDigest });
  });
}

// The bootstrap snapshot's verdict.
//
// The snapshot distinguishes a NORMAL RECONNECT from CRASH RESIDUE, and it
// does so by the snapshot's state plus whether the target can independently
// verify the pin (design section 2.2.3, R3-B3 revision 2). Every verdict
// that says the route may not proceed stops the route here, with the
// specific code, rather than leaving the decision to the wiring party --
// a verdict that is merely reported and not enforced is not a control.
//
// A snapshot that belongs to ANOTHER batch is the replacement case and is
// equally a stop: it is not this batch's snapshot to judge this batch's
// registration by.
function assertBootstrapNotUnverifiable(bootstrap, batchIdentity, pinStore) {
  if (!bootstrap || !bootstrap.snapshotDir) return;
  const { classifySnapshot } = require("./bootstrap-snapshot");
  const classification = classifySnapshot({
    snapshotDir: bootstrap.snapshotDir,
    batchIdentity: {
      decision_id: batchIdentity.decision_id,
      instance_id: batchIdentity.instance_id,
      fingerprint: batchIdentity.fingerprint,
    },
    canVerifyPinOwnership: () => {
      const existing = pinStore.batchIdentityFor(batchIdentity.fingerprint);
      if (!existing) return "none";
      return sameBatchTriple(existing, batchIdentity) ? "ours" : "none";
    },
  });
  if (classification.reconnectAllowed === true) return;
  if (classification.classification === "foreign-batch") {
    // The snapshot on disk belongs to another batch. Stop, and do not
    // clean it up -- it is not this route's snapshot.
    fail("ERR_BOOTSTRAP_UNVERIFIABLE");
  }
  // undecidable / unverifiable / residue-or-replaced: the target cannot
  // say whether the pin belongs to this batch, so the route stops.
  fail("ERR_BOOTSTRAP_UNVERIFIABLE");
}

// Whether this registration is a RECONNECT of the batch that owns the
// existing pin.
//
// The evidence is the bootstrap snapshot. A snapshot that belongs to this
// batch, is in a state that allows a reconnect, and whose pin ownership the
// target can independently verify -- that is a reconnect, and the pin is
// reused.
//
// Without a snapshot there is no reconnect to speak of: the first
// registration of a batch has no snapshot yet, so a second arrival with
// the same triple is a competitor, not a reconnect.
function isReconnectOfThisBatch(bootstrap, batchIdentity, existing) {
  if (!bootstrap || !bootstrap.snapshotDir) return false;
  const { classifySnapshot } = require("./bootstrap-snapshot");
  const classification = classifySnapshot({
    snapshotDir: bootstrap.snapshotDir,
    batchIdentity: {
      decision_id: batchIdentity.decision_id,
      instance_id: batchIdentity.instance_id,
      fingerprint: batchIdentity.fingerprint,
    },
    canVerifyPinOwnership: () => (sameBatchTriple(existing, batchIdentity) ? "ours" : "none"),
  });
  return classification.reconnectAllowed === true;
}

// Whether two batch identities are the same batch.
//
// The comparison is field by field: the three fields together identify one
// registration, and a field that differs makes it a different one. The
// fingerprint is compared too, because it is part of the identity.
function sameBatchTriple(existing, incoming) {
  return existing.decision_id === incoming.decision_id
    && existing.instance_id === incoming.instance_id
    && existing.fingerprint === incoming.fingerprint;
}

// The receipt digest. It covers the batch identity triple, so a receipt
// for one batch can never be mistaken for the receipt of another.
function receiptDigestFor(identity) {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      decision_id: identity.decisionId,
      instance_id: identity.instanceId,
      fingerprint: identity.fingerprint,
    }))
    .digest("hex");
}

// Retrieve the verification key.
//
// The verifier trusts ONLY the key in the pin (design section 2.3.1
// R3-B2 ruling 2). A key carried by the message, by the revocation list
// or by any other source is refused. That is why this function takes no
// "candidate key" argument at all: there is nothing it could do with one.
function retrieveVerificationKey(options) {
  const { pinStore, fingerprint } = options;
  if (!pinStore || typeof pinStore.publicKeyFor !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  assertDomainNotClockPoisoned(pinStore);
  if (typeof fingerprint !== "string" || !fingerprint) fail("ERR_PERMIT_INPUT_INVALID");
  const publicKeyPem = pinStore.publicKeyFor(fingerprint);
  if (!publicKeyPem) {
    // The batch is not registered on this machine. That is the only
    // remaining reason a pin has no key, because revocation does not
    // remove pin entries.
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  return { fingerprint, publicKeyPem };
}

// Pull the revocation list and apply it.
//
// The pull happens INSIDE the local critical section (design section
// 2.3.1 R3-B2 ruling 1). That is a deliberate trade-off the design names:
// the pull delay holds the local lock, and the delay is turned directly
// into other verifiers' waiting time. It is bounded by an explicit
// timeout, and a timeout means THIS verification is refused.
//
// A pull that fails because the channel is unavailable is also a refusal.
// The previously pulled list must NOT be used to keep accepting -- that
// would turn a channel outage into an unbounded revocation window.
function pullAndApplyRevocation(options) {
  const {
    pinStore,
    pull,
    nowMs,
    pullTimeoutMs,
    verifyPermit,
  } = options;
  if (!pinStore || typeof pinStore.criticalSection !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  if (typeof pull !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  const timeout = pullTimeoutMs === undefined
    ? DEFAULT_REVOCATION_PULL_TIMEOUT_MS
    : pullTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) fail("ERR_PERMIT_INPUT_INVALID");

  return pinStore.criticalSection(() => {
    // A poisoned domain refuses the pull as well. The pull is where the
    // revocation state is brought up to date, and applying a list against a
    // clock that is not trusted would advance the high-water mark on a
    // timeline nobody can vouch for.
    assertDomainNotClockPoisoned(pinStore);
    // The pull is bounded. The timeout is what keeps the lock from being
    // held for an unbounded time, and a timeout refuses this verification
    // rather than letting it through on stale data.
    const list = pullWithTimeout(pull, timeout);
    if (!list) fail("ERR_REVOCATION_PULL_TIMEOUT");

    // The list's sequence is checked against the local applied high-water
    // mark BEFORE the signature is trusted, so a replayed or truncated list
    // is rejected by the chain rule rather than by the signature.
    const state = pinStore.revocationState();
    const sequence = list.revocation_sequence;
    if (!Number.isSafeInteger(sequence)) fail("ERR_PERMIT_INPUT_INVALID");
    if (sequence === state.highestSeenRevocationSequence && sequence !== state.appliedRevocationSequence + 1) {
      // The list has already been seen. Re-applying it would be a repeat
      // of a sequence the chain already moved past.
      fail("ERR_REVOCATION_SEQUENCE_BROKEN");
    }

    // The signer of the list has to be a key in the pin, and it has to be
    // a key that is not itself revoked. The key is taken from the PIN --
    // never from the list.
    const claimed = list.batch_public_key_fingerprint;
    if (typeof claimed !== "string" || !claimed) fail("ERR_PERMIT_INPUT_INVALID");
    const retrieved = retrieveVerificationKey({ pinStore, fingerprint: claimed });
    const pinned = pinStore.pinnedFingerprints();

    // The verification is done by step 1's machinery, which already
    // enforces the chain position, the signer's presence in the pin and
    // the signer's absence from the revoked set.
    const applied = delivery.applyRevocationList({
      state,
      list,
      publicKeyPem: retrieved.publicKeyPem,
      pinnedFingerprints: pinned,
      nowMs,
    });

    // On successful permit verification, commit its high-water mark with the
    // freshly authenticated revocation state. A rejected permit still applies
    // the valid revocation list, without advancing the permit high-water mark.
    let verified;
    let verificationError;
    if (verifyPermit !== undefined) {
      if (typeof verifyPermit !== "function") fail("ERR_PERMIT_INPUT_INVALID");
      // Do not hand the verifier the state being committed: a callback must
      // not be able to alter the authenticated revocation set after checking.
      const verificationState = { ...state, revokedFingerprints: new Set(state.revokedFingerprints) };
      try { verified = verifyPermit(verificationState); } catch (error) { verificationError = error; }
      if (!verificationError && (!verified || verified.ok !== true || !Number.isSafeInteger(verified.sequence))) {
        verificationError = new CoordinationError("ERR_PERMIT_INPUT_INVALID");
      }
    }
    pinStore.commitRevocation({
      sequence: applied.appliedRevocationSequence,
      revokedFingerprints: [...state.revokedFingerprints].sort(),
      ...(!verificationError && verified ? { permitSequence: verified.sequence } : {}),
    });
    if (verificationError) throw verificationError;
    if (verifyPermit !== undefined) return verified;
    return applied;
  });
}

// Run the pull with a timeout.
//
// The pull is a synchronous operation in this codebase, so the timeout is
// enforced by racing the pull against a deadline check around it. A pull
// that reports its own lateness is refused rather than accepted late.
function pullWithTimeout(pull, timeoutMs) {
  const started = Date.now();
  let result;
  try {
    result = pull();
  } catch (error) {
    // The channel is unavailable, or the pull failed for any other
    // reason. Either way this verification is refused. The previously
    // pulled list is not used as a fallback.
    if (error && (error.key === "ERR_REVOCATION_PULL_TIMEOUT" || error.code === "ERR_REVOCATION_PULL_TIMEOUT")) {
      throw error;
    }
    fail("ERR_REVOCATION_PULL_FAILED");
  }
  if (Date.now() - started > timeoutMs) return null;
  if (!result || typeof result !== "object") fail("ERR_REVOCATION_PULL_FAILED");
  return result;
}

// Verify a permit against the pinned key.
//
// The key comes from the pin and from nowhere else, and the revocation
// state comes from the same protected domain. This is the join of step 1
// and step 3.
function verifyWithPinnedKey(options) {
  const { pinStore, fingerprint, message, signature, expectedDeadlineMs, nowMs, skewToleranceMs } = options;
  if (!pinStore || typeof pinStore.publicKeyFor !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  assertDomainNotClockPoisoned(pinStore);
  const retrieved = retrieveVerificationKey({ pinStore, fingerprint });
  const revoked = pinStore.revocationState();
  if (revoked.revokedFingerprints.has(retrieved.fingerprint)) {
    // The signing key is revoked. It may not authorize anything.
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  return delivery.verifyPermitSignature({
    message,
    signature,
    publicKeyPem: retrieved.publicKeyPem,
    expectedFingerprint: retrieved.fingerprint,
    revokedFingerprints: revoked.revokedFingerprints,
    expectedDeadlineMs,
    nowMs,
    skewToleranceMs,
  });
}

// The clock-poisoning marker.
//
// A poisoned domain is one in which the clock could not be trusted. The
// design says such a process refuses every new permit until the clearing
// procedure has run, and the marker lives in the protected domain so that
// it survives a restart.
//
// The marker used to be written but never read: no entry point consulted
// it, so poisoning a domain changed nothing and the domain kept
// authorising. A marker nobody reads is not a control.
//
// The check sits at the ENTRY of every path that can authorise or that
// pulls the state the authorisation depends on. It is deliberately the
// first thing they do: a poisoned domain is refused before anything is
// read, so no permit is evaluated against a clock that is not trusted.
function assertDomainNotClockPoisoned(pinStore) {
  if (!pinStore || typeof pinStore.isClockPoisoned !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  let poisoned;
  try {
    poisoned = pinStore.isClockPoisoned();
  } catch (error) {
    // A marker that could not be read is an undecidable marker, and an
    // undecidable clock is not a trusted clock. The refusal is the same
    // one a poisoned domain gets.
    if (error && (error.key === "ERR_PIN_STATE_CORRUPT"
      || error.code === "ERR_PIN_STATE_CORRUPT")) fail("ERR_CLOCK_INVALID");
    throw error;
  }
  if (poisoned) fail("ERR_CLOCK_INVALID");
}

module.exports = {
  DEFAULT_REVOCATION_PULL_TIMEOUT_MS,
  registerOnTarget,
  retrieveVerificationKey,
  pullAndApplyRevocation,
  verifyWithPinnedKey,
  receiptDigestFor,
};
