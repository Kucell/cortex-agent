"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createExecutorEndpoint } = require("../../lib/governed/managed-caller-supervisor");
const { CHANNEL_MESSAGE, SIGNED_MESSAGE_KIND } = require("../../lib/governed/managed-caller-session");
const { signResponse, digestPayload } = require("../../lib/governed/managed-caller-signing");

function child() {
  const emitter = new EventEmitter();
  emitter.channel = {};
  emitter.send = (message) => { emitter.sent = message; };
  return emitter;
}

test("executor rejects a forged response on an inherited channel", async () => {
  const channel = child();
  const endpoint = createExecutorEndpoint(channel, "test-secret");
  const pending = endpoint.request("permit.key", { fingerprint: "f" });
  const request = channel.sent;
  channel.emit("message", { type: CHANNEL_MESSAGE.RESPONSE, requestId: request.requestId,
    seq: request.seq, body: { seq: request.seq, result: { authorized: true } }, mac: "forged" });
  await assert.rejects(pending, /signature verification/);
});

test("executor accepts only a correctly signed matching response", async () => {
  const channel = child();
  const secret = "test-secret";
  const endpoint = createExecutorEndpoint(channel, secret);
  const pending = endpoint.request("permit.key", { fingerprint: "f" });
  const request = channel.sent;
  const body = { seq: request.seq, result: { fingerprint: "f" } };
  const mac = signResponse(secret, { kind: SIGNED_MESSAGE_KIND.REQUEST_IN_RESPONSE,
    requestId: request.requestId, seq: request.seq, operation: request.operation,
    payloadDigest: request.payloadDigest, body });
  channel.emit("message", { type: CHANNEL_MESSAGE.RESPONSE, requestId: request.requestId,
    seq: request.seq, body, mac });
  assert.deepEqual(await pending, { fingerprint: "f" });
});

test("executor refuses forged and replayed coordinator requests before signing a response", () => {
  const channel = child();
  const secret = "test-secret";
  const endpoint = createExecutorEndpoint(channel, secret);
  const message = { type: CHANNEL_MESSAGE.REQUEST, requestId: "r", seq: 1,
    operation: "permit.key", payload: { fingerprint: "f" } };
  message.payloadDigest = digestPayload(message.payload);
  message.mac = "forged";
  assert.throws(() => endpoint.answer(message, { ok: true }), /signature verification/);
  assert.equal(channel.sent, undefined);
  message.mac = signResponse(secret, { kind: SIGNED_MESSAGE_KIND.REQUEST_OUT,
    requestId: message.requestId, seq: message.seq, operation: message.operation,
    payloadDigest: message.payloadDigest, body: null });
  endpoint.answer(message, { ok: true });
  assert.throws(() => endpoint.answer(message, { ok: true }), /signature verification/);
});
