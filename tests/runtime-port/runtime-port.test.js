"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const runtime = require(path.join(ROOT, "packages", "runtime-port", "src"));

function descriptor(capabilities) {
  return {
    protocol: "cortex-runtime",
    protocol_version: "1.0",
    implementation: "test-runtime",
    capabilities,
  };
}

test("RuntimePort requires an implementation for every declared capability", () => {
  assert.throws(
    () => runtime.createRuntimePort({
      descriptor: descriptor(["runtime.health"]),
      operations: {},
    }),
    (error) => error.code === "ERR_RUNTIME_OPERATION_MISSING",
  );
});

test("RuntimePort exposes unsupported operations explicitly", () => {
  const port = runtime.createRuntimePort({
    descriptor: descriptor(["runtime.health"]),
    operations: {
      health() { return { ready: true }; },
    },
  });

  assert.deepEqual(port.health(), { ready: true });
  assert.equal(runtime.hasRuntimeCapability(port, "runtime.run.send"), false);
  assert.throws(
    () => port.send("run:x", { message: "hello" }),
    (error) => error.code === "ERR_RUNTIME_CAPABILITY_UNSUPPORTED"
      && error.details.capability === "runtime.run.send",
  );
});

test("RuntimePort rejects non-runtime protocol descriptors", () => {
  assert.throws(
    () => runtime.createRuntimePort({
      descriptor: {
        protocol: "cortex-project",
        protocol_version: "1.0",
        implementation: "wrong",
        capabilities: ["project.validation.run"],
      },
      operations: {},
    }),
    (error) => error.code === "ERR_RUNTIME_PROTOCOL_REQUIRED",
  );
});
