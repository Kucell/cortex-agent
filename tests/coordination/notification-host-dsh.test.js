"use strict";

// dsh has no session-injection/wakeup surface in 0.2.1-rc.5. It must still be
// registered so the pump fails closed with an explicit capability error
// instead of the generic "adapter is not registered".
const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveAdapter } = require("../../lib/coordination/notification-host");
const { ADAPTER_WHITELIST } = require("../../lib/coordination/notification-cli");

test("dsh notification adapter: whitelisted, but explicitly deferred", async () => {
  assert.ok(ADAPTER_WHITELIST.includes("dsh"));
  const adapter = resolveAdapter("dsh", {});
  assert.equal(adapter.descriptor.adapterId, "dsh");
  assert.equal(adapter.descriptor.hostAvailable, false);
  const result = await adapter.deliver({ event: { eventId: "evt-dsh-1" } });
  assert.equal(result.status, "deferred");
  assert.equal(result.acknowledged, false);
  assert.equal(result.eventId, "evt-dsh-1");
  assert.equal(result.errorCode, "ERR_NOTIFICATION_ADAPTER_UNAVAILABLE");
});

test("unknown notification adapters still throw (fail closed)", () => {
  assert.throws(
    () => resolveAdapter("not-a-host", {}),
    (err) => err.code === "ERR_NOTIFICATION_ADAPTER",
  );
});
