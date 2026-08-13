"use strict";

// ─── lib/commands/project.js unit tests ───────────────────────────────────────
//
// Coverage:
//   - untrackAgent: not a git repo → warn + early return
//   - untrackAgent: happy path → untrackGeneratedFilesFromGit + applyGitExclusion run
//   - trackAgent: not a git repo → warn + early return
//   - trackAgent: .agent missing → warn + early return
//   - trackAgent: no generated files on disk → "no files to track" message
//   - trackAgent: lifts the canonical .agent-runtime/.gitignore hard-ignore
//   - trackAgent: hand-managed .agent-runtime/.gitignore is preserved
//   - untrackAgent: restores the runtime hard-ignore after tracking ends
//   - linkGlobal: just forwards to linkGlobalConfig

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const {
  untrackAgent,
  trackAgent,
  linkGlobal,
} = require("../../lib/commands/project");
const {
  RUNTIME_GITIGNORE_BODY,
  RUNTIME_TRACKED_GITIGNORE_BODY,
} = require("../../lib/cross-project/runtime-root");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-project-test-"));
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

// Patch the helpers used by lib/commands/project.js (`isGitRepo`,
// `untrackGeneratedFilesFromGit`, `applyGitExclusion`, `getAllGeneratedPaths`)
// by overriding Module._load, so that when lib/commands/project.js requires
// `../git` and `../platform` it sees our instrumented exports.
function withPatchedRequires(swaps, fn) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    for (const [matchPath, patch] of swaps) {
      if (resolved === matchPath) {
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

test("untrackAgent: not a git repo → warns + skips (no untrack/exclude calls)", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const calls = { untrack: 0, exclude: 0 };
  const instrumented = {
    isGitRepo: () => false,
    untrackGeneratedFilesFromGit: () => { calls.untrack++; return false; },
    applyGitExclusion: () => { calls.exclude++; },
  };
  withPatchedRequires([[gitPath, instrumented]], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.untrackAgent(ctx);
    } finally {
      const out = restoreOut();
      const err = restoreErr();
      process.exitCode = origExitCode;
      assert.equal(calls.untrack, 0, "untrackGeneratedFilesFromGit must NOT be called");
      assert.equal(calls.exclude, 0, "applyGitExclusion must NOT be called");
      assert.match(err, /Not a Git repository/);
      assert.match(out, /Untracking generated Cortex Agent files/);
    }
  });
});

test("untrackAgent: happy path (is git repo) → untrack + exclude both run", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const calls = { untrack: 0, exclude: 0 };
  const instrumented = {
    isGitRepo: () => true,
    untrackGeneratedFilesFromGit: () => { calls.untrack++; return true; },
    applyGitExclusion: () => { calls.exclude++; },
  };
  withPatchedRequires([[gitPath, instrumented]], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.untrackAgent(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.equal(calls.untrack, 1);
      assert.equal(calls.exclude, 1);
      assert.match(out, /Done\. Generated files will stay local-only/);
    }
  });
});

test("trackAgent: not a git repo → warns + skips (no exclude / git add)", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const calls = { exclude: 0 };
  const instrumented = {
    isGitRepo: () => false,
    applyGitExclusion: () => { calls.exclude++; },
  };
  withPatchedRequires([[gitPath, instrumented]], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.trackAgent(ctx);
    } finally {
      const out = restoreOut();
      const err = restoreErr();
      process.exitCode = origExitCode;
      assert.equal(calls.exclude, 0);
      assert.match(err, /Not a Git repository/);
      // The early-return happens before the "Enabling" log line.
      assert.doesNotMatch(out, /Enabling Git tracking/);
    }
  });
});

test("trackAgent: .agent missing (is git repo) → warns + early return", () => {
  const root = mkRoot();
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const instrumented = {
    isGitRepo: () => true,
    resolveGitExcludePath: () => null,
  };
  withPatchedRequires([[gitPath, instrumented]], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.trackAgent(ctx);
    } finally {
      const out = restoreOut();
      const err = restoreErr();
      process.exitCode = origExitCode;
      assert.match(err, /\.agent not found/);
      assert.doesNotMatch(out, /Enabling Git tracking/);
    }
  });
});

test("trackAgent: no generated files on disk → 'no files to track' message", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const platformPath = require.resolve("../../lib/platform");
  // Pretend we are in a git repo and the generated-path set is empty.
  const instrumentedGit = {
    isGitRepo: () => true,
    resolveGitExcludePath: () => null, // skip the exclude-file rewrite
  };
  const instrumentedPlatform = {
    getAllGeneratedPaths: () => [],
  };
  withPatchedRequires([
    [gitPath, instrumentedGit],
    [platformPath, instrumentedPlatform],
  ], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.trackAgent(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.match(out, /Enabling Git tracking for \.agent/);
      assert.match(out, /No files found to track/);
    }
  });
});

test("trackAgent: .git/info/exclude contains cortex-agent entries → they get filtered out", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  // Seed exclude file with one cortex-agent path + one unrelated path.
  const excludePath = path.join(root, ".git", "info", "exclude");
  fs.writeFileSync(excludePath, ".agent\n/.agent\nrandom-user-line\n");
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const platformPath = require.resolve("../../lib/platform");
  const instrumentedGit = {
    isGitRepo: () => true,
    resolveGitExcludePath: () => excludePath,
  };
  const instrumentedPlatform = {
    getAllGeneratedPaths: () => [".agent", "/.agent"],
  };
  withPatchedRequires([
    [gitPath, instrumentedGit],
    [platformPath, instrumentedPlatform],
  ], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.trackAgent(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      // The cortex-agent lines should have been removed; user line preserved.
      const updated = fs.readFileSync(excludePath, "utf8");
      assert.doesNotMatch(updated, /^\.agent$/m);
      assert.doesNotMatch(updated, /^\/\.agent$/m);
      assert.match(updated, /random-user-line/);
      assert.match(out, /Removed cortex-agent entries from \.git\/info\/exclude/);
    }
  });
});

// ─── .agent-runtime hard-ignore lift / restore ─────────────────────────────────

function seedRuntimeIgnore(root, body) {
  const runtimeDir = path.join(root, ".agent-runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const ignorePath = path.join(runtimeDir, ".gitignore");
  fs.writeFileSync(ignorePath, body, { encoding: "utf8", mode: 0o600 });
  return ignorePath;
}

test("trackAgent: canonical .agent-runtime/.gitignore hard-ignore is lifted before git add", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const ignorePath = seedRuntimeIgnore(root, RUNTIME_GITIGNORE_BODY);
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const platformPath = require.resolve("../../lib/platform");
  const instrumentedGit = {
    isGitRepo: () => true,
    resolveGitExcludePath: () => null,
  };
  const instrumentedPlatform = {
    getAllGeneratedPaths: () => [".agent", ".agent-runtime"],
  };
  withPatchedRequires([
    [gitPath, instrumentedGit],
    [platformPath, instrumentedPlatform],
  ], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.trackAgent(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.equal(fs.readFileSync(ignorePath, "utf8"), RUNTIME_TRACKED_GITIGNORE_BODY,
        "hard-ignore payload must be replaced with the tracked marker");
      assert.match(out, /Lifted the cold-start hard-ignore/);
    }
  });
});

test("trackAgent: hand-managed .agent-runtime/.gitignore is left untouched", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const customBody = "# managed by hand\nsecret/\n";
  const ignorePath = seedRuntimeIgnore(root, customBody);
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const platformPath = require.resolve("../../lib/platform");
  const instrumentedGit = {
    isGitRepo: () => true,
    resolveGitExcludePath: () => null,
  };
  const instrumentedPlatform = {
    getAllGeneratedPaths: () => [".agent", ".agent-runtime"],
  };
  withPatchedRequires([
    [gitPath, instrumentedGit],
    [platformPath, instrumentedPlatform],
  ], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.trackAgent(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.equal(fs.readFileSync(ignorePath, "utf8"), customBody,
        "custom .gitignore contents must be preserved");
      assert.doesNotMatch(out, /Lifted the cold-start hard-ignore/);
    }
  });
});

test("untrackAgent: tracked-marker .agent-runtime/.gitignore is restored to the hard-ignore payload", () => {
  const root = mkRoot();
  const ignorePath = seedRuntimeIgnore(root, RUNTIME_TRACKED_GITIGNORE_BODY);
  const ctx = { cwd: root, lang: "en" };

  const gitPath = require.resolve("../../lib/git");
  const instrumented = {
    isGitRepo: () => true,
    untrackGeneratedFilesFromGit: () => false,
    applyGitExclusion: () => {},
  };
  withPatchedRequires([[gitPath, instrumented]], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.untrackAgent(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.equal(fs.readFileSync(ignorePath, "utf8"), RUNTIME_GITIGNORE_BODY,
        "tracked marker must be restored to the hard-ignore payload");
      assert.match(out, /Restored the cold-start hard-ignore/);
    }
  });
});

test("linkGlobal: just forwards ctx to linkGlobalConfig", () => {
  const setupPath = require.resolve("../../lib/setup");
  const received = [];
  const instrumented = {
    linkGlobalConfig: (ctx) => { received.push(ctx); },
  };
  withPatchedRequires([[setupPath, instrumented]], () => {
    delete require.cache[require.resolve("../../lib/commands/project")];
    const fresh = require("../../lib/commands/project");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const ctx = { cwd: "/some/cwd", lang: "en" };
      fresh.linkGlobal(ctx);
    } finally {
      restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.equal(received.length, 1);
      assert.equal(received[0].cwd, "/some/cwd");
    }
  });
});
