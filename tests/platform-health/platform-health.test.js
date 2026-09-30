"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const protocol = require(path.join(ROOT, "packages", "protocol", "src"));
const {
  createPackageProtocolHealthProducer,
} = require(path.join(ROOT, "lib", "platform-health", "package-protocol.js"));

function component(status, id = "package:test") {
  return {
    id,
    kind: "package",
    status,
    observed_at: "2026-09-30T01:20:00.000Z",
    producer: {
      id: "test",
      kind: "unit",
      version: "1.0",
    },
    checks: [],
    evidence_refs: [],
    redacted: true,
  };
}

test("PlatformHealth aggregation is deterministic and preserves unknown", () => {
  assert.equal(protocol.aggregateHealthStatus([]), "unknown");
  assert.equal(protocol.aggregateHealthStatus([component("healthy")]), "healthy");
  assert.equal(protocol.aggregateHealthStatus([component("unknown")]), "unknown");
  assert.equal(protocol.aggregateHealthStatus([
    component("healthy"),
    component("degraded", "package:b"),
  ]), "degraded");
  assert.equal(protocol.aggregateHealthStatus([
    component("degraded"),
    component("unhealthy", "package:b"),
  ]), "unhealthy");
});

test("PlatformHealth rejects an overall status inconsistent with component state", () => {
  assert.throws(
    () => protocol.normalizePlatformHealth({
      generated_at: "2026-09-30T01:20:00.000Z",
      overall: "healthy",
      components: [component("degraded")],
    }),
    (error) => error.code === "ERR_PLATFORM_HEALTH_AGGREGATION_MISMATCH",
  );
});

test("PlatformHealth details remain bounded scalar metadata", () => {
  const bad = component("healthy");
  bad.checks = [{
    id: "bad",
    status: "healthy",
    details: { nested: { secret: true } },
  }];
  assert.throws(
    () => protocol.normalizePlatformHealth({
      generated_at: "2026-09-30T01:20:00.000Z",
      components: [bad],
    }),
    (error) => error.code === "ERR_PLATFORM_HEALTH_DETAIL_VALUE",
  );
});

test("health producer owns no state and injects producer identity", async () => {
  const producer = protocol.createHealthProducer({
    id: "test.producer",
    kind: "unit",
    version: "1.0",
    async produce() {
      return [{
        id: "runtime:test",
        kind: "runtime",
        status: "unknown",
        observed_at: "2026-09-30T01:20:00.000Z",
        checks: [],
        evidence_refs: [],
        redacted: true,
      }];
    },
  });
  const result = await producer.produce();
  assert.equal(result[0].producer.id, "test.producer");
  assert.equal(result[0].status, "unknown");
});

test("package/protocol reference producer marks private 0.0.0 packages degraded", async () => {
  const fixtures = new Map([
    ["@cortex-agent/protocol", {
      name: "@cortex-agent/protocol",
      version: "0.0.0",
      private: true,
      exports: { ".": "./src/index.js" },
    }],
  ]);
  const producer = createPackageProtocolHealthProducer({
    async readPackage(name) {
      return fixtures.get(name) || null;
    },
  });
  const components = await producer.produce({
    now: "2026-09-30T01:20:00.000Z",
  });
  const pkg = components.find((item) => item.id === "package:@cortex-agent/protocol");
  const proto = components.find((item) => item.id === "protocol:cortex");
  assert.equal(pkg.status, "degraded");
  assert.equal(proto.status, "healthy");

  const snapshot = protocol.normalizePlatformHealth({
    generated_at: "2026-09-30T01:20:00.000Z",
    components,
  });
  assert.equal(snapshot.overall, "degraded");
});
