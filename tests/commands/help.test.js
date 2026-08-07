"use strict";

// ─── lib/commands/help.js unit tests ──────────────────────────────────────────
//
// Coverage:
//   - printHelp(): emits "Usage" + "Commands" + "Options" + "Available platforms"
//   - printHelp(): lists every registered command
//   - cliHelp(ctx): no topic → emits full contract JSON, ok=true, command="help"
//   - cliHelp(ctx): unknown topic → emits error JSON, process.exitCode = 2
//   - cliHelp(ctx): valid topic → emits filtered contract with one command
//
// (The original `cliHelp` in lib/commands.js always emits JSON via
// `printManagementPayload`; the function does NOT inspect ctx.options.json.
// Strict-copy rule wins: tests pin the actual behavior, not the "options.json
// mode" described in the parent prompt's spec.)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { cliHelp, printHelp } = require("../../lib/commands/help");

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

test("printHelp: contains 'Usage' + 'Commands' + 'Options' + 'Available platforms'", () => {
  const { restore: restoreOut } = captureStdout();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    printHelp();
  } finally {
    const out = restoreOut();
    process.exitCode = origExitCode;
    assert.match(out, /Usage: cortex-agent/);
    assert.match(out, /\nCommands:/);
    assert.match(out, /\nOptions:/);
    assert.match(out, /\nAvailable platforms:/);
  }
});

test("printHelp: lists every entry from cliContract.commands", () => {
  const cliContract = require("../../lib/cli-contract");
  const { restore: restoreOut } = captureStdout();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    printHelp();
  } finally {
    const out = restoreOut();
    process.exitCode = origExitCode;
    for (const cmd of cliContract.commands) {
      assert.match(out, new RegExp(cmd.usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("printHelp: lists every entry from PLATFORM_REGISTRY", () => {
  const { PLATFORM_REGISTRY } = require("../../lib/registry");
  const { restore: restoreOut } = captureStdout();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    printHelp();
  } finally {
    const out = restoreOut();
    process.exitCode = origExitCode;
    for (const [key, p] of Object.entries(PLATFORM_REGISTRY)) {
      assert.match(out, new RegExp(`\\b${key}\\b`));
      assert.match(out, new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("cliHelp: no topic → emits full contract JSON, ok=true, command=help", () => {
  const ctx = { args: ["help"], options: {}, cwd: "/tmp", lang: "en" };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    cliHelp(ctx);
  } finally {
    const out = restoreOut();
    restoreErr();
    process.exitCode = origExitCode;
    // Output is a JSON payload (single line or pretty-printed).
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "help");
    assert.ok(parsed.contract, "must include contract");
    assert.ok(Array.isArray(parsed.contract.commands), "contract.commands is an array");
    assert.ok(parsed.contract.commands.length > 0, "full contract has at least one command");
  }
});

test("cliHelp: unknown topic → emits error JSON, process.exitCode = 2", () => {
  const ctx = { args: ["help", "no-such-topic"], options: {}, cwd: "/tmp", lang: "en" };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  let observedExit;
  try {
    cliHelp(ctx);
  } finally {
    observedExit = process.exitCode;
    const out = restoreOut();
    restoreErr();
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "UNKNOWN_HELP_TOPIC");
    assert.match(parsed.error.message, /no-such-topic/);
  }
  assert.equal(observedExit, 2);
  process.exitCode = origExitCode; // restore for child-process isolation
});

test("cliHelp: valid topic → emits filtered contract with single command", () => {
  const ctx = { args: ["help", "init"], options: {}, cwd: "/tmp", lang: "en" };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    cliHelp(ctx);
  } finally {
    const out = restoreOut();
    restoreErr();
    process.exitCode = origExitCode;
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "help");
    assert.equal(parsed.contract.commands.length, 1, "filtered list must contain exactly one command");
    assert.equal(parsed.contract.commands[0].name, "init");
  }
});

test("cliHelp: package.json version is included in the payload", () => {
  const PKG_VERSION = require("../../package.json").version;
  const ctx = { args: ["help"], options: {}, cwd: "/tmp", lang: "en" };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    cliHelp(ctx);
  } finally {
    const out = restoreOut();
    restoreErr();
    process.exitCode = origExitCode;
    const parsed = JSON.parse(out);
    assert.equal(parsed.version, PKG_VERSION);
  }
});
