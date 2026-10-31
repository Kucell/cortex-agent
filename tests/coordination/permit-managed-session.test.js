"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startPermitManagedSession } = require("../../lib/coordination/permit-managed-session");

test("managed permit session refuses an unauthorized action and serves its allowlisted action", async () => {
  let calls = 0;
  const authority = { dispatch: (identity, action, payload) => {
    assert.ok(identity.pid > 0);
    calls += 1;
    return { action, fingerprint: payload.fingerprint };
  } };
  const { session, child } = await startPermitManagedSession({
    modulePath: path.join(__dirname, "..", "governed", "fixtures", "m044-ms002-executor.js"),
    args: ["--mode=proxy"], authority,
  });
  function request(operation, payload) {
    return new Promise((resolve, reject) => {
      const requestId = `${operation}-${Math.random()}`;
      const timer = setTimeout(() => { child.off("message", listener); reject(new Error("request timeout")); }, 5000);
      function listener(message) {
        if (!message || message.type !== "proxy-result" || message.requestId !== requestId) return;
        clearTimeout(timer);
        child.off("message", listener);
        resolve(message);
      }
      child.on("message", listener);
      child.send({ type: "proxy", requestId, operation, payload });
    });
  }
  try {
    const result = await request("permit.key", { fingerprint: "abc" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { action: "key", fingerprint: "abc" });
    const denied = await request("permit.other", {});
    assert.equal(denied.ok, false);
    assert.equal(calls, 1);
  } finally {
    await session.close("test_cleanup");
    if (child.exitCode === null) child.kill();
  }
});
