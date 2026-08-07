"use strict";

// ─── lib/commands/upgrade.js unit tests ────────────────────────────────────────
//
// Coverage:
//   - runSelfCheck: missing self-check script → null
//   - runScriptReconcile: apply=false in an empty project → returns report
//   - runScriptReconcile: scriptManifest.reconcileScripts throws → returns null
//   - upgrade: missing templateDir → process.exit(1) with 'Template directory not found'
//   - upgrade: missing .agent/ → process.exit(1) with 'No .agent directory found'
//
// Deeper coverage (dry-run / apply path, reconcile with real script
// candidates, full upgrade with template overlay, etc.) lives in the
// end-to-end suites under tests/. The unit tests here pin the early-fail
// contract and the helper-function contract; full lifecycle is exercised
// by the CLI tests in tests/integration.test.js (not the focus of T-FOLLOW-002 v2).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  runSelfCheck,
  runScriptReconcile,
  upgrade,
} = require("../../lib/commands/upgrade");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-upgrade-test-"));
}

// We need a real script-manifest module that reconcileScripts can scan, so
// the "templates/_lang/" + "templates/_shared/.agent" sibling layout has to
// exist.  An empty overlay + an empty shared layer is fine; the scan
// produces an empty list and reconcileScripts returns an empty report.
function setupEmptyTemplateLayout(root) {
  const langDir = path.join(root, "templates", "en");
  const sharedDir = path.join(root, "templates", "_shared", ".agent");
  fs.mkdirSync(path.join(langDir, ".agent"), { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  return { templateDir: langDir };
}

test("runSelfCheck: missing self-check script → returns null (no spawn)", () => {
  const root = mkRoot();
  // No .agent/skills/self-check/scripts/index.js created → early-return null.
  const res = runSelfCheck(root, "check-drift", false);
  assert.equal(res, null);
});

test("runScriptReconcile: apply=false in empty project → returns report (no candidates)", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const { templateDir } = setupEmptyTemplateLayout(root);
  const ctx = { cwd: root, templateDir, lang: "en" };

  // Empty overlay → reconcileScripts returns { updates: [], skipped: [], ... }.
  const report = runScriptReconcile(ctx, { apply: false, force: false });
  assert.ok(report, "report must not be null");
  assert.equal(Array.isArray(report.updates), true);
  assert.equal(Array.isArray(report.skipped), true);
  assert.equal(report.updates.length, 0);
  assert.equal(report.applied.length, 0);
});

test("runScriptReconcile: reconcileScripts throws → returns null (non-fatal)", () => {
  // The empty-template layout (or even a missing templateDir) does NOT make
  // reconcileScripts throw — discoverTemplateScriptEntries silently returns
  // an empty list and reconcileScripts returns an empty report.  We instead
  // monkey-patch scriptManifest.reconcileScripts to throw, which exercises
  // runScriptReconcile's catch-arm at line 247-249.
  const scriptManifest = require("../../lib/script-manifest");
  const origReconcile = scriptManifest.reconcileScripts;
  const origWarn = console.warn;
  const warnWrites = [];
  scriptManifest.reconcileScripts = () => { throw new Error("mocked failure"); };
  console.warn = (...args) => { warnWrites.push(args.join(" ")); };
  try {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
    const { templateDir } = setupEmptyTemplateLayout(root);
    const ctx = { cwd: root, templateDir, lang: "en" };
    const report = runScriptReconcile(ctx, { apply: false, force: false });
    assert.equal(report, null, "thrown reconcile must be swallowed to null");
    assert.ok(
      warnWrites.some((m) => m.includes("mocked failure")),
      `expected 'mocked failure' in console.warn, got: ${JSON.stringify(warnWrites)}`,
    );
  } finally {
    scriptManifest.reconcileScripts = origReconcile;
    console.warn = origWarn;
  }
});

test("upgrade: missing templateDir → process.exit(1) with 'Template directory not found'", () => {
  const root = mkRoot();
  const templateDir = path.join(root, "no-such-template");
  const ctx = { cwd: root, lang: "en", templateDir, options: {} };

  const exitCalls = [];
  const errWrites = [];
  const origExit = process.exit;
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;
  const ExitSentinel = Symbol("exit");
  process.exit = (code) => { exitCalls.push(code); throw ExitSentinel; };
  process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
  try {
    try {
      upgrade(ctx);
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
  process.exitCode = undefined;
});

test("upgrade: missing .agent/ directory → process.exit(1) with 'No .agent directory found'", () => {
  const root = mkRoot();
  const { templateDir } = setupEmptyTemplateLayout(root);
  // .agent/ intentionally NOT created.
  const ctx = { cwd: root, lang: "en", templateDir, options: {} };

  const exitCalls = [];
  const errWrites = [];
  const origExit = process.exit;
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;
  const ExitSentinel = Symbol("exit");
  process.exit = (code) => { exitCalls.push(code); throw ExitSentinel; };
  process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
  try {
    try {
      upgrade(ctx);
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
    errWrites.some((m) => m.includes("No .agent directory found")),
    `expected 'No .agent directory found' in stderr, got: ${JSON.stringify(errWrites)}`,
  );
  process.exitCode = undefined;
});

test("upgrade: missing templateDir → process.exit(1) with 'Template directory not found' (zh)", () => {
  // Mirror the en test but with lang=zh to pin the bilingual error message.
  const root = mkRoot();
  const templateDir = path.join(root, "no-such-template");
  const ctx = { cwd: root, lang: "zh", templateDir, options: {} };

  const exitCalls = [];
  const errWrites = [];
  const origExit = process.exit;
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExitCode = process.exitCode;
  const ExitSentinel = Symbol("exit");
  process.exit = (code) => { exitCalls.push(code); throw ExitSentinel; };
  process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
  try {
    try {
      upgrade(ctx);
    } catch (err) {
      if (err !== ExitSentinel) throw err;
    }
  } finally {
    process.exit = origExit;
    process.stderr.write = origErrWrite;
    process.exitCode = origExitCode;
  }

  assert.equal(exitCalls.length, 1);
  assert.equal(exitCalls[0], 1);
  assert.ok(
    errWrites.some((m) => m.includes("Template directory not found")),
    `expected 'Template directory not found' in stderr (zh ctx), got: ${JSON.stringify(errWrites)}`,
  );
  process.exitCode = undefined;
});
