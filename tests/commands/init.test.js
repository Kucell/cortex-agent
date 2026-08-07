"use strict";

// ─── lib/commands/init.js unit tests ──────────────────────────────────────────
//
// Coverage:
//   - init() early-fails when templateDir is missing
//
// Deeper coverage (the "select platforms + write files" path) lives in
// tests/init-mode-general.test.js and tests/init-mode-infer.test.js, which
// spawn `node bin/cli.js init` end-to-end. Unit-testing init() in isolation
// requires mocking 10+ dependencies (selectPlatformsInteractive,
// installPlatform, writeVersionFile, ensureXxx, …) which is not
// cost-effective vs. the existing end-to-end coverage.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { init } = require("../../lib/commands/init");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-init-test-"));
}

test("init: missing templateDir → process.exit(1) with 'Template directory not found'", async () => {
  const root = mkRoot();
  const templateDir = path.join(root, "no-such-template");
  const ctx = { cwd: root, lang: "en", templateDir, options: {} };

  const exitCalls = [];
  const errWrites = [];
  const origExit = process.exit;
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;
  // We throw a sentinel rather than letting process.exit(1) be a no-op,
  // because `init` keeps executing after a (mocked) exit and would
  // otherwise reach `selectPlatformsInteractive` which blocks on stdin.
  // `init` is async, so the thrown ExitSentinel becomes a rejected promise
  // that we await + catch below.
  const ExitSentinel = Symbol("exit");
  process.exit = (code) => { exitCalls.push(code); throw ExitSentinel; };
  process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
  try {
    try {
      await init(ctx);
    } catch (err) {
      if (err !== ExitSentinel) throw err;
    }
  } finally {
    process.exit = origExit;
    process.stderr.write = origErrWrite;
    process.exitCode = origExitCode;
  }

  assert.equal(exitCalls.length, 1, "process.exit must be called exactly once");
  assert.equal(exitCalls[0], 1, "process.exit code must be 1");
  assert.ok(
    errWrites.some((m) => m.includes("Template directory not found")),
    `expected 'Template directory not found' in stderr, got: ${JSON.stringify(errWrites)}`,
  );
  // Force-clear for child-process isolation.
  process.exitCode = undefined;
});
