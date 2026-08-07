"use strict";

// ─── lib/commands/session.js unit tests ───────────────────────────────────────
//
// Coverage:
//   - printSessionHelp: emits "Usage" + "Subcommands" + all 10 subcommand names
//   - printSessionHelp: emits the 10th (list-contexts) subcommand — guards
//     against accidental drops in the SESSION_SUBCOMMANDS list
//   - runSession: no subcommand (or --help / -h) → prints help, no exit code
//   - runSession: unknown subcommand → process.exitCode = 2, stderr message
//   - runSession: missing script (template path broken) → process.exitCode = 3
//   - SESSION_SUBCOMMANDS export has 10 entries with `name` and `desc`
//   - SESSION_SUBCOMMAND_SET export mirrors SESSION_SUBCOMMANDS names

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  runSession,
  printSessionHelp,
  SESSION_SUBCOMMANDS,
  SESSION_SUBCOMMAND_SET,
} = require("../../lib/commands/session");

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

test("printSessionHelp: emits 'Usage' + 'Subcommands' header lines", () => {
  const { restore } = captureStdout();
  let out = "";
  try {
    printSessionHelp();
  } finally {
    out = restore();
  }
  assert.match(out, /Usage: cortex-agent session <subcommand> \[options\]/);
  assert.match(out, /Subcommands \(10\):/);
});

test("printSessionHelp: lists all 10 subcommand names", () => {
  const { restore } = captureStdout();
  let out = "";
  try {
    printSessionHelp();
  } finally {
    out = restore();
  }
  const expectedNames = [
    "assess",
    "log",
    "checkpoint",
    "archive",
    "restore",
    "resume-bundle",
    "status",
    "warm",
    "host-switch",
    "list-contexts",
  ];
  for (const name of expectedNames) {
    assert.match(
      out,
      new RegExp(`\\b${name}\\b`),
      `expected subcommand '${name}' in help output`,
    );
  }
});

test("SESSION_SUBCOMMANDS: 10 entries, each with name + desc", () => {
  assert.equal(SESSION_SUBCOMMANDS.length, 10);
  for (const entry of SESSION_SUBCOMMANDS) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0, "name must be non-empty");
    assert.equal(typeof entry.desc, "string");
    assert.ok(entry.desc.length > 0, "desc must be non-empty");
  }
});

test("SESSION_SUBCOMMAND_SET: contains every SESSION_SUBCOMMANDS name", () => {
  for (const entry of SESSION_SUBCOMMANDS) {
    assert.equal(
      SESSION_SUBCOMMAND_SET.has(entry.name),
      true,
      `SESSION_SUBCOMMAND_SET must contain '${entry.name}'`,
    );
  }
  assert.equal(SESSION_SUBCOMMAND_SET.size, SESSION_SUBCOMMANDS.length);
});

test("runSession: no subcommand → prints help, no process.exitCode change", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  let out = "";
  try {
    // args[1] is undefined → triggers the help branch.
    runSession(["session"]);
  } finally {
    out = restoreOut();
    restoreErr();
  }
  assert.match(out, /Usage: cortex-agent session/);
  assert.equal(process.exitCode, origExitCode, "exit code must not change on no-subcommand");
  process.exitCode = undefined;
});

test("runSession: --help → prints help, no process.exitCode change", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  let out = "";
  try {
    runSession(["session", "--help"]);
  } finally {
    out = restoreOut();
    restoreErr();
  }
  assert.match(out, /Subcommands \(10\):/);
  assert.equal(process.exitCode, origExitCode);
  process.exitCode = undefined;
});

test("runSession: -h → prints help, no process.exitCode change", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  let out = "";
  try {
    runSession(["session", "-h"]);
  } finally {
    out = restoreOut();
    restoreErr();
  }
  assert.match(out, /Subcommands \(10\):/);
  assert.equal(process.exitCode, origExitCode);
  process.exitCode = undefined;
});

test("runSession: unknown subcommand → process.exitCode = 2 + stderr message", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  let err = "";
  try {
    runSession(["session", "definitely-not-a-real-subcommand"]);
  } finally {
    restoreOut();
    err = restoreErr();
  }
  assert.equal(process.exitCode, 2, "unknown subcommand must set exitCode=2");
  assert.match(err, /Unknown session subcommand: definitely-not-a-real-subcommand/);
  assert.match(err, /cortex-agent session --help/);
  process.exitCode = origExitCode;
});

test("runSession: known subcommand with missing script → process.exitCode = 3", () => {
  // The real templates/_shared/.agent/skills/runtime-continuity/scripts/index.js
  // exists in the working tree; force the missing-script branch by pointing
  // __dirname at a tmpdir where that path does NOT resolve.  Easiest:
  // monkey-patch fs.existsSync to return false for that specific path.
  // We restore the original in `finally`.
  const realExists = fs.existsSync;
  const target = path.join(
    path.resolve(__dirname, "..", ".."),
    "templates",
    "_shared",
    ".agent",
    "skills",
    "runtime-continuity",
    "scripts",
    "index.js",
  );
  fs.existsSync = (p) => {
    if (typeof p === "string" && p === target) return false;
    return realExists(p);
  };

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  let err = "";
  try {
    runSession(["session", "status"]);
  } catch (e) {
    // If a child process were spawned, this could throw — but the
    // missing-script branch returns early, so we should not get here.
    fs.existsSync = realExists;
    throw e;
  } finally {
    restoreOut();
    err = restoreErr();
    fs.existsSync = realExists;
  }
  assert.equal(process.exitCode, 3, "missing script must set exitCode=3");
  assert.match(err, /runtime-continuity script not found at/);
  assert.match(err, /cortex-agent doctor/);
  process.exitCode = origExitCode;
});
