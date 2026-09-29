"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  CAPABILITY_NAMESPACES,
  parseCapabilityId,
  isCapabilityId,
  validateCapabilityList,
} = require(path.join(ROOT, "packages", "protocol", "src", "capabilities.js"));

test("canonical capability ids are namespaced and closed to known namespaces", () => {
  assert.ok(CAPABILITY_NAMESPACES.includes("runtime"));
  assert.deepEqual(parseCapabilityId("runtime.run.create"), {
    id: "runtime.run.create",
    namespace: "runtime",
    segments: ["run", "create"],
  });
  assert.equal(parseCapabilityId("paseo.run.create"), null);
  assert.equal(parseCapabilityId("runtime"), null);
  assert.equal(isCapabilityId("topology.read", "topology"), true);
});

test("capability lists are deduplicated without reordering", () => {
  assert.deepEqual(
    validateCapabilityList(["runs.read", "tasks.read", "runs.read"]),
    ["runs.read", "tasks.read"],
  );
});

test("invalid capability ids fail closed", () => {
  assert.throws(
    () => validateCapabilityList(["runtime.run.create", "Paseo.Run"]),
    (error) => error.code === "ERR_CAPABILITY_ID_INVALID",
  );
});
