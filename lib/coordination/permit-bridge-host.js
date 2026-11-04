"use strict";

// ─── Permit Bridge Host (M-053 / MS-008 第 9 环阶段 C) ─────────────────────
//
// WHAT THIS MODULE IS
//   The production assembly for the ISSUING side of the bridge: it starts the
//   managed session, waits for the executor's `permit.start` handshake, pins
//   the executor's verified identity, and serves the loopback HTTP endpoint
//   that the product side POSTs to.
//
// WHY THE HTTP HANDLER DOES NOT DISPATCH DIRECTLY
//   `permit-authority-service.dispatch` requires the transport to supply an
//   opaque VERIFIED peer. The only verified peer available is the managed
//   session's identity. So the handler RELAYS the payload into the session
//   (via `permit.collect`), and the executor issues it back as an inbound
//   `permit.<action>` request. That request carries the session's MAC and
//   arrives at the coordinator from a process the coordinator OS-audited and
//   whose channel it verified to be exclusive.
//
//   A handler that called `dispatch` with a peer it made up would satisfy the
//   signature of the API while defeating its intent — the API's whole point
//   is that the peer is verified, not asserted. The pin is not decoration:
//   it is what the policy compares every later request against, and it only
//   has meaning if the request actually arrives over the session that
//   produced the pin.
//
// THE PIN IS TAKEN ONCE, FROM THE ESTABLISHED SESSION
//   The policy compares each request against the identity observed at
//   handshake time. Taking the pin from the session's `childIdentity` — the
//   object the session froze after its audits — is what makes the comparison
//   meaningful.
//
// WHY THE ENDPOINT BINDS LOOPBACK ONLY
//   The Owner ruling fixed the issuing endpoint to `127.0.0.1`. The product
//   side sends no authentication header, so the endpoint's own access control
//   is the only access control there is. A non-loopback bind would hand
//   "whoever can reach me may ask for a permit" to the network.

const { startManagedCallerSession } = require("../governed/managed-caller-supervisor");
const { CoordinationError } = require("./errors");
const { assemblePermitIssuer } = require("./permit-bridge-assembly");
const { attachPermitBridgeEndpoint } = require("./permit-bridge-assembly");
const { mapIssueRequest } = require("./permit-bridge-request");
const { createTicketRegistry } = require("./permit-bridge-ticket");
const { identityMatches } = require("./permit-bridge-policy");

function fail(code) {
  throw new CoordinationError(code);
}

const LOOPBACK_ADDRESSES = Object.freeze(["127.0.0.1", "::1"]);

function isLoopbackAddress(host) {
  if (typeof host !== "string" || !host) return false;
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_ADDRESSES.includes(normalized);
}

// The operation the coordinator uses to hand a payload to the executor.
const COLLECT_OPERATION = "permit.collect";

/**
 * Start the issuing side of the bridge.
 *
 * @param {object} options
 * @param {string} options.executorPath Absolute path to the bridge executor.
 * @param {object} options.batchSession The batch session that signs permits.
 * @param {string} [options.owner] Audit-only label.
 * @param {string} [options.bindAddress] Must be loopback.
 * @param {number} [options.port] 0 selects a free port.
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.leaseTtlMs] The desktop lease window.
 * @param {number} [options.permitTtlMs] The one-shot permit validity.
 * @param {number} [options.ticketTtlMs] How long a client ticket stays usable.
 * @param {function} [options.onDiagnostic]
 * @returns {Promise<object>} The running bridge.
 */
async function startPermitBridgeHost(options = {}) {
  const {
    executorPath,
    batchSession,
    revocationBatchSession,
    revocationStateSource,
    owner = "permit-bridge",
    bindAddress = "127.0.0.1",
    port = 0,
    revocationPort = 0,
    requestTimeoutMs,
    leaseTtlMs,
    permitTtlMs,
    ticketTtlMs = 60_000,
    onDiagnostic,
  } = options;

  if (typeof executorPath !== "string" || !executorPath) fail("ERR_PERMIT_INPUT_INVALID");
  if (!batchSession || typeof batchSession.issue !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  // The revocation list is signed by a SEPARATE batch. A revocation list
  // signed by the permit-issuing batch could revoke its own signer, and
  // `signRevocationList` refuses exactly that (`ERR_REVOCATION_SIGNER_INVALID`)
  // — so the two batches are not interchangeable.
  if (!revocationBatchSession || typeof revocationBatchSession.signRevocation !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  if (typeof revocationStateSource !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  // The TTLs are the bridge's own configuration. They are not request data,
  // and the bridge refuses to start without them rather than inventing a
  // default at request time.
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(permitTtlMs) || permitTtlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(ticketTtlMs) || ticketTtlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  // The bind address is checked BEFORE the session starts. A refusal that
  // came after the fork would leave a supervised executor behind with no
  // bridge to close it: the bridge never existed, so nothing would ever
  // send it the BYE that ends it.
  if (!isLoopbackAddress(bindAddress)) fail("ERR_PERMIT_INPUT_INVALID");

  function diagnose(event, detail) {
    if (typeof onDiagnostic !== "function") return;
    try { onDiagnostic(event, detail); } catch { /* a diagnostic must not break the path */ }
  }

  // The executor's allowed operations are the five permit actions plus the
  // collector and the start handshake. The batch is fixed at spawn time: the
  // executor cannot widen its own scope by sending a different operation.
  const allowedOperations = Object.freeze([
    "permit.start",
    COLLECT_OPERATION,
    "permit.issue",
    "permit.revocation-list",
    "permit.register",
    "permit.key",
    "permit.verify",
    "permit.revoke",
  ]);

  // The authority's authorize policy binds the peer to the pinned identity.
  // The identity is only known once the session is established, so the
  // authority is created inside the request handler below, on first use —
  // but it must be created ONCE, from the same pinned identity, and reused.
  let assembly = null;

  const started = await startManagedCallerSession({
    modulePath: executorPath,
    args: [],
    owner,
    allowedOperations: [...allowedOperations],
    requestTimeoutMs,
    onAuthorizedRequest: async ({ identity, operation, payload }) => {
      // `permit.start` is the executor announcing readiness. It carries no
      // business payload and must not reach the authority.
      if (operation === "permit.start") return { ready: true };

      // The pin is taken from the identity the session verified. Taking it
      // from anywhere else would make the comparison meaningless.
      //
      // The assembly is created ONCE. A second one would pin a second
      // identity, and the policy would then compare every later request
      // against whichever identity was pinned last.
      if (!assembly) {
        assembly = assemblePermitIssuer({
          batchSession,
          revocationBatchSession,
          revocationStateSource,
          peerIdentity: identity,
        });
        diagnose("peer_pinned", identity.sessionId);
      }

      // What arrives here is an INBOUND request from the executor: the
      // executor took the payload the HTTP handler relayed over the session
      // and issued it back as `permit.<action>`. This is the only path on
      // which the authority sees a verified peer, so this is where the
      // dispatch happens.
      //
      // The action must be one the pinned side is allowed to serve. The
      // policy decides that, and the assembly's action set is the issuing
      // side's {issue}.
      if (typeof operation !== "string" || !operation.startsWith("permit.")) {
        throw new Error("bridge operation not permitted");
      }
      const action = operation.slice("permit.".length);
      return assembly.perform(action, payload);
    },
  });

  const session = started.session;
  const child = started.child;

  // The executor must be told the session is live. `startManagedCallerSession`
  // does not do this itself: it answers INBOUND requests, and the handshake
  // that releases the executor is an OUTBOUND one. Without this the executor
  // waits forever and every request times out — which is exactly the shape of
  // the gap this assembly closes.
  try {
    await session.request("permit.start", {});
  } catch (error) {
    diagnose("start_failed", error && error.message);
    try { await session.close("bridge_start_failed"); } catch { /* already failing */ }
    await waitForChildExit(child);
    releaseChildStreams(child);
    throw error;
  }

  // The peer is pinned as soon as the session is established. The pin does
  // not wait for the first request: a ticket can only be minted for a peer
  // the bridge has already verified, so the assembly has to exist before any
  // client can ask for one.
  //
  // The identity comes from the session's own frozen copy — the same object
  // the inbound-request handler below would have used — so the ticket and the
  // authority are pinned to one and the same peer.
  if (!assembly) {
    assembly = assemblePermitIssuer({
      batchSession,
      revocationBatchSession,
      revocationStateSource,
      peerIdentity: session.childIdentity,
    });
    diagnose("peer_pinned", session.childIdentity && session.childIdentity.sessionId);
  }

  // The HTTP handler does NOT call the authority. It hands the product's
  // request to the executor over the session, and the executor issues it
  // back as an inbound `permit.issue` request. That round trip is what makes
  // the peer a VERIFIED peer: the authority sees an inbound request that
  // carries the session's MAC, from the process the session pinned.
  const perform = async (action, request, ticketFacts) => {
    if (action !== "issue" && action !== "revocation-list") fail("ERR_PERMIT_INPUT_INVALID");
    // The ticket names the peer it was minted for, and the session's pinned
    // identity names the peer the authority will compare against. If the two
    // disagree, the request is arriving over a channel that is not the one
    // the ticket was issued for — so it is refused here rather than being
    // dispatched on a peer's authority.
    if (!ticketFacts || !assembly || !identityMatches(ticketFacts, assembly.peerIdentity)) {
      diagnose("ticket_peer_mismatch", null);
      fail("ERR_PERMIT_INPUT_INVALID");
    }
    // `issue` carries a product request that has to be mapped onto the
    // authority's own field names. `revocation-list` carries no product
    // request at all: the list is derived from the issuer's own state, so
    // there is nothing to map and nothing for a peer to choose.
    const mapped = action === "issue"
      ? mapIssueRequest(request, { leaseTtlMs, permitTtlMs })
      : {};
    // The payload goes to the executor over the session. The executor turns
    // it into an inbound `permit.issue` request, and THAT is what the
    // authority above dispatches on.
    return session.request(COLLECT_OPERATION, {
      action: `permit.${action}`,
      args: mapped,
    });
  };

  let endpoint;
  let revocationEndpoint;
  let address;
  let revocationAddress;
  // The ticket registry is the endpoint's client access control. A ticket is
  // minted for the session's verified peer, so only a client that the bridge
  // itself established can obtain one.
  const tickets = createTicketRegistry({ ttlMs: ticketTtlMs });
  try {
    endpoint = attachPermitBridgeEndpoint({
      assembly: {
        perform,
        actions: ["issue"],
      },
      action: "issue",
      bindAddress,
      port,
      requestTimeoutMs,
      tickets,
      onDiagnostic: (event, detail) => diagnose("endpoint:" + event, detail),
    });
    address = await endpoint.listen();
    // The revocation list is served on its OWN endpoint. The product side
    // reads the permit endpoint and the revocation endpoint from two
    // different environment variables, and the two responses have two
    // different shapes (a grant and a revocation envelope). Serving both
    // from one URL would mean the response shape had to be chosen by
    // something in the request, and the request is the peer's to choose.
    revocationEndpoint = attachPermitBridgeEndpoint({
      assembly: {
        perform,
        actions: ["revocation-list"],
      },
      action: "revocation-list",
      bindAddress,
      port: revocationPort,
      requestTimeoutMs,
      tickets,
      onDiagnostic: (event, detail) => diagnose("revocation_endpoint:" + event, detail),
    });
    revocationAddress = await revocationEndpoint.listen();
  } catch (error) {
    // The session is already live at this point. A failure here has to take
    // the session down with it, or the executor would stay alive with a
    // pinned identity and no bridge that could ever close it.
    try { await session.close("bridge_start_failed"); } catch { /* already failing */ }
    await waitForChildExit(child);
    releaseChildStreams(child);
    throw error;
  }
  diagnose("listening", address && address.port);
  diagnose("revocation_listening", revocationAddress && revocationAddress.port);

  return Object.freeze({
    endpoint,
    revocationEndpoint,
    session,
    address,
    revocationAddress,
    /**
     * Mint a ticket for the session's verified peer.
     *
     * The client presents the ticket on every request. A ticket is one-shot,
     * so a client that needs another request obtains another one.
     *
     * @returns {string}
     */
    issueTicket() {
      if (!assembly) fail("ERR_PERMIT_INPUT_INVALID");
      return tickets.mint(assembly.peerIdentity);
    },
    async close() {
      await endpoint.close();
      try { await revocationEndpoint.close(); } catch { /* already closed */ }
      try { await session.close("bridge_closed"); } catch { /* already closed */ }
      // The session asks the executor to leave, but the supervisor does not
      // wait for it. A bridge that returned before its executor had gone
      // would leave a live peer behind with a pinned identity — and the next
      // bridge to start would pin a peer the previous one still owned.
      await waitForChildExit(child);
      // The supervisor leaves the child's stdio streams open. A stream that
      // is still open keeps the coordinator's event loop alive, so a host
      // that was closed but not torn down would never let the process exit.
      // The streams are the child's; the bridge owns the child, so it also
      // owns the streams it has to release.
      releaseChildStreams(child);
    },
  });
}

/**
 * Wait for the supervised executor to exit, and make sure it is gone.
 *
 * The executor is asked to leave by the session's BYE. A peer that ignores
 * it is not a peer that may stay: the bridge's identity pin is bound to that
 * process, so a surviving executor would keep the bridge's authority alive
 * after the bridge was closed.
 *
 * @param {object} child The supervised child process.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function waitForChildExit(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch { /* the child is already gone */ }
      resolve();
    }, timeoutMs);
    function onClose() {
      clearTimeout(timer);
      resolve();
    }
    child.once("close", onClose);
  });
}

/**
 * Release the coordinator-side streams of a supervised child.
 *
 * @param {object} child The supervised child process.
 * @returns {void}
 */
function releaseChildStreams(child) {
  if (!child || !Array.isArray(child.stdio)) return;
  for (const stream of child.stdio) {
    if (stream && typeof stream.destroy === "function") {
      try { stream.destroy(); } catch { /* the stream is already gone */ }
    }
  }
  // The IPC channel is not in `child.stdio` — it is the descriptor the
  // session secret was bound to, and node keeps it alive until the channel
  // itself is closed. A live channel keeps the coordinator's event loop
  // running, so the bridge would never let its host exit.
  if (child.channel && typeof child.channel.destroy === "function") {
    try { child.channel.destroy(); } catch { /* the channel is already gone */ }
  }
}

module.exports = Object.freeze({ startPermitBridgeHost, COLLECT_OPERATION });
