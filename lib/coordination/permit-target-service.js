"use strict";

const crossMachine = require("./cross-machine-permit");
const delivery = require("./permit-delivery");
const { CoordinationError } = require("./errors");
const fs = require("node:fs");
const path = require("node:path");

// Internal composition only. The host must authenticate callers and supply
// trusted revocation and current-state providers; this is not an IPC endpoint.
function createPermitTargetService({ pinStore, pullRevocation, resolvePermitState, observeTarget, bootstrap, clock = Date.now } = {}) {
  if (!pinStore || typeof pinStore.criticalSection !== "function" ||
      typeof pullRevocation !== "function" || typeof resolvePermitState !== "function" ||
      typeof clock !== "function") throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new CoordinationError("ERR_CLOCK_INVALID");
    return value;
  }

  function key(fingerprint) {
    return pinStore.criticalSection(() => crossMachine.retrieveVerificationKey({ pinStore, fingerprint }));
  }

  function revoke() {
    return crossMachine.pullAndApplyRevocation({ pinStore, pull: pullRevocation, nowMs: now() });
  }

  function register({ batchIdentity, publicKeyPem, sourceDigest, deploymentDigest,
    runId, generation, validFrom, validUntil } = {}) {
    if (typeof observeTarget !== "function" || typeof pinStore.pinDir !== "string") {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    // createPublicKey can derive a public key from a private PEM. Never let
    // such input reach the persistent pin entry, even if it parses as a key.
    if (typeof publicKeyPem !== "string" || !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(publicKeyPem) ||
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(publicKeyPem)) {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    return pinStore.criticalSection(() => {
      const observation = observeTarget(batchIdentity);
      if (!observation || typeof observation.targetHasProcess !== "boolean" ||
          typeof observation.targetHasPriorRun !== "boolean") {
        throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
      }
      const write = (entry, fingerprint) => {
        if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
        let fd;
        try {
          fd = fs.openSync(path.join(pinStore.pinDir, `pin-${fingerprint}.json`), "wx", 0o600);
          fs.writeFileSync(fd, JSON.stringify(entry) + "\n");
          fs.fsyncSync(fd);
          return true;
        } catch (error) {
          if (error.code === "EEXIST") return false;
          throw error;
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      };
      return crossMachine.registerOnTarget({ pinStore, batchIdentity, publicKeyPem,
        targetHasProcess: observation.targetHasProcess, targetHasPriorRun: observation.targetHasPriorRun,
        sourceDigest, deploymentDigest, runId, generation, validFrom, validUntil,
        bootstrap, write, nowMs: now() });
    });
  }

  function verify(input = {}) {
    let fingerprint, message, signature;
    try { ({ fingerprint, message, signature } = structuredClone(input)); }
    catch { throw new CoordinationError("ERR_PERMIT_INPUT_INVALID"); }
    return pinStore.criticalSection(() => {
      if (typeof pinStore.assertPermitReplayState !== "function") throw new CoordinationError("ERR_PIN_STATE_CORRUPT");
      const startedAt = now();
      const verified = crossMachine.pullAndApplyRevocation({ pinStore, pull: pullRevocation, nowMs: startedAt,
        verifyPermit: (revocationState) => {
          const highestAccepted = pinStore.assertPermitReplayState();
          if (typeof pinStore.observePermitClock !== "function") throw new CoordinationError("ERR_CLOCK_INVALID");
          pinStore.observePermitClock(startedAt);
          let state;
          try { state = structuredClone(resolvePermitState(message && message.permit_id)); }
          catch { throw new CoordinationError("ERR_PERMIT_INPUT_INVALID"); }
          const checkedAt = now();
          pinStore.observePermitClock(checkedAt);
          const expectedDeadlineMs = requireCurrentPermit(state, message, fingerprint, checkedAt);
          if (revocationState.revokedFingerprints.has(fingerprint)) {
            throw new CoordinationError("ERR_REVOCATION_SIGNER_INVALID");
          }
          const { publicKeyPem } = crossMachine.retrieveVerificationKey({ pinStore, fingerprint });
          const verifiedAt = now();
          pinStore.observePermitClock(verifiedAt);
          const finalDeadlineMs = requireCurrentPermit(state, message, fingerprint, verifiedAt);
          if (finalDeadlineMs !== expectedDeadlineMs) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
          const result = delivery.verifyPermitSignature({ message, signature, publicKeyPem,
            expectedFingerprint: fingerprint, revokedFingerprints: revocationState.revokedFingerprints,
            expectedDeadlineMs, nowMs: verifiedAt });
          if (result.sequence <= highestAccepted) throw new CoordinationError("ERR_PERMIT_SEQUENCE_REPLAY");
          return result;
        } });
      // This verifies a snapshot and advances local replay state; it does not
      // atomically consume the authority permit and must not grant execution.
      return { ok: verified.ok, executionAuthorized: false, fingerprint: verified.fingerprint,
        sequence: verified.sequence, deadline: verified.deadline };
    });
  }

  return Object.freeze({ register, key, revoke, verify });
}

// The host must fetch this snapshot from an authenticated authoritative store,
// never from the request. This is a check at one instant, not a cross-host
// transaction: revocation can race a later effect and requires consume().
function requireCurrentPermit(state, message, fingerprint, nowMs) {
  const permit = state && state.permits && message && state.permits[message.permit_id];
  const lease = state && state.lease;
  if (permit && Number.isSafeInteger(permit.deadline) && permit.deadline <= nowMs) {
    throw new CoordinationError("ERR_PERMIT_DEADLINE_EXPIRED");
  }
  if (!permit || !lease || permit.permitId !== message.permit_id || permit.status !== "reserved" ||
      permit.batchFingerprint !== fingerprint || lease.status !== "active" ||
      !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= nowMs ||
      !Number.isSafeInteger(permit.deadline) || permit.deadline < 0 ||
      permit.serviceEpoch !== state.service_epoch || permit.fencing !== state.fencing ||
      lease.serviceEpoch !== state.service_epoch || lease.fencing !== state.fencing ||
      !state.desktop || state.desktop.status !== "held" || state.desktop.key !== permit.desktopKey) {
    throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
    if (permit[storage] !== message[signed]) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  for (const field of ["leaseId", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"]) {
    if (permit[field] !== lease[field]) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  return permit.deadline;
}

module.exports = { createPermitTargetService };
