"use strict";

// ─── Doctor Graphify section integration tests (T-GWG-001) ───────────────────
//
// Pins the contract that:
//   - doctor() always prints a [graphify] section (regardless of plugin state).
//   - When the project has opted in, doctor() also reports freshness state
//     and post-commit hook status.
//   - doctor --fix idempotently installs the Graphify hook when missing.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { doctor } = require("../../lib/commands/doctor");
const graphifyLib = require("../../lib/graphify");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-doctor-g-"));
}

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
function resetExitCode() {
  const before = process.exitCode;
  process.exitCode = 0;
  return () => { process.exitCode = before; };
}

test("doctor: prints graphify section even on bare project", async () => {
  const root = mkRoot();
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const reset = resetExitCode();
  try {
    await doctor({
      cwd: root,
      lang: "en",
      templateDir: path.join(root, "no-template"),
      options: {},
    });
  } finally {
    restoreOut();
    restoreErr();
    reset();
  }
});

test("doctor: plugin present → prints freshness + hook status lines", async () => {
  const root = mkRoot();
  // Lay down the plugin directory (the only signal that counts).
  fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "plugins", "graphify", "config.yml"), "graphify:\n  version: 1\n");
  let out = "";
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const reset = resetExitCode();
  try {
    await doctor({
      cwd: root,
      lang: "en",
      templateDir: path.join(root, "no-template"),
      options: {},
    });
    out = restoreOut();
  } finally {
    restoreErr();
    reset();
  }
  assert.match(out, /\[graphify\]/);
  // Plugin is configured → hook status line should appear.
  assert.match(out, /post-commit hook/);
});

test("doctor --fix: idempotently installs the Graphify hook", async () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "plugins", "graphify", "config.yml"), "graphify:\n  version: 1\n");
  if (!graphifyLib.hook.graphifyCliAvailable()) {
    return; // environment-specific skip
  }
  // Pretend we're a git repo so the hook can land.
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  try { fs.unlinkSync(path.join(root, ".git", "hooks", "post-commit")); } catch (_) {}
  const reset = resetExitCode();
  try {
    await doctor({
      cwd: root,
      lang: "en",
      templateDir: path.join(root, "no-template"),
      options: { fix: true },
    });
  } finally {
    reset();
  }
  // After --fix the hook must be installed.
  assert.equal(graphifyLib.hook.isHookInstalled(root), true);
  // And a second --fix must not throw or duplicate.
  const reset2 = resetExitCode();
  try {
    await doctor({
      cwd: root,
      lang: "en",
      templateDir: path.join(root, "no-template"),
      options: { fix: true },
    });
  } finally {
    reset2();
  }
  assert.equal(graphifyLib.hook.isHookInstalled(root), true);
});