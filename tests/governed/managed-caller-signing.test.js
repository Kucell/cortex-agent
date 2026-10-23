"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  SIGNED_MESSAGE_KIND,
  canonicalize,
  digestPayload,
  signResponse,
  verifyResponse,
} = require("../../lib/governed/managed-caller-signing");

const SECRET = "0123456789abcdef0123456789abcdef";

describe("governed/managed-caller-signing - canonical form", () => {
  test("the canonical form pins every field the MAC covers", () => {
    const fields = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT,
      requestId: "r1",
      seq: 3,
      operation: "ping",
      payloadDigest: digestPayload({ a: 1 }),
      body: { a: 1 },
    };
    const canonical = canonicalize(fields);
    assert.match(canonical, /request-out/);
    assert.match(canonical, /r1/);
    assert.match(canonical, /3/);
    assert.match(canonical, /ping/);
    assert.match(canonical, /[0-9a-f]{64}/);
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
    const fields = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
      requestId: "r1",
      seq: 1,
      operation: "ping",
      payloadDigest: digestPayload({ a: 1 }),
      body: { a: 1 },
    };
    const mac = signResponse(SECRET, fields);
    assert.equal(verifyResponse(SECRET, fields, mac), true);
  });

  test("changing any covered field invalidates the MAC", () => {
    const fields = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
      requestId: "r1",
      seq: 1,
      operation: "ping",
      payloadDigest: digestPayload({ a: 1 }),
      body: { a: 1 },
    };
    const mac = signResponse(SECRET, fields);

    assert.equal(verifyResponse(SECRET, { ...fields, kind: SIGNED_MESSAGE_KIND.HELLO }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, requestId: "r2" }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, seq: 2 }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, operation: "other" }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, payloadDigest: digestPayload({ a: 2 }) }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...fields, body: { a: 2 } }, mac), false);
  });

  test("the direction is part of the signed kind and cannot be swapped", () => {
    // This is the relay defence. An answer the coordinator produces for an
    // INBOUND request must not be acceptable as the child's answer to an
    // OUTBOUND request, and an outbound request signature must not be
    // acceptable as an inbound request. Without the direction in the signed
    // kind, a descendant that holds the transferred channel could feed the
    // coordinator's own signed answer back into its pending slot.
    const outbound = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT,
      requestId: "r1",
      seq: 1,
      operation: "ping",
      payloadDigest: digestPayload({ a: 1 }),
      body: null,
    };
    const mac = signResponse(SECRET, outbound);

    assert.equal(verifyResponse(SECRET, outbound, mac), true);
    assert.equal(
      verifyResponse(SECRET, { ...outbound, kind: SIGNED_MESSAGE_KIND.REQUEST_IN }, mac),
      false,
      "an outbound request signature was accepted as an inbound request",
    );

    const inboundAnswer = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_IN_RESPONSE,
      requestId: "r1",
      seq: 1,
      operation: "ping",
      payloadDigest: digestPayload({ a: 1 }),
      body: { seq: 1, result: { ok: true } },
    };
    const answerMac = signResponse(SECRET, inboundAnswer);
    assert.equal(
      verifyResponse(SECRET, { ...inboundAnswer, kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE }, answerMac),
      false,
      "an inbound answer was accepted as an outbound answer",
    );
  });

  test("the payload digest distinguishes payloads that differ only in content", () => {
    assert.notEqual(digestPayload({ a: 1 }), digestPayload({ a: 2 }));
    assert.notEqual(digestPayload({ a: 1 }), digestPayload({ a: 2, b: undefined }));
    assert.equal(digestPayload({ a: 1 }), digestPayload({ a: 1 }));
    assert.notEqual(digestPayload(undefined), digestPayload(null));
  });

  test("a different secret never verifies", () => {
    const fields = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
      requestId: "r1",
      seq: 1,
      operation: "ping",
      body: null,
    };
    const mac = signResponse(SECRET, fields);
    assert.equal(verifyResponse("ffffffffffffffffffffffffffffffff", fields, mac), false);
  });

  test("a malformed MAC is rejected without throwing", () => {
    const fields = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
      requestId: "r1",
      seq: 1,
      operation: "ping",
      body: null,
    };
    assert.equal(verifyResponse(SECRET, fields, "not-hex"), false);
    assert.equal(verifyResponse(SECRET, fields, ""), false);
    assert.equal(verifyResponse(SECRET, fields, undefined), false);
    assert.equal(verifyResponse(SECRET, fields, null), false);
  });

  test("a truncated MAC of the wrong length is rejected", () => {
    const fields = {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
      requestId: "r1",
      seq: 1,
      operation: "ping",
      body: null,
    };
    const mac = signResponse(SECRET, fields);
    assert.equal(verifyResponse(SECRET, fields, mac.slice(0, 32)), false);
  });

  test("a handshake proof cannot be replayed as a request answer", () => {
    const helloFields = { kind: SIGNED_MESSAGE_KIND.HELLO, requestId: "r1", seq: "", operation: "hello", body: { nonce: "n" } };
    const mac = signResponse(SECRET, helloFields);
    // Same secret, same body — but replayed under the request kind.
    assert.equal(verifyResponse(SECRET, { ...helloFields, kind: SIGNED_MESSAGE_KIND.REQUEST_OUT }, mac), false);
    assert.equal(verifyResponse(SECRET, { ...helloFields, kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE }, mac), false);
  });
});
