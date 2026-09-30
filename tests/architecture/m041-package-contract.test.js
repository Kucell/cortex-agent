"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  PACKAGE_DECISIONS,
  runPackageContractAudit,
} = require(path.join(ROOT, "scripts", "m041", "package-contract-audit.js"));

test("M-041 classifies every workspace contract package", () => {
  assert.deepEqual(Object.keys(PACKAGE_DECISIONS).sort(), [
    "@cortex-agent/extension-sdk",
    "@cortex-agent/project-sdk",
    "@cortex-agent/protocol",
    "@cortex-agent/runtime-paseo",
    "@cortex-agent/runtime-port",
    "@cortex-agent/sdk",
  ]);
});

test("public package contract audit passes without governance leakage", () => {
  const result = runPackageContractAudit();
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.equal(result.root.issues.length, 0);
  assert.equal(result.policy.publication_during_ms001, false);
});

test("runtime-paseo remains deferred while core contracts are public candidates", () => {
  const result = runPackageContractAudit();
  const paseo = result.packages.find((item) => item.name === "@cortex-agent/runtime-paseo");
  const protocol = result.packages.find((item) => item.name === "@cortex-agent/protocol");
  assert.equal(paseo.decision, "deferred-public-candidate");
  assert.equal(protocol.decision, "public-candidate");
  assert.equal(protocol.private, true);
  assert.equal(protocol.version, "0.0.0");
});
