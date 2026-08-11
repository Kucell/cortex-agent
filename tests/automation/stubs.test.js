"use strict";

// Coverage for lib/automation/stubs.js — Phase 0 stub command behavior.

const assert = require("node:assert/strict");
const { describe, test, beforeEach, afterEach } = require("node:test");

const { phaseZeroAutomation } = require("../../lib/automation/stubs.js");

// Capture console output per test.
let logs = [];
let errors = [];
let origLog;
let origError;
let savedExitCode;

beforeEach(() => {
  logs = [];
  errors = [];
  origLog = console.log;
  origError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  savedExitCode = process.exitCode;
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
  process.exitCode = savedExitCode;
});

describe("automation/stubs — discovery (--help)", () => {
  test("--help --json prints a stub payload with contract metadata", () => {
    phaseZeroAutomation({ args: ["--help", "--json"], command: "dispatch", lang: "en" });
    assert.equal(logs.length, 1);
    const payload = JSON.parse(logs[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "stub");
    assert.equal(payload.implemented, false);
    assert.equal(payload.side_effects, false);
    assert.ok(payload.contract && payload.contract.name === "dispatch");
  });

  test("--help without --json prints usage in English", () => {
    phaseZeroAutomation({ args: ["--help"], command: "daemon", lang: "en" });
    assert.ok(logs.some((line) => line.includes("Usage:")));
    assert.ok(logs.some((line) => line.includes("Phase 0 contract stub")));
  });

  test("-h prints localized Chinese usage when lang=zh", () => {
    phaseZeroAutomation({ args: ["-h"], command: "trigger", lang: "zh" });
    assert.ok(logs.some((line) => line.includes("Phase 0 契约 stub")));
  });
});

describe("automation/stubs — execution refuses to implement", () => {
  test("execution with --json prints not_implemented payload and exits 2", () => {
    phaseZeroAutomation({ args: ["--json"], command: "dispatch", lang: "en" });
    const payload = JSON.parse(logs[0]);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "not_implemented");
    assert.equal(payload.error.code, "PHASE_ZERO_STUB");
    assert.equal(payload.next_step, "cortex-agent help dispatch --json");
    assert.equal(process.exitCode, 2);
  });

  test("execution without --json writes a localized error and exits 2", () => {
    phaseZeroAutomation({ args: [], command: "daemon", lang: "zh" });
    assert.ok(errors.some((line) => line.includes("尚未实现")));
    assert.equal(process.exitCode, 2);
  });
});

describe("automation/stubs — unsupported commands", () => {
  test("throws for a command outside the Phase 0 whitelist", () => {
    assert.throws(
      () => phaseZeroAutomation({ args: [], command: "rm-rf", lang: "en" }),
      /Unsupported Phase 0 automation command: rm-rf/,
    );
  });
});
