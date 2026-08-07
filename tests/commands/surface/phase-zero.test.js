"use strict";

// ─── lib/commands/surface/phase-zero.js unit tests ────────────────────────────
//
// Coverage:
//   - re-exports phaseZeroAutomation from lib/automation-stubs
//   - the function still throws on unsupported Phase 0 commands
//   - the function emits JSON help when --help --json is given

const assert = require("node:assert/strict");
const test = require("node:test");
const surface = require("../../../lib/commands/surface/phase-zero");
const automationStubs = require("../../../lib/automation/stubs.js");

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

test("surface/phase-zero re-exports phaseZeroAutomation from automation-stubs", () => {
  assert.equal(typeof surface.phaseZeroAutomation, "function");
  assert.equal(surface.phaseZeroAutomation, automationStubs.phaseZeroAutomation);
});

test("surface/phase-zero: phaseZeroAutomation('dispatch', --help --json) emits help JSON", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    surface.phaseZeroAutomation({
      args: ["dispatch", "--help", "--json"],
      command: "dispatch",
      lang: "en",
    });
  } finally {
    const out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
  // exitCode should be unchanged on --help.
  assert.equal(process.exitCode, origExit);
  // The output captured before clearing — re-run with cleared state for assertion.
  process.exitCode = undefined;
  const { restore: restoreOut2 } = captureStdout();
  const { restore: restoreErr2 } = captureStderr();
  try {
    surface.phaseZeroAutomation({
      args: ["dispatch", "--help", "--json"],
      command: "dispatch",
      lang: "en",
    });
  } finally {
    const out = restoreOut2();
    restoreErr2();
    const parsed = JSON.parse(out);
    assert.equal(parsed.command, "dispatch");
    assert.equal(parsed.phase, 0);
    assert.equal(parsed.status, "stub");
  }
  process.exitCode = undefined;
});

test("surface/phase-zero: phaseZeroAutomation throws on unsupported command", () => {
  assert.throws(
    () => surface.phaseZeroAutomation({ args: [], command: "bogus", lang: "en" }),
    /Unsupported Phase 0 automation command/,
  );
});
