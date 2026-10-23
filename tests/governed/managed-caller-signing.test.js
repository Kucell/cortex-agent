"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  SIGNED_MESSAGE_KIND,
  canonicalize,
  signResponse,
  verifyResponse,
} = require("../../lib/governed/managed-caller-signing");

const SECRET = "0123456789abcdef0123456789abcdef";

describe("governed/managed-caller-signing - canonical form", () => {
  test("the canonical form pins every field the MAC covers", () => {
    const fields = {
      kind: SIGNED_MESSAGE_KIND.REQUEST,
      requestId: "r1",
      seq: 3,
      operation: "ping",
      body: { a: 1 },
    };
    const canonical = canonicalize(fields);
    assert.match(canonical, /request/);
    assert.match(canonical, /r1/);
    assert.match(canonical, /3/);
    assert.match(canonical, /ping/);
    assert.match(canonical, /\{"a":1\}/);
  });

  test("a missing seq and a missing body have stable representations", () => {
    const canonical = canonicalize({ kind: SIGNED_MESSAGE_KIND.HELLO, requestId: "r1" });
    assert.equal(typeof canonical, "string");
    assert.ok(canonical.length > 0);
    // The same absent fields must always canonicalize the same way, or the
    // two peers would compute different MACs for the same exchange.
    assert.equal(canonical, canonicalize({ kind: SIGNED_MESSAGE_KIND.HELLO, requestId: "r1" }));
  });
});

describe("governed/managed-caller-signing - verification", () => {
  test("a MAC verifies over the exact fields it was computed from", () => {
    const fields = { kind: SIGNED_MESSAGE_KIND.REQUEST, requestId: "r1", seq: 1, operation: "ping", body: { a: 1 } };
    const mac = signResponse(SECRET, fields);
    assert.equal(verifyResponse(SECRET, fields, mac), true);
  });

  test("changing any covered field invalidates the MAC", () => {
    const fields = { kind: SIGNED_MESSAGE_KIND.REQUEST, requestId: "r1", seq: 1, operation: "ping", body: { a: 1 } };
    const mac = signResponse(SECRET, fields);

    assert.equal(verifyResponse(SECRET, { ...fields, kind: SIGNED_MESSAGE_KIND.HELLO }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, requestId: "r2" }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, seq: 2 }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, operation: "other" }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, body: { a: 2 } }, mac), false);
  });

  test("a different secret never verifies", () => {
    const fields = { kind: SIGNED_MESSAGE_KIND.REQUEST, requestId: "r1", seq: 1, operation: "ping", body: null };
    const mac = signResponse(SECRET, fields);
    assert.equal(verifyResponse("ffffffffffffffffffffffffffffffff", fields, mac), false);
  });

  test("a malformed MAC is rejected without throwing", () => {
    const fields = { kind: SIGNED_MESSAGE_KIND.REQUEST, requestId: "r1", seq: 1, operation: "ping", body: null };
    assert.equal(verifyResponse(SECRET, fields, "not-hex"), false);
    assert.equal(verifyResponse(SECRET, fields, ""), false);
    assert.equal(verifyResponse(SECRET, fields, undefined), false);
    assert.equal(verifyResponse(SECRET, fields, null), false);
  });

  test("a truncated MAC of the wrong length is rejected", () => {
    const fields = { kind: SIGNED_MESSAGE_KIND.REQUEST, requestId: "r1", seq: 1, operation: "ping", body: null };
    const mac = signResponse(SECRET, fields);
    assert.equal(verifyResponse(SECRET, fields, mac.slice(0, 32)), false);
  });

  test("a handshake proof cannot be replayed as a request answer", () => {
    const helloFields = { kind: SIGNED_MESSAGE_KIND.HELLO, requestId: "r1", seq: "", operation: "hello", body: { nonce: "n" } };
    const mac = signResponse(SECRET, helloFields);
    // Same secret, same body — but replayed under the request kind.
    assert.equal(verifyResponse(SECRET, { ...helloFields, kind: SIGNED_MESSAGE_KIND.REQUEST }, mac), false);
  });
});
