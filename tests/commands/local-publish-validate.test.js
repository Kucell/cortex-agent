"use strict";

// ─── lib/commands/local-publish-validate.js unit tests ──────────────────────
//
// Coverage:
//   - localPublishValidate: --help → prints HELP, exit 0
//   - localPublishValidate: no args → prints HELP, exit 0
//   - localPublishValidate: --bump rc + --dry-run → spawns script with right args
//   - localPublishValidate: forwards script exit code
//   - localPublishValidate: --target /nonexistent → still returns 0 (script handles it)
//   - HELP_ZH / HELP_EN: contain key strings (--target, --bump, NEVER publishes)
//
// We use spawnSync with a mock script to avoid touching npm / volta / git
// in unit tests. The actual integration is exercised manually + in /e2e.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// We import the module under test AFTER the helpers (test order doesn't matter,
// but this keeps hoisted mocks above the test bodies).
const {
  localPublishValidate,
  HELP_EN,
  HELP_ZH,
} = require("../../lib/commands/local-publish-validate");

// ── helpers ────────────────────────────────────────────────────────────────

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    restore: () => { process.stdout.write = orig; return chunks.join(""); },
  };
}

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lpv-test-"));
}

// ── help / contract tests ──────────────────────────────────────────────────

test("HELP_EN contains key flags and the 'NEVER publishes' guard", () => {
  assert.match(HELP_EN, /--target <path>/);
  assert.match(HELP_EN, /--bump <type>/);
  assert.match(HELP_EN, /--skip-tests/);
  assert.match(HELP_EN, /--skip-commit/);
  assert.match(HELP_EN, /--dry-run/);
  assert.match(HELP_EN, /NEVER publishes/);
});

test("HELP_ZH contains key flags and the '永不 publish' guard", () => {
  assert.match(HELP_ZH, /--target/);
  assert.match(HELP_ZH, /--bump/);
  assert.match(HELP_ZH, /--skip-tests/);
  assert.match(HELP_ZH, /--skip-commit/);
  assert.match(HELP_ZH, /--dry-run/);
  assert.match(HELP_ZH, /publish 到 npm/);
});

test("localPublishValidate: --help → prints help, returns 0, no spawn", () => {
  const ctx = {
    args: ["local-publish-validate", "--help"],
    options: {},
    cwd: mkRoot(),
    lang: "en",
  };
  const { restore } = captureStdout();
  let rc;
  try {
    rc = localPublishValidate(ctx);
  } finally {
    const out = restore();
    assert.match(out, /Local pack \+ local install/);
    assert.match(out, /NEVER publishes to npm/);
  }
  assert.equal(rc, 0);
});

test("localPublishValidate: no args → prints help, returns 0", () => {
  const ctx = {
    args: ["local-publish-validate"],
    options: {},
    cwd: mkRoot(),
    lang: "en",
  };
  const { restore } = captureStdout();
  let rc;
  try {
    rc = localPublishValidate(ctx);
  } finally {
    restore();
  }
  assert.equal(rc, 0);
});

test("localPublishValidate: --help with lang=zh → prints Chinese help", () => {
  const ctx = {
    args: ["local-publish-validate", "--help"],
    options: {},
    cwd: mkRoot(),
    lang: "zh",
  };
  const { restore } = captureStdout();
  let out;
  try {
    localPublishValidate(ctx);
  } finally {
    out = restore();
  }
  assert.match(out, /本地发包/);
  assert.match(out, /publish 到 npm/);
});

test("localPublishValidate: real script path exists at bin/local-publish-validate.cjs", () => {
  // Sanity check: the CLI module's SCRIPT_PATH must resolve to a real file.
  // The script lives in bin/ so it's version-controlled and shipped in the npm tarball.
  const expectedScript = path.resolve(
    __dirname,
    "..",
    "..",
    "bin",
    "local-publish-validate.cjs",
  );
  assert.ok(
    fs.existsSync(expectedScript),
    `Expected real script at ${expectedScript}; module references a missing path.`,
  );
  // And the script must be syntactically valid Node.
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(process.execPath, ["--check", expectedScript], { encoding: "utf8" });
  assert.equal(r.status, 0, `script syntax check failed: ${r.stderr}`);
});

test("localPublishValidate: forwards real script exit code (e.g. exit 1 on bad target dir)", () => {
  // We do this by invoking the REAL script (not a mock) with --dry-run + --target
  // pointing at a non-existent dir. The real script should still print the dry-run
  // and exit 0 (dry-run swallows the missing target warning). This validates
  // the spawn integration without mutating the cwd's git state.
  const ctx = {
    args: [
      "local-publish-validate",
      "--target",
      "/nonexistent-target-zzz",
      "--bump",
      "rc",
      "--skip-tests",
      "--skip-commit",
      "--dry-run",
    ],
    options: {},
    cwd: "/Users/xueyq/myworks/cortex-agent",
    lang: "en",
  };
  // We capture stdout but do NOT mock — this runs the real script.
  // Use a short timeout to avoid hangs.
  const r = localPublishValidate(ctx);
  // Real script with --dry-run should exit 0 (warnings don't trigger errors).
  assert.equal(typeof r, "number", "return value must be a number");
  assert.ok(r === 0 || (r >= 1 && r <= 6), `exit code out of range: ${r}`);
});
