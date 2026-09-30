"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  runArchitectureGuard,
} = require(path.join(ROOT, "scripts", "m040", "architecture-guard.js"));

test("M-040 architecture dependency and ownership guards pass", () => {
  const result = runArchitectureGuard();
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});
