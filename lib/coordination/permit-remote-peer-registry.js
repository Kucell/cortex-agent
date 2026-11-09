"use strict";

// ─── Permit Remote Peer Registry (M-053 / R2-c) ─────────────────────────────
//
// WHAT THIS IS
//   The list of peers that a bridge currently accepts tickets for: the local
//   managed session's pinned identity, plus the remote peers whose handshake
//   the ticket agent verified and whose registration has not expired.
//
// WHY A REGISTRY AND NOT A SECOND PIN
//   The local peer's identity is pinned for the bridge's whole lifetime. A
//   remote peer's identity only exists for as long as its ticket can still be
//   presented — so it is registered with a deadline and dropped afterwards.
//   A ticket that outlives its peer is exactly the captured-ticket case the
//   one-shot ticket rule is meant to bound, so the registry has to end with
//   the ticket's reach, not with the bridge's.
//
// WHY THE COMPARISON REUSES THE BRIDGE'S OWN RULE
//   `identityMatches` is what the endpoint already used to decide whether a
//   ticket's bound facts are the pinned peer's. Using a second, looser
//   comparison for remote peers would mean two definitions of "the same
//   peer" in one bridge — and the looser one would be the one that decides.

const { identityMatches } = require("./permit-bridge-policy");

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

/**
 * Create the registry.
 *
 * @param {object} [options]
 * @param {function} [options.clock] Millisecond clock.
 * @returns {object} The registry.
 */
function createRemotePeerRegistry(options = {}) {
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (typeof clock !== "function") fail("ERR_PERMIT_INPUT_INVALID");

  // sessionId -> { identity, expiresAt }
  const peers = new Map();

  function purge(now) {
    for (const [sessionId, entry] of peers) {
      if (entry.expiresAt <= now) peers.delete(sessionId);
    }
  }

  return Object.freeze({
    /**
     * Register a remote peer for the lifetime of the tickets minted for it.
     *
     * @param {object} identity The peer's identity facts.
     * @param {number} ttlMs How long the registration lives.
     */
    register(identity, ttlMs) {
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
        fail("ERR_PERMIT_INPUT_INVALID");
      }
      if (typeof identity.sessionId !== "string" || !identity.sessionId) fail("ERR_PERMIT_INPUT_INVALID");
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
      const now = clock();
      purge(now);
      peers.set(identity.sessionId, { identity, expiresAt: now + ttlMs });
    },
    /**
     * Whether a ticket's bound facts belong to a peer that is still live.
     *
     * @param {object} ticketFacts The facts the ticket was minted for.
     * @param {object} localIdentity The local session's pinned identity.
     * @returns {boolean}
     */
    matches(ticketFacts, localIdentity) {
      if (!ticketFacts || typeof ticketFacts !== "object") return false;
      if (localIdentity && identityMatches(ticketFacts, localIdentity)) return true;
      purge(clock());
      for (const entry of peers.values()) {
        if (identityMatches(ticketFacts, entry.identity)) return true;
      }
      return false;
    },
    /**
     * The number of live remote peers. Diagnostics only.
     *
     * @returns {number}
     */
    size() {
      purge(clock());
      return peers.size;
    },
  });
}

module.exports = Object.freeze({ createRemotePeerRegistry });
