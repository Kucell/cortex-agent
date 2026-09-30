"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const runtime = require(path.join(ROOT, "packages", "runtime-port", "src"));

function endpoint(overrides = {}) {
  return {
    endpoint_ref: "runtime-endpoint:local:native:codex",
    host_ref: "host:local",
    runtime_ref: "runtime:native:codex",
    location: "local",
    transport: "stdio",
    availability: "available",
    descriptor: {
      protocol: "cortex-runtime",
      protocol_version: "1.0",
      implementation: "native-adapter:codex",
      capabilities: [
        "runtime.discover",
        "runtime.health",
        "runtime.run.create",
        "runtime.run.status",
      ],
    },
    workspace_refs: ["workspace:WS-1"],
    ...overrides,
  };
}

test("RuntimeEndpoint keeps machine HostRef separate from RuntimeRef", () => {
  const value = runtime.normalizeRuntimeEndpoint(endpoint());
  assert.equal(value.host_ref, "host:local");
  assert.equal(value.runtime_ref, "runtime:native:codex");
  assert.equal(value.endpoint_ref, "runtime-endpoint:local:native:codex");
});

test("RuntimeEndpoint accepts only runtime capability namespace", () => {
  assert.throws(
    () => runtime.normalizeRuntimeEndpoint(endpoint({
      descriptor: {
        protocol: "cortex-runtime",
        protocol_version: "1.0",
        implementation: "bad",
        capabilities: ["project.validation.run"],
      },
    })),
    (error) => error.code === "ERR_RUNTIME_CAPABILITY_NAMESPACE",
  );
});

test("RuntimeRequirement hard-filters capabilities, availability and workspace", () => {
  const result = runtime.filterRuntimeEndpoints({
    requirement_id: "REQ-1",
    required_capabilities: ["runtime.run.create"],
    workspace_ref: "workspace:WS-1",
  }, [
    endpoint(),
    endpoint({
      endpoint_ref: "runtime-endpoint:remote:paseo",
      host_ref: "host:linux-server",
      runtime_ref: "runtime:paseo:linux-server",
      location: "remote",
      transport: "websocket",
      availability: "unknown",
      workspace_refs: [],
    }),
  ]);

  assert.deepEqual(
    result.accepted.map((item) => item.endpoint_ref),
    ["runtime-endpoint:local:native:codex"],
  );
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].reasons.some((reason) => reason.code === "runtime_unavailable"));
  assert.ok(result.rejected[0].reasons.some((reason) => reason.code === "workspace_unavailable"));
});

test("explicit endpoint selection never silently falls back", () => {
  const result = runtime.filterRuntimeEndpoints({
    requirement_id: "REQ-explicit",
    endpoint_ref: "runtime-endpoint:remote:paseo",
    required_capabilities: ["runtime.run.create"],
    require_available: false,
  }, [
    endpoint(),
    endpoint({
      endpoint_ref: "runtime-endpoint:remote:paseo",
      host_ref: "host:linux-server",
      runtime_ref: "runtime:paseo:linux-server",
      location: "remote",
      transport: "websocket",
      availability: "unknown",
    }),
  ]);

  assert.deepEqual(
    result.accepted.map((item) => item.endpoint_ref),
    ["runtime-endpoint:remote:paseo"],
  );
  const local = result.rejected.find(
    (item) => item.endpoint.endpoint_ref === "runtime-endpoint:local:native:codex",
  );
  assert.ok(local.reasons.some((reason) => reason.code === "endpoint_mismatch"));
});

test("unknown RuntimeEndpoint fields fail closed", () => {
  assert.throws(
    () => runtime.normalizeRuntimeEndpoint(endpoint({ vendor_magic: true })),
    (error) => error.code === "ERR_RUNTIME_TOPOLOGY_FIELD_UNKNOWN",
  );
});
