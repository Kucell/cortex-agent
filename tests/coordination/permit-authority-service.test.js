"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPermitAuthorityService } = require("../../lib/coordination/permit-authority-service");

test("unauthorized and asynchronous authorization never invoke a permit operation", () => {
  let calls = 0;
  const targetService = { key: () => { calls += 1; } };
  for (const authorize of [() => false, () => Promise.resolve(true), () => undefined,
    () => { throw new Error("private authorization detail"); }]) {
    const service = createPermitAuthorityService({ authorize, targetService });
    assert.throws(() => service.dispatch({}, "key", { fingerprint: "x" }), (error) =>
      error.key === "ERR_PERMIT_INPUT_INVALID" && !error.message.includes("private authorization detail"));
  }
  assert.equal(calls, 0);
});

test("authorization receives immutable resource bindings used by the operation", () => {
  const original = { lease: { sessionId: "allowed" }, permit: { operation: "read" } };
  let executed = 0;
  const service = createPermitAuthorityService({
    authorize: (peer, action, request) => {
      assert.equal(action, "issue");
      assert.ok(Object.isFrozen(request.lease));
      original.lease.sessionId = "other";
      return request.lease.sessionId === "allowed" && request.permit.operation === "read";
    },
    batchSession: { issue: (request) => { executed += 1; assert.equal(request.lease.sessionId, "allowed"); } },
  });
  service.dispatch({}, "issue", original);
  assert.equal(executed, 1);
  assert.throws(() => service.dispatch({}, "issue", original), { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.equal(executed, 1);
});

test("authorized operations are routed and unsupported operations are refused", () => {
  const peer = Object.freeze({ identity: "verified" });
  const calls = [];
  const targetService = {
    key: (fingerprint) => { calls.push(["key", fingerprint]); return { fingerprint }; },
    revoke: () => { calls.push(["revoke"]); return { applied: true }; },
  };
  const batchSession = { issue: (args) => { calls.push(["issue", args]); return { ok: true }; } };
  const service = createPermitAuthorityService({ authorize: (actual) => actual === peer, targetService, batchSession });
  assert.deepEqual(service.dispatch(peer, "key", { fingerprint: "f" }), { fingerprint: "f" });
  assert.deepEqual(service.dispatch(peer, "revoke", { ignored: true }), { applied: true });
  assert.deepEqual(service.dispatch(peer, "issue", { lease: { id: 1 }, permit: { id: 2 }, extra: "ignored" }), { ok: true });
  assert.deepEqual(calls[2], ["issue", { lease: { id: 1 }, permit: { id: 2 } }]);
  assert.throws(() => service.dispatch(peer, "other", {}), { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => service.dispatch({}, "key", { fingerprint: "f" }), { key: "ERR_PERMIT_INPUT_INVALID" });
});
