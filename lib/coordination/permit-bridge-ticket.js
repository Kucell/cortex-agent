"use strict";

// ─── Permit Bridge Ticket (M-053 / MS-008 第 9 环阶段 C) ──────────────────
//
// WHAT THIS IS
//   The client-side credential of the issuing bridge's HTTP endpoint.
//
//   The bridge binds its endpoint to the loopback interface, and the product
//   side posts to it without an authentication header. Binding to loopback is
//   necessary but NOT sufficient: on a development machine every process of
//   the interactive account shares the same loopback interface. A bridge that
//   served any loopback client would therefore let a bystander process
//   obtain a signed permit.
//
//   A ticket closes that gap. A ticket is minted for exactly one VERIFIED
//   peer — the identity a managed session established — and is presented by
//   the client on every request. The endpoint accepts a request only when it
//   carries a live ticket, and the ticket is bound to the identity that was
//   audited when it was minted.
//
// WHY THE TICKET IS NOT A SHARED SECRET
//   A shared secret would prove "the caller knows the secret", not "the
//   caller is the supervised process". A same-account bystander that could
//   read the secret could then mint its own requests. The ticket is instead
//   derived from the peer's verified identity: it proves the caller is the
//   process the session audited, and it carries no secret of its own.
//
// WHY A TICKET IS ONE-SHOT
//   A ticket that could be replayed would make the endpoint's access control
//   only as strong as the secrecy of one captured value. Every ticket is
//   therefore consumed by the first request that presents it. A retry after a
//   timeout must obtain a new ticket, which is a deliberate cost: it means a
//   captured ticket cannot be used twice.
//
// WHY THE TICKET IS NOT A BEARER TOKEN THE CLIENT MAY INVENT
//   The endpoint verifies the ticket against the set of tickets IT minted.
//   A client cannot produce one, because the ticket is generated from the
//   peer's identity facts and a server-side nonce that the client never
//   sees.

const crypto = require("node:crypto");

// The identity facts a ticket is bound to. These are the same four facts the
// bridge policy compares: the ticket and the policy have to agree about what
// "the same peer" means, or a ticket could authorize a request the policy
// would then compare against a different identity.
const TICKET_IDENTITY_FACTS = Object.freeze([
  "sessionId",
  "pid",
  "startToken",
  "commandDigest",
]);

// The header the ticket travels in. The product side sends it as an HTTP
// header; the value is an opaque string, never a bearer of anything the
// client could have derived by itself.
const TICKET_HEADER = "x-permit-bridge-ticket";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extract the identity facts a ticket binds to.
 *
 * @param {object} identity The verified identity of a managed session.
 * @returns {object} The bound facts.
 */
function ticketIdentityFacts(identity) {
  if (!isPlainObject(identity)) fail("ERR_PERMIT_INPUT_INVALID");
  const facts = {};
  for (const fact of TICKET_IDENTITY_FACTS) {
    if (!Object.hasOwn(identity, fact)) fail("ERR_PERMIT_INPUT_INVALID");
    facts[fact] = identity[fact];
  }
  if (typeof facts.sessionId !== "string" || !facts.sessionId) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(facts.pid)) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof facts.startToken !== "string" || !facts.startToken) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof facts.commandDigest !== "string" || !facts.commandDigest) fail("ERR_PERMIT_INPUT_INVALID");
  return Object.freeze(facts);
}

/**
 * Mint a ticket for a verified peer identity.
 *
 * The ticket value is a random nonce: it carries no information about the
 * identity and cannot be derived from it. The binding is kept on the server
 * side, so a stolen ticket value alone tells an attacker nothing about which
 * peer it belongs to.
 *
 * @param {object} identity The verified identity of a managed session.
 * @returns {string} The ticket value the client presents.
 */
function mintTicket(identity) {
  const facts = ticketIdentityFacts(identity);
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create the server-side ticket registry.
 *
 * The registry holds the minted tickets, their bound identity facts and their
 * expiry. It is deliberately small and process-local: a ticket authorizes one
 * request from one peer, and the bridge's own lifetime bounds it.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] How long a ticket stays usable.
 * @param {function} [options.clock] Millisecond clock.
 * @returns {object} The registry.
 */
function createTicketRegistry(options = {}) {
  const ttlMs = options.ttlMs === undefined ? 60_000 : options.ttlMs;
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof clock !== "function") fail("ERR_PERMIT_INPUT_INVALID");

  // value -> { facts, expiresAt }
  const live = new Map();

  function purge(now) {
    for (const [value, entry] of live) {
      if (entry.expiresAt <= now) live.delete(value);
    }
  }

  return Object.freeze({
    ttlMs,
    /**
     * Mint a ticket for a peer.
     *
     * @param {object} identity The verified peer identity.
     * @returns {string}
     */
    mint(identity) {
      const facts = ticketIdentityFacts(identity);
      const value = mintTicket(identity);
      const now = clock();
      purge(now);
      live.set(value, { facts, expiresAt: now + ttlMs });
      return value;
    },
    /**
     * Consume a ticket. A ticket is accepted at most once.
     *
     * @param {string} value The presented ticket.
     * @returns {object|null} The bound identity facts, or null when the ticket
     *   is unknown, expired or already used.
     */
    consume(value) {
      if (typeof value !== "string" || !value) return null;
      const now = clock();
      purge(now);
      const entry = live.get(value);
      if (!entry) return null;
      // Consumed before it is returned: a replayed ticket finds nothing.
      live.delete(value);
      return entry.facts;
    },
    /**
     * The number of live tickets. Diagnostics only.
     *
     * @returns {number}
     */
    size() {
      purge(clock());
      return live.size;
    },
  });
}

/**
 * Read the ticket out of an HTTP request's headers.
 *
 * @param {object} headers The request headers.
 * @returns {string|null}
 */
function readTicketHeader(headers) {
  if (!isPlainObject(headers)) return null;
  const raw = headers[TICKET_HEADER];
  if (typeof raw !== "string" || !raw) return null;
  return raw;
}

module.exports = Object.freeze({
  TICKET_HEADER,
  TICKET_IDENTITY_FACTS,
  createTicketRegistry,
  readTicketHeader,
  ticketIdentityFacts,
});
