"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const gate = require(path.join(ROOT, "scripts", "m040", "check-regression-baseline.js"));

test("M-040 regression baseline is pinned to the merge base", () => {
  assert.equal(gate.BASELINE_SHA, "d9251d953a8b663b86b7712624baaac649924e46");
  assert.equal(gate.BASELINE_FAILURES.length, 14);
  assert.equal(gate.BASELINE_FAILURES.includes("commands/management/query.test.js"), false);
});

test("baseline-diff gate permits existing failures and improvements", () => {
  const result = gate.compareFailures([
    "agent/agent-cli.test.js",
    "commands/doctor.test.js",
  ]);
  assert.equal(result.regression_free, true);
  assert.equal(result.unexpected_failures.length, 0);
  assert.equal(result.healed_baseline_failures.length, 12);
});

test("baseline-diff gate blocks a new failure", () => {
  const result = gate.compareFailures([
    "agent/agent-cli.test.js",
    "commands/management/query.test.js",
  ]);
  assert.equal(result.regression_free, false);
  assert.deepEqual(result.unexpected_failures, ["commands/management/query.test.js"]);
});

test("failure parser extracts unique test files from test-runner output", () => {
  const parsed = gate.parseFailures([
    "  ✗ FAIL  agent/agent-cli.test.js  (1ms)",
    "  ✗ FAIL  commands/doctor.test.js  (2ms)",
    "  ✗ FAIL  agent/agent-cli.test.js  (3ms)",
  ].join("\n"));
  assert.deepEqual(parsed, [
    "agent/agent-cli.test.js",
    "commands/doctor.test.js",
  ]);
});
