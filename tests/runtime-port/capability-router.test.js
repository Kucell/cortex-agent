"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  routeRuntimeEndpoints,
} = require(path.join(ROOT, "lib", "runtime-port", "capability-router.js"));

const NOW = "2026-09-29T04:00:00.000Z";

function endpoint(name, overrides = {}) {
  return {
    endpoint_ref: `runtime-endpoint:local:native:${name}`,
    host_ref: "host:local",
    runtime_ref: `runtime:native:${name}`,
    location: "local",
    transport: "stdio",
    availability: "available",
    descriptor: {
      protocol: "cortex-runtime",
      protocol_version: "1.0",
      implementation: `native-adapter:${name}`,
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

function snapshot(profile, reliability, overrides = {}) {
  return {
    schema_version: "1.0",
    snapshot_id: `SNAP-${profile}`,
    host_profile_ref: profile,
    taken_at: "2026-09-29T03:59:00.000Z",
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
      "tool.update": "adapter",
    },
    governance: { approved: true, decision_id: "D-1" },
    lease: { active: true, holder: "owner" },
    reliability: { value: reliability, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.2, source: "explicit-workflow", quality: "high" },
    latency: { value: 100, source: "explicit-workflow", quality: "high" },
    ...overrides,
  };
}

function hostRequirement(overrides = {}) {
  return {
    schema_version: "1.0",
    requirement_id: "HOST-REQ-1",
    task_id: "T-1",
    created_at: "2026-09-29T03:58:00.000Z",
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: {
      approved_decision_id: "D-1",
      require_active_lease: true,
    },
    preferred: {},
    ttl_at: "2026-09-29T05:00:00.000Z",
    ...overrides,
  };
}

function runtimeRequirement(overrides = {}) {
  return {
    requirement_id: "RUNTIME-REQ-1",
    required_capabilities: ["runtime.run.create"],
    workspace_ref: "workspace:WS-1",
    ...overrides,
  };
}

test("composite routing filters runtime capabilities then reuses existing host matcher", () => {
  const result = routeRuntimeEndpoints({
    runtime_requirement: runtimeRequirement(),
    endpoints: [endpoint("codex"), endpoint("claude-code")],
    host_requirement: hostRequirement(),
    bindings: [
      { endpoint_ref: "runtime-endpoint:local:native:codex", snapshot: snapshot("H-codex", 0.95) },
      { endpoint_ref: "runtime-endpoint:local:native:claude-code", snapshot: snapshot("H-claude", 0.7) },
    ],
  }, { now: NOW });

  assert.equal(result.selection.endpoint_ref, "runtime-endpoint:local:native:codex");
  assert.equal(result.selection.host_ref, "host:local");
  assert.equal(result.selection.runtime_ref, "runtime:native:codex");
  assert.equal(result.selection.host_profile_ref, "H-codex");
  assert.equal(result.authorization.authorized, false);
  assert.equal(result.authorization.reason, "routing_is_not_authorization");
});

test("explicit endpoint failure never silently falls back to another runtime", () => {
  const result = routeRuntimeEndpoints({
    runtime_requirement: runtimeRequirement({
      endpoint_ref: "runtime-endpoint:local:native:claude-code",
    }),
    endpoints: [endpoint("codex"), endpoint("claude-code")],
    host_requirement: hostRequirement(),
    bindings: [
      { endpoint_ref: "runtime-endpoint:local:native:codex", snapshot: snapshot("H-codex", 0.95) },
      {
        endpoint_ref: "runtime-endpoint:local:native:claude-code",
        snapshot: snapshot("H-claude", 0.7, {
          capabilities: {
            "session.boundary": "native",
            "tool.before.block": "unsupported",
          },
        }),
      },
    ],
  }, { now: NOW });

  assert.equal(result.selection, null);
  assert.equal(result.runtime_filter.accepted.length, 1);
  assert.equal(
    result.runtime_filter.accepted[0].endpoint_ref,
    "runtime-endpoint:local:native:claude-code",
  );
  assert.ok(result.host_plan.candidates[0].rejected_reasons.some(
    (reason) => reason.includes("tool.before.block"),
  ));
});

test("endpoint with no host snapshot is visible but cannot be selected", () => {
  const result = routeRuntimeEndpoints({
    runtime_requirement: runtimeRequirement(),
    endpoints: [endpoint("codex")],
    host_requirement: hostRequirement(),
    bindings: [],
  }, { now: NOW });

  assert.equal(result.selection, null);
  assert.deepEqual(
    result.missing_snapshot_endpoints,
    ["runtime-endpoint:local:native:codex"],
  );
  assert.equal(result.host_plan.candidates.length, 0);
});

test("duplicate host profile bindings fail closed", () => {
  assert.throws(
    () => routeRuntimeEndpoints({
      runtime_requirement: runtimeRequirement(),
      endpoints: [endpoint("codex"), endpoint("claude-code")],
      host_requirement: hostRequirement(),
      bindings: [
        { endpoint_ref: "runtime-endpoint:local:native:codex", snapshot: snapshot("H-shared", 0.9) },
        { endpoint_ref: "runtime-endpoint:local:native:claude-code", snapshot: snapshot("H-shared", 0.8) },
      ],
    }, { now: NOW }),
    (error) => error.code === "ERR_RUNTIME_HOST_BINDING_AMBIGUOUS",
  );
});
