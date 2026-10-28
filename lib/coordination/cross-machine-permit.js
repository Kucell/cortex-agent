// The cross-machine registration and key retrieval path (MS-004 step 3).
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
  } = options;
  if (!pinStore || typeof pinStore.criticalSection !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  return pinStore.criticalSection(() => {
    // The existing pin is looked up inside the critical section. It is the
    // target side that decides, and it decides from its own state -- not
    // from a conclusion the initiator reported.
    const existing = pinStore.batchIdentityFor(batchIdentity.fingerprint);
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
    const result = pinStore.registerPin({
      batchIdentity,
      publicKeyPem,
      nowMs,
      write,
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

    // The revoked set and the applied high-water mark advance together.
    pinStore.commitRevocation({
      sequence,
      revokedFingerprints: list.revoked_fingerprints.slice().sort(),
    });
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

module.exports = {
  DEFAULT_REVOCATION_PULL_TIMEOUT_MS,
  registerOnTarget,
  retrieveVerificationKey,
  pullAndApplyRevocation,
  verifyWithPinnedKey,
  receiptDigestFor,
};
