"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  discoverNativeRuntimeEndpoint,
  mapLegacyTransport,
} = require(path.join(ROOT, "lib", "runtime-port", "native-endpoint.js"));

function adapter(overrides = {}) {
  return {
    discover() {
      return {
        adapter_type: "codex",
        version: "0.1.0",
        transport: "stdio-json-rpc",
        capabilities: ["text_generation"],
        ...overrides.discover,
      };
    },
    async health() {
      return overrides.health || { status: "ok", ready: true };
    },
    async invoke() {
      return { runId: "R-1", status: "ok", result: {} };
    },
    async cancel(runId) {
      return { runId, cancelled: true };
    },
    async report(runId) {
      return { runId, status: "ok", result: {} };
    },
  };
}

test("native adapter discovery maps to local HostRef and native RuntimeRef", async () => {
  const result = await discoverNativeRuntimeEndpoint(adapter(), {
    workspace_refs: ["workspace:WS-1"],
  });

  assert.equal(result.endpoint.host_ref, "host:local");
  assert.equal(result.endpoint.runtime_ref, "runtime:native:codex");
  assert.equal(result.endpoint.endpoint_ref, "runtime-endpoint:local:native:codex");
  assert.equal(result.endpoint.location, "local");
  assert.equal(result.endpoint.transport, "stdio");
  assert.equal(result.endpoint.availability, "available");
  assert.deepEqual(result.endpoint.workspace_refs, ["workspace:WS-1"]);
});

test("native endpoint availability comes from Adapter health", async () => {
  const result = await discoverNativeRuntimeEndpoint(adapter({
    health: { status: "down", ready: false, error: "missing" },
  }));
  assert.equal(result.endpoint.availability, "unavailable");
  assert.equal(result.health.error, "missing");
});

test("observer-only adapter endpoint does not advertise create/cancel", async () => {
  const result = await discoverNativeRuntimeEndpoint(adapter({
    discover: {
      adapter_type: "cursor",
      observer: true,
      invoke_supported: false,
      cancel_supported: false,
    },
  }));
  assert.equal(result.endpoint.runtime_ref, "runtime:native:cursor");
  assert.equal(result.endpoint.descriptor.capabilities.includes("runtime.run.create"), false);
  assert.equal(result.endpoint.descriptor.capabilities.includes("runtime.run.cancel"), false);
  assert.ok(result.endpoint.descriptor.capabilities.includes("runtime.run.status"));
});

test("health probing may be deferred without pretending availability", async () => {
  let healthCalls = 0;
  const value = adapter();
  value.health = async () => {
    healthCalls += 1;
    return { ready: true };
  };
  const result = await discoverNativeRuntimeEndpoint(value, { check_health: false });
  assert.equal(result.endpoint.availability, "unknown");
  assert.equal(result.health, null);
  assert.equal(healthCalls, 0);
});

test("legacy transport mapping is conservative", () => {
  assert.equal(mapLegacyTransport("stdio-json-rpc"), "stdio");
  assert.equal(mapLegacyTransport("https"), "http");
  assert.equal(mapLegacyTransport("websocket"), "websocket");
  assert.equal(mapLegacyTransport("vendor-magic"), "custom");
});
