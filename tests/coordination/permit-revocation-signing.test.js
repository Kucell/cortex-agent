"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const delivery = require("../../lib/coordination/permit-delivery");
const { signRevocationList } = require("../../lib/coordination/permit-revocation-signing");

function input() {
  const key = delivery.createBatchKeyPair();
  return { key, options: { privateKeyRef: key.privateKeyRef, publicKeyPem: key.publicKeyPem,
    state: delivery.createRevocationState(), fingerprints: ["a".repeat(64)], issuedAtMs: 1000 } };
}

test("signed envelope is accepted by the existing revocation verifier", () => {
  const { key, options } = input();
  const list = signRevocationList(options);
  delivery.applyRevocationList({ state: options.state, list, publicKeyPem: key.publicKeyPem,
    pinnedFingerprints: new Set([key.fingerprint]), nowMs: 1000 });
  assert.equal(options.state.appliedRevocationSequence, 1);
  assert.ok(options.state.revokedFingerprints.has("a".repeat(64)));
  assert.ok(!JSON.stringify(list).includes("PRIVATE KEY"));
});

test("modified envelope is rejected without advancing revocation state", () => {
  const { key, options } = input();
  const list = signRevocationList(options);
  list.revoked_fingerprints = ["b".repeat(64)];
  assert.throws(() => delivery.applyRevocationList({ state: options.state, list,
    publicKeyPem: key.publicKeyPem, pinnedFingerprints: new Set([key.fingerprint]), nowMs: 1000 }));
  assert.equal(options.state.appliedRevocationSequence, 0);
});

test("signing refuses a truncated set, invalid sequence, and revoked signer", () => {
  const { key, options } = input();
  options.state.revokedFingerprints.add("b".repeat(64));
  assert.throws(() => signRevocationList(options), { key: "ERR_REVOCATION_SET_NOT_MONOTONIC" });
  options.state.revokedFingerprints.clear();
  options.state.appliedRevocationSequence = Number.MAX_SAFE_INTEGER;
  assert.throws(() => signRevocationList(options), { key: "ERR_PERMIT_INPUT_INVALID" });
  options.state.appliedRevocationSequence = 0;
  options.state.revokedFingerprints.add(key.fingerprint);
  assert.throws(() => signRevocationList(options), { key: "ERR_REVOCATION_SIGNER_INVALID" });
});

test("a key handle that does not match the declared public key is refused", () => {
  const { options } = input();
  options.privateKeyRef = delivery.createBatchKeyPair().privateKeyRef;
  assert.throws(() => signRevocationList(options), { key: "ERR_REVOCATION_SIGNER_INVALID" });
});
