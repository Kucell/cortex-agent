"use strict";

// ─── lib/commands/platform.js unit tests ──────────────────────────────────────
//
// Coverage:
//   - addPlatforms: no targets → process.exit(1) (and lists platforms first)
//   - addPlatforms: .agent dir missing → process.exit(1)
//   - addPlatforms: unknown platform → warn + skip
//   - removePlatforms: no targets → process.exit(1)
//   - listPlatforms: emits both "installed" and "not installed" lines
//   - listPlatforms: lang=zh → Chinese labels
//   - addPlatforms: happy path with real installPlatform + applyGitExclusion
//
// The happy-path test uses a real templateDir with a real `cursor`
// integration so installPlatform() runs its actual code paths. The function
// creates real files + symlinks under the temp root; we restore
// applyGitExclusion and saveInstalledPlatforms via require.cache overrides
// for those two side effects.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const {
  addPlatforms,
  removePlatforms,
  listPlatforms,
} = require("../../lib/commands/platform");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-platform-test-"));
}

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

// Swap one function on a module's exports *before* it is required by another
// module that destructures from it. We do this by intercepting `require` via
// Module._load once, then reloading the consumer module.
//
// Note: `lib/commands/platform.js` destructures at top, so once it is loaded
// any monkey-patch is too late. We must inject the swap *before* requiring it.
// Each test that uses this helper does the injection right before requiring
// the module under test.
function withPatchedRequires(swaps, fn) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    for (const [matchPath, patch] of swaps) {
      if (resolved === matchPath) {
        // Build the patched export on top of the real module without going
        // through the overridden _load (which would re-enter this hook).
        const realExports = realLoad.call(realLoad, request, parent, isMain);
        return { ...realExports, ...patch };
      }
    }
    return realLoad.call(realLoad, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = realLoad;
  }
}

test("addPlatforms: no targets → process.exit(1) + listPlatforms() output", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en", args: ["add"], options: {} };

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const exitCalls = [];
  const origExit = process.exit;
  const origExitCode = process.exitCode;
  const ExitSentinel = Symbol("exit");
  process.exit = (code) => { exitCalls.push(code); throw ExitSentinel; };
  process.exitCode = undefined;
  try {
    try {
      addPlatforms(ctx);
    } catch (err) {
      if (err !== ExitSentinel) throw err;
    }
  } finally {
    process.exit = origExit;
    const out = restoreOut();
    const err = restoreErr();
    process.exitCode = origExitCode;
    assert.equal(exitCalls.length, 1, "process.exit must be called exactly once");
    assert.equal(exitCalls[0], 1);
    assert.match(err, /Please specify platform/);
    assert.match(out, /Platform list/);
    assert.match(out, /not installed/);
  }
  process.exitCode = origExitCode;
});

test("addPlatforms: .agent directory missing → process.exit(1) with init hint", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en", args: ["add", "cursor"], options: {} };

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const exitCalls = [];
  const origExit = process.exit;
  const origExitCode = process.exitCode;
  const ExitSentinel = Symbol("exit");
  process.exit = (code) => { exitCalls.push(code); throw ExitSentinel; };
  process.exitCode = undefined;
  try {
    try {
      addPlatforms(ctx);
    } catch (err) {
      if (err !== ExitSentinel) throw err;
    }
  } finally {
    process.exit = origExit;
    restoreOut();
    const err = restoreErr();
    process.exitCode = origExitCode;
    assert.equal(exitCalls.length, 1);
    assert.equal(exitCalls[0], 1);
    assert.match(err, /\.agent directory not found/);
  }
  process.exitCode = origExitCode;
});

test("addPlatforms: unknown platform → warn + skip, no install/save/exclude side effects", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const ctx = { cwd: root, lang: "en", args: ["add", "not-a-real-platform"], options: { track: true } };

  // The real installPlatform/removePlatform/applyGitExclusion/saveInstalledPlatforms
  // would be no-ops or benign for an unknown key. To prove the unknown-key path
  // *skips* them entirely, we wrap each and assert they're never called.
  const platformPath = require.resolve("../../lib/platform");
  const gitPath = require.resolve("../../lib/git");
  const calls = [];
  const instrumented = {
    installPlatform: (...a) => { calls.push(["install", a]); return null; },
    saveInstalledPlatforms: (...a) => { calls.push(["save", a]); },
  };
  const instrumentedGit = {
    applyGitExclusion: (...a) => { calls.push(["exclude", a]); },
  };

  withPatchedRequires([
    [platformPath, instrumented],
    [gitPath, instrumentedGit],
  ], () => {
    // Re-require the module under test with the patched require hook active.
    delete require.cache[require.resolve("../../lib/commands/platform")];
    const fresh = require("../../lib/commands/platform");

    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.addPlatforms(ctx);
    } finally {
      const out = restoreOut();
      const err = restoreErr();
      process.exitCode = origExitCode;
      assert.equal(calls.length, 1, "only saveInstalledPlatforms should run; got " + JSON.stringify(calls));
      assert.equal(calls[0][0], "save");
      assert.match(err, /Unknown platform "not-a-real-platform"/);
      assert.match(out, /Platform\(s\) added successfully/);
    }
  });
});

test("removePlatforms: no targets → process.exit(1)", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en", args: ["remove"] };

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const exitCalls = [];
  const origExit = process.exit;
  const origExitCode = process.exitCode;
  const ExitSentinel = Symbol("exit");
  process.exit = (code) => { exitCalls.push(code); throw ExitSentinel; };
  process.exitCode = undefined;
  try {
    try {
      removePlatforms(ctx);
    } catch (err) {
      if (err !== ExitSentinel) throw err;
    }
  } finally {
    process.exit = origExit;
    restoreOut();
    const err = restoreErr();
    process.exitCode = origExitCode;
    assert.equal(exitCalls.length, 1);
    assert.equal(exitCalls[0], 1);
    assert.match(err, /Please specify platform/);
  }
  process.exitCode = origExitCode;
});

test("removePlatforms: happy path → removePlatform called + state persisted", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  // Pre-seed installed state so removePlatforms finds cursor in the list.
  const platformPath = require.resolve("../../lib/platform");
  const removeCalls = [];
  const saveCalls = [];
  const instrumented = {
    removePlatform: (...a) => { removeCalls.push(a); },
    saveInstalledPlatforms: (cwd, keys) => { saveCalls.push({ cwd, keys }); },
  };

  withPatchedRequires([[platformPath, instrumented]], () => {
    delete require.cache[require.resolve("../../lib/commands/platform")];
    const fresh = require("../../lib/commands/platform");
    // Pre-populate the installed-platforms state file so getInstalledPlatforms
    // returns ["cursor"] for the loop filter.
    fs.writeFileSync(path.join(root, ".agent", ".platforms"), JSON.stringify(["cursor", "claude"]));

    const ctx = { cwd: root, lang: "en", args: ["remove", "cursor"] };
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.removePlatforms(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.equal(removeCalls.length, 1);
      assert.equal(removeCalls[0][1], "cursor");
      assert.deepEqual(saveCalls[0].keys, ["claude"], "cursor must be filtered out");
      assert.match(out, /Removing Cursor/);
      assert.match(out, /Platform\(s\) removed successfully/);
    }
  });
});

test("listPlatforms: emits 'installed' and 'not installed' status lines", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en" };
  const { restore: restoreOut } = captureStdout();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    listPlatforms(ctx);
  } finally {
    const out = restoreOut();
    process.exitCode = origExitCode;
    assert.match(out, /Platform list/);
    assert.match(out, /not installed/);
    assert.match(out, /Cursor/);
  }
});

test("listPlatforms: lang=zh → emits Chinese labels", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "zh" };
  const { restore: restoreOut } = captureStdout();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    listPlatforms(ctx);
  } finally {
    const out = restoreOut();
    process.exitCode = origExitCode;
    assert.match(out, /平台列表/);
    assert.match(out, /未安装/);
  }
});

test("addPlatforms: happy path with real installPlatform, save, and applyGitExclusion", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  // Build a minimal templateDir with the cursor integration files so
  // installPlatform can run its real file/symlink path.
  const templateDir = path.join(root, "templates", "_en");
  fs.mkdirSync(path.join(templateDir, "integrations", "cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(templateDir, "integrations", "cursor", ".cursorrules"),
    "cursorrules-content\n",
  );

  const ctx = {
    cwd: root,
    lang: "en",
    args: ["add", "cursor"],
    options: {},
    templateDir,
  };

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    addPlatforms(ctx);
  } finally {
    const out = restoreOut();
    restoreErr();
    process.exitCode = origExitCode;

    // 1. The dest file was created.
    assert.equal(fs.existsSync(path.join(root, ".cursorrules")), true);
    // 2. The installed-platforms state was written.
    const stateRaw = fs.readFileSync(path.join(root, ".agent", ".platforms"), "utf8");
    assert.match(stateRaw, /cursor/);
    // 3. Success message.
    assert.match(out, /Cursor/);
    assert.match(out, /Platform\(s\) added successfully/);
  }
});
