"use strict";

// ─── lib/commands/reconcile.js unit tests ─────────────────────────────────────
//
// Coverage:
//   - minimaxCliReconcile: when adapter is null → warn + early return
//   - minimaxCliReconcile: when adapter is registered → emits the
//     read-only reconcile banner with all 6 lines (binary version,
//     auth state, probe allow-list, portable skills, snapshot_id,
//     "read-only reconcile" footer)
//
// We use Module._load interception to swap the lazy adapter import, so
// `lib/commands/reconcile.js` either sees a null adapter (file-missing
// case) or a fake adapter returning a deterministic onReconcileRun /
// enumerateSkills pair.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { minimaxCliReconcile } = require("../../lib/commands/reconcile");

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

// Override Module._load to substitute a fake adapter for the
// governed-tool module. `adapter` is either:
//   - null: pretend the file is missing (lazy require throws, sets to null)
//   - an object {onReconcileRun, enumerateSkills, ...}: returned as the
//     "hooks" object
//   - a function (args) => hooksObject: treated as a factory
function withFakeAdapter(adapter, fn) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved.endsWith("minimax-cli-governed-tool.js")) {
      if (adapter === null) {
        // Pretend the module is missing — the lazy require would catch.
        throw new Error("Cannot find module 'minimax-cli-governed-tool'");
      }
      return {
        registerWithInitUpdateDoctor: (args) => {
          if (typeof adapter === "function") return adapter(args);
          return adapter;
        },
      };
    }
    return realLoad.call(realLoad, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = realLoad;
  }
}

test("minimaxCliReconcile: adapter missing → warns + early return (no banner)", () => {
  const ctx = { cwd: "/tmp/fake", lang: "en" };

  withFakeAdapter(null, () => {
    // Force re-require so the lazy-require inside reconcile.js re-runs
    // (it caches the failure into a local null).
    delete require.cache[require.resolve("../../lib/commands/reconcile")];
    const fresh = require("../../lib/commands/reconcile");

    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.minimaxCliReconcile(ctx);
    } finally {
      const out = restoreOut();
      const err = restoreErr();
      process.exitCode = origExitCode;
      assert.match(err, /MiniMax CLI governed-tool adapter not registered/);
      // No reconcile banner should be printed.
      assert.doesNotMatch(out, /MiniMax CLI reconcile/);
    }
  });
});

test("minimaxCliReconcile: zh adapter-missing message", () => {
  const ctx = { cwd: "/tmp/fake", lang: "zh" };

  withFakeAdapter(null, () => {
    delete require.cache[require.resolve("../../lib/commands/reconcile")];
    const fresh = require("../../lib/commands/reconcile");

    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.minimaxCliReconcile(ctx);
    } finally {
      const out = restoreOut();
      const err = restoreErr();
      process.exitCode = origExitCode;
      assert.match(err, /MiniMax CLI governed-tool adapter 未注册/);
      assert.doesNotMatch(out, /MiniMax CLI reconcile/);
    }
  });
});

test("minimaxCliReconcile: happy path → prints all 6 banner lines (en)", () => {
  const ctx = { cwd: "/tmp/fake", lang: "en" };
  const adapter = () => ({
    onReconcileRun: () => ({
      binary_version: "1.2.3",
      auth_state: "unauthenticated",
      probe_families: ["version", "help", "resource-help"],
      snapshot_id: "snap-abc-123",
    }),
    enumerateSkills: () => [
      { name: "alpha", present: true },
      { name: "beta", present: false },
      { name: "gamma", present: true },
    ],
  });

  withFakeAdapter(adapter, () => {
    delete require.cache[require.resolve("../../lib/commands/reconcile")];
    const fresh = require("../../lib/commands/reconcile");

    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.minimaxCliReconcile(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.match(out, /MiniMax CLI reconcile \(ARI P-005 \/ M-011\)/);
      assert.match(out, /binary version: 1\.2\.3/);
      assert.match(out, /auth state: unauthenticated/);
      assert.match(out, /probe allow-list: version \/ help \/ resource-help/);
      assert.match(out, /portable skill paths: 2\/3 present/);
      assert.match(out, /snapshot_id: snap-abc-123/);
      assert.match(out, /read-only reconcile: no files persisted/);
    }
  });
});

test("minimaxCliReconcile: happy path → Chinese labels (lang=zh)", () => {
  const ctx = { cwd: "/tmp/fake", lang: "zh" };
  const adapter = () => ({
    onReconcileRun: () => ({
      binary_version: null,
      auth_state: "missing-credentials",
      probe_families: ["version"],
      snapshot_id: "snap-zh-0",
    }),
    enumerateSkills: () => [{ name: "alpha", present: true }],
  });

  withFakeAdapter(adapter, () => {
    delete require.cache[require.resolve("../../lib/commands/reconcile")];
    const fresh = require("../../lib/commands/reconcile");

    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      fresh.minimaxCliReconcile(ctx);
    } finally {
      const out = restoreOut();
      restoreErr();
      process.exitCode = origExitCode;
      assert.match(out, /二进制版本: \(unavailable\)/);
      assert.match(out, /认证状态: missing-credentials/);
      assert.match(out, /探测白名单: version/);
      assert.match(out, /便携 Skill 路径: 1\/1 已就位/);
      assert.match(out, /snapshot_id: snap-zh-0/);
      assert.match(out, /只读 reconcile：未持久化任何文件/);
    }
  });
});
