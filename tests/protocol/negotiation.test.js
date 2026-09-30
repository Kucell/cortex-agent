"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const protocol = require(path.join(ROOT, "packages", "protocol", "src"));

function descriptor(overrides = {}) {
  return {
    protocol: "cortex-runtime",
    protocol_version: "1.0",
    implementation: "test-runtime",
    implementation_version: "0.1.0",
    capabilities: [
      "runtime.run.create",
      "runtime.run.cancel",
      "runtime.timeline.read",
    ],
    ...overrides,
  };
}

test("protocol versions parse and compare deterministically", () => {
  assert.deepEqual(protocol.parseProtocolVersion("1.12"), { raw: "1.12", major: 1, minor: 12 });
  assert.equal(protocol.parseProtocolVersion("v1.0"), null);
  assert.equal(protocol.compareProtocolVersions("1.2", "1.3"), -1);
  assert.equal(protocol.compareProtocolVersions("2.0", "1.99"), 1);
});

test("same-major negotiation uses the lower common minor and capability intersection", () => {
  const result = protocol.negotiateProtocol(
    descriptor({ protocol_version: "1.3" }),
    descriptor({
      protocol_version: "1.1",
      implementation: "remote",
      capabilities: ["runtime.run.create", "runtime.timeline.read"],
    }),
    { required_capabilities: ["runtime.run.create"] },
  );
  assert.equal(result.negotiated_version, "1.1");
  assert.equal(result.local_newer, true);
  assert.deepEqual(result.capabilities, ["runtime.run.create", "runtime.timeline.read"]);
});

test("major version mismatch fails closed", () => {
  assert.throws(
    () => protocol.negotiateProtocol(
      descriptor({ protocol_version: "1.4" }),
      descriptor({ protocol_version: "2.0", implementation: "remote" }),
    ),
    (error) => error.code === "ERR_PROTOCOL_MAJOR_MISMATCH",
  );
});

test("missing required capability fails closed", () => {
  assert.throws(
    () => protocol.negotiateProtocol(
      descriptor(),
      descriptor({ implementation: "remote", capabilities: ["runtime.timeline.read"] }),
      { required_capabilities: ["runtime.run.cancel"] },
    ),
    (error) => error.code === "ERR_REQUIRED_CAPABILITY_MISSING"
      && error.details.missing.includes("runtime.run.cancel"),
  );
});

test("deprecations are explicit metadata and only apply to provided capabilities", () => {
  const local = descriptor({
    deprecated_capabilities: [{
      id: "runtime.run.cancel",
      replacement: "runtime.run.stop",
      remove_in: "2.0",
      reason: "unify stop semantics",
    }],
  });
  const remote = descriptor({ implementation: "remote" });
  const result = protocol.negotiateProtocol(local, remote);
  assert.equal(result.deprecated_capabilities.length, 1);
  assert.equal(result.deprecated_capabilities[0].source, "local");
  assert.equal(result.deprecated_capabilities[0].replacement, "runtime.run.stop");
});

test("descriptor rejects unknown protocol fields", () => {
  assert.throws(
    () => protocol.createCapabilityDescriptor({ ...descriptor(), vendor_magic: true }),
    (error) => error.code === "ERR_PROTOCOL_FIELD_UNKNOWN",
  );
});
