"use strict";

// ─── Permit Bridge Service (M-053 / MS-008 第 9 环阶段 C) ──────────────────
//
// WHAT THIS IS
//   The production assembly of the ISSUING side: it owns the signing store,
//   the batch session that signs with it, and the bridge host that serves the
//   loopback endpoint.
//
// WHY THE ASSEMBLY LIVES HERE AND NOT IN THE HOST
//   `permit-bridge-host.js` starts a bridge from a batch session that somebody
//   else already built. That is the right shape for a test, but it leaves the
//   question unanswered for a deployment: who creates the store, who decides
//   where it lives, and who owns the batch key? This module is that answer.
//
//   The store is the durable home of the lease and permit state. Its location
//   and its decision id are DEPLOYMENT facts, so they are parameters here and
//   not defaults: an assembly that invented a path or a decision id would be
//   signing under an identity nobody chose.
//
// WHY THE STORE IS OPENED, NOT CREATED, BY DEFAULT
//   `ProtectedPermitStore.initialize` is the one-shot creation path, and it
//   refuses to run against a non-empty domain. A long-running service must
//   not be able to create the domain as a side effect of starting: the
//   domain's existence has to be an explicit administrative decision, and a
//   restart must never carry that side effect.
//
// WHY THE BATCH KEY NEVER LEAVES THIS PROCESS
//   The batch key pair is generated inside `createPermitBatchSession` and
//   stays behind a private reference. It is never serialized, never written
//   to a file, never put in an environment variable and never passed on a
//   command line. What leaves this process is the PUBLIC key — which is
//   meant to be public, because the target side registers it in its pin
//   domain so it can verify the permits this bridge signs.

const path = require("node:path");
const { CoordinationError } = require("./errors");
const { ProtectedPermitStore } = require("./protected-permit-store");
const { createPermitBatchSession } = require("./permit-batch-session");
const { startPermitBridgeHost } = require("./permit-bridge-host");

function fail(code) {
  throw new CoordinationError(code);
}

/**
 * Start the issuing bridge service.
 *
 * @param {object} options
 * @param {string} options.storePath The protected store's database path.
 * @param {string} options.anchorDir The anchor domain directory.
 * @param {string} options.decisionId The decision the store is bound to.
 * @param {string} options.executorPath The bridge executor's module path.
 * @param {string} [options.serviceIdentity] The declared service identity.
 * @param {boolean} [options.create] Create the store when it does not exist.
 * @param {number} [options.leaseTtlMs]
 * @param {number} [options.permitTtlMs]
 * @param {number} [options.ticketTtlMs]
 * @param {number} [options.minimumEpoch]
 * @param {string} [options.bindAddress]
 * @param {number} [options.port]
 * @param {function} [options.onDiagnostic]
 * @returns {Promise<object>} The running service.
 */
async function startPermitBridgeService(options = {}) {
  const {
    storePath,
    anchorDir,
    decisionId,
    executorPath,
    serviceIdentity,
    anchorMode = "strict",
    create = false,
    leaseTtlMs,
    permitTtlMs,
    ticketTtlMs,
    minimumEpoch = 1,
    bindAddress = "127.0.0.1",
    port = 0,
    onDiagnostic,
  } = options;

  if (typeof storePath !== "string" || !storePath) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof anchorDir !== "string" || !anchorDir) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof decisionId !== "string" || !decisionId) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof executorPath !== "string" || !executorPath) fail("ERR_PERMIT_INPUT_INVALID");

  function diagnose(event, detail) {
    if (typeof onDiagnostic !== "function") return;
    try { onDiagnostic(event, detail); } catch { /* a diagnostic must not break the path */ }
  }

  const storeOptions = {
    decisionId,
    anchorDir: path.resolve(anchorDir),
    anchorMode,
    serviceIdentity,
  };

  // The store is opened first and closed last. The batch session signs with
  // the store's state, so a bridge that had no store would have nothing to
  // reserve against.
  let store;
  try {
    store = create
      ? ProtectedPermitStore.initialize(path.resolve(storePath), storeOptions)
      : ProtectedPermitStore.open(path.resolve(storePath), { ...storeOptions, minimumEpoch });
  } catch (error) {
    diagnose("store_open_failed", error && (error.code || error.message));
    throw error;
  }

  const batchSession = createPermitBatchSession({ store });
  // The revocation list is signed by a SECOND batch session. The two must be
  // different key pairs: the permit batch may itself be revoked, while the
  // revocation batch must never be. One batch signing both would deadlock
  // the chain the first time the issuer revoked its permit batch.
  const revocationBatchSession = createPermitBatchSession({ store });

  let bridge;
  try {
    bridge = await startPermitBridgeHost({
      executorPath,
      batchSession,
      revocationBatchSession,
      // The state is read at dispatch time, not captured at startup: a
      // revocation committed after the bridge started has to be visible to
      // the next list request.
      revocationStateSource: () => store.revocationState(),
      leaseTtlMs,
      permitTtlMs,
      ticketTtlMs,
      bindAddress,
      port,
      onDiagnostic,
    });
  } catch (error) {
    // The store was opened before the bridge existed. A failure here has to
    // release it, or the deployment would keep a lock on a database no
    // bridge is using.
    try { batchSession.close(); } catch { /* already failing */ }
    try { revocationBatchSession.close(); } catch { /* already failing */ }
    try { store.close(); } catch { /* already failing */ }
    throw error;
  }

  diagnose("bridge_ready", bridge.address && bridge.address.port);

  return Object.freeze({
    bridge,
    store,
    batchSession,
    revocationBatchSession,
    address: bridge.address,
    revocationAddress: bridge.revocationAddress,
    /**
     * Mint a client ticket for the verified peer.
     *
     * @returns {string}
     */
    issueTicket() {
      return bridge.issueTicket();
    },
    async close() {
      await bridge.close();
      try { batchSession.close(); } catch { /* already closed */ }
      try { revocationBatchSession.close(); } catch { /* already closed */ }
      try { store.close(); } catch { /* already closed */ }
    },
  });
}

module.exports = Object.freeze({ startPermitBridgeService });
