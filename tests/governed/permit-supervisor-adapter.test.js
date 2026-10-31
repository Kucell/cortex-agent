"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startManagedCallerSession } = require("../../lib/governed/managed-caller-supervisor");

function proxy(child, operation, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `request-${Math.random()}`;
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error("proxy timed out")); }, 5000);
    function receive(message) {
      if (!message || message.type !== "proxy-result" || message.requestId !== requestId) return;
      clearTimeout(timer);
      child.off("message", receive);
      resolve(message);
    }
    child.on("message", receive);
    child.send({ type: "proxy", requestId, operation, payload });
  });
}

test("managed channel scopes and audits requests before the trusted handler", async () => {
  let invalidIdentity = false;
  let calls = 0;
  let revocations = 0;
  let observedPid;
  const factSource = {
    collectProcessFacts: (child) => { observedPid = child.pid; return { pid: child.pid, startToken: invalidIdentity ? "changed" : "original",
      commandDigest: "test", socketAddress: "test", socketEndpoint: { inode: 123, address: "test" } }; },
    readSocketHolders: () => [observedPid],
    isPreciseStartToken: () => true,
  };
  const { session, child } = await startManagedCallerSession({
    modulePath: path.join(__dirname, "fixtures", "m044-ms002-executor.js"), args: ["--mode=proxy"],
    allowedOperations: ["permit.key"], factSource,
    onIdentityUnavailable: () => { revocations += 1; throw new Error("notification failed"); },
    onAuthorizedRequest: ({ identity, operation, payload }) => {
      calls += 1;
      assert.equal(identity.pid, child.pid);
      return { operation, fingerprint: payload.fingerprint };
    },
  });
  try {
    const allowed = await proxy(child, "permit.key", { fingerprint: "f" });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.result, { operation: "permit.key", fingerprint: "f" });
    const outside = await proxy(child, "permit.issue", {});
    assert.equal(outside.ok, false);
    invalidIdentity = true;
    const changed = await proxy(child, "permit.key", { fingerprint: "f" });
    assert.equal(changed.ok, false);
    assert.match(changed.error, /managed_caller_identity_unavailable/);
    assert.equal(revocations, 1);
    invalidIdentity = false;
    assert.equal(session.auditChannelHolders().ok, true);
    assert.equal(session.auditProcessContinuity().ok, true);
    assert.equal((await proxy(child, "permit.key", { fingerprint: "f" })).ok, false);
    assert.equal(revocations, 1);
    assert.equal(calls, 1);
  } finally {
    await session.close("test_cleanup");
    if (child.exitCode === null) child.kill();
  }
});

test("identity loss during a handler prevents a successful response", async () => {
  let changed = false;
  let calls = 0;
  let revocations = 0;
  let observedPid;
  const factSource = {
    collectProcessFacts: (child) => { observedPid = child.pid; return { pid: child.pid, startToken: changed ? "changed" : "original",
      commandDigest: "test", socketAddress: "test", socketEndpoint: { inode: 123, address: "test" } }; },
    readSocketHolders: () => [observedPid],
    isPreciseStartToken: () => true,
  };
  const { session, child } = await startManagedCallerSession({
    modulePath: path.join(__dirname, "fixtures", "m044-ms002-executor.js"), args: ["--mode=proxy"],
    allowedOperations: ["permit.key"], factSource,
    onIdentityUnavailable: () => { revocations += 1; },
    onAuthorizedRequest: () => { calls += 1; changed = true; return { ok: true }; },
  });
  try {
    const result = await proxy(child, "permit.key", { fingerprint: "f" });
    assert.equal(result.ok, false);
    assert.equal(revocations, 1);
    changed = false;
    assert.equal(session.auditChannelHolders().ok, true);
    assert.equal(session.auditProcessContinuity().ok, true);
    assert.equal((await proxy(child, "permit.key", { fingerprint: "f" })).ok, false);
    assert.equal(revocations, 1);
    assert.equal(calls, 1);
  } finally {
    await session.close("test_cleanup");
    if (child.exitCode === null) child.kill();
  }
});
