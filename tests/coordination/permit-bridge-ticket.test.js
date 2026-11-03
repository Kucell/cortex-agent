"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TICKET_HEADER,
  createTicketRegistry,
  readTicketHeader,
  ticketIdentityFacts,
} = require("../../lib/coordination/permit-bridge-ticket");

const PEER = Object.freeze({
  sessionId: "session-1",
  pid: 4242,
  startToken: "win32:133000000000000000",
  commandDigest: "sha256:abc",
});

test("the ticket binds the four identity facts the policy compares", () => {
  const facts = ticketIdentityFacts(PEER);
  assert.equal(facts.sessionId, "session-1");
  assert.equal(facts.pid, 4242);
  assert.equal(facts.startToken, "win32:133000000000000000");
  assert.equal(facts.commandDigest, "sha256:abc");
  // The facts are frozen: a holder cannot rewrite the binding after the fact.
  assert.throws(() => { "use strict"; facts.sessionId = "other"; }, TypeError);
});

test("the ticket refuses an identity that lacks a bound fact", () => {
  for (const fact of ["sessionId", "pid", "startToken", "commandDigest"]) {
    const incomplete = { ...PEER };
    delete incomplete[fact];
    assert.throws(() => ticketIdentityFacts(incomplete), { code: "ERR_PERMIT_INPUT_INVALID" });
  }
  assert.throws(() => ticketIdentityFacts(null), { code: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => ticketIdentityFacts({ ...PEER, pid: "4242" }), { code: "ERR_PERMIT_INPUT_INVALID" });
});

test("a ticket is accepted exactly once", () => {
  const registry = createTicketRegistry();
  const value = registry.mint(PEER);
  assert.ok(value && typeof value === "string");
  const consumed = registry.consume(value);
  assert.equal(consumed.sessionId, "session-1");
  // A replay finds nothing: the ticket was consumed by the first request.
  assert.equal(registry.consume(value), null);
});

test("an unknown ticket is refused", () => {
  const registry = createTicketRegistry();
  assert.equal(registry.consume("a".repeat(64)), null);
  assert.equal(registry.consume(""), null);
  assert.equal(registry.consume(null), null);
  assert.equal(registry.consume(undefined), null);
});

test("an expired ticket is refused", () => {
  let now = 1_000;
  const registry = createTicketRegistry({ ttlMs: 50, clock: () => now });
  const value = registry.mint(PEER);
  now += 49;
  assert.ok(registry.consume(value));

  const other = registry.mint(PEER);
  now += 51;
  assert.equal(registry.consume(other), null);
});

test("the ticket value carries no information about the peer", () => {
  // Two tickets for the same peer are different values: the value is a
  // random nonce, so a captured ticket says nothing about which peer it was
  // minted for.
  const registry = createTicketRegistry();
  const first = registry.mint(PEER);
  const second = registry.mint(PEER);
  assert.notEqual(first, second);
  assert.equal(first.includes(PEER.sessionId), false);
  assert.equal(first.includes(PEER.commandDigest), false);
});

test("the registry refuses a configuration it cannot honour", () => {
  assert.throws(() => createTicketRegistry({ ttlMs: 0 }), { code: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => createTicketRegistry({ ttlMs: -1 }), { code: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => createTicketRegistry({ clock: "now" }), { code: "ERR_PERMIT_INPUT_INVALID" });
});

test("the ticket is read from the request headers", () => {
  assert.equal(readTicketHeader({ [TICKET_HEADER]: "value" }), "value");
  assert.equal(readTicketHeader({}), null);
  assert.equal(readTicketHeader({ [TICKET_HEADER]: "" }), null);
  assert.equal(readTicketHeader(null), null);
});
