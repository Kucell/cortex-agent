"use strict";

// ─── Graphify hook resolution test (regression for issue #152) ──────────────
//
// The shipped post-commit hook is a thin wrapper that delegates to
// `lib/graphify/hook.js`. That module must be reachable from a CONSUMER
// project, because the wrapper resolves it relative to the project root —
// never relative to the cortex-agent installation.
//
// Issue #152: the wrapper resolved `lib/graphify/hook.js` only inside the
// cortex-agent repository. Templates ship `.agent/plugins/graphify/` but no
// `lib/graphify/`, so `require` always failed and the hook silently exited 0.
// The knowledge graph then stopped updating in every consumer project with
// no error, no log line, and no differing exit code.
//
// This test materialises a throwaway consumer project, installs the shipped
// template files into it, and asserts the hook can actually resolve its
// shared implementation.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SHARED_HOOK = path.join(
  ROOT, "templates", "_shared", ".agent", "plugins", "graphify", "scripts", "post-commit-update.js"
);
const GRAPHIFY_LIB_DIR = path.join(ROOT, "lib", "graphify");
const graphifyHook = require("../../lib/setup/graphify-hook");

// Resolve the shared implementation the way the SHIPPED wrapper does.
//
// The wrapper resolves relative to its own directory (__dirname), which in
// a consumer project is <project>/.agent/plugins/graphify/scripts. The
// implementation is installed next to the plugin, at
// <project>/.agent/plugins/graphify/lib/graphify/hook.js.
//
// Deriving the candidates here from the script DIRECTORY (not from the
// script file path) is what makes this test check the same thing the
// wrapper checks. An earlier version of this test derived them from the
// file path, which pointed at <project>/.agent/lib/... -- a location the
// wrapper never looks at, so the test could not have passed even with a
// correct fix.
function wrapperCandidates(scriptsDir) {
  return [path.join(scriptsDir, "..", "lib", "graphify", "hook.js")];
}

test("shipped graphify hook resolves its shared implementation inside a consumer project", () => {
  assert.equal(fs.existsSync(SHARED_HOOK), true, "shipped hook template must exist");
  assert.equal(fs.existsSync(path.join(GRAPHIFY_LIB_DIR, "hook.js")), true,
    "framework must ship lib/graphify/hook.js");

  // Materialise a consumer project: `.agent/plugins/graphify/scripts/` holds
  // the shipped hook, exactly as `cortex-agent init` / `update` installs it.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graphify-consumer-"));
  try {
    const scriptsDir = path.join(project, ".agent", "plugins", "graphify", "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const installedHook = path.join(scriptsDir, "post-commit-update.js");
    fs.copyFileSync(SHARED_HOOK, installedHook);

    // The framework installs the shared implementation into the project, so
    // the shipped wrapper can resolve it without depending on where the
    // framework itself is installed (npm global, npx, or a checkout).
    const runtime = graphifyHook.installGraphifyRuntime(project);
    assert.equal(runtime.ok, true, "runtime install failed: " + (runtime.reason || "unknown"));
    for (const name of [
      "density.js",
      "density-baseline.js",
      "density-files.js",
      "density-gate.js",
      "density-lock.js",
      "density-pending.js",
      "density-update.js",
      "full-rebuild-runner.js",
    ]) {
      assert.equal(fs.existsSync(path.join(scriptsDir, "..", "lib", "graphify", name)), true,
        `the installed Graphify runtime must include ${name}`);
    }

    const resolved = wrapperCandidates(scriptsDir).find((c) => fs.existsSync(c));
    assert.ok(resolved,
      "the installed hook must resolve lib/graphify/hook.js from a consumer project; " +
      "candidates tried: " + wrapperCandidates(scriptsDir).join(", "));

    // The resolved module must expose the entry point the wrapper calls.
    const hookLib = require(resolved);
    assert.equal(typeof hookLib.runPostCommit, "function",
      "resolved hook module must export runPostCommit");
    assert.equal(typeof require(path.join(scriptsDir, "..", "lib", "graphify", "index.js")).density.checkAndMaybeRebuild, "function");
    assert.ok(hookLib.HOOK_RESULT, "resolved hook module must export HOOK_RESULT");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("shipped graphify hook reports a diagnostic marker when its implementation is missing", () => {
  // The silent no-op is the actual damage of issue #152: an inert hook is
  // indistinguishable from a healthy one, so the knowledge graph stops
  // updating with no error, no log line and no differing exit code. The
  // hook must leave a durable marker and warn instead.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graphify-unwired-"));
  try {
    const scriptsDir = path.join(project, ".agent", "plugins", "graphify", "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const installedHook = path.join(scriptsDir, "post-commit-update.js");
    fs.copyFileSync(SHARED_HOOK, installedHook);

    // No runtime is installed, so the wrapper cannot resolve its shared
    // implementation. Run it and assert the failure is reported.
    const result = spawnSync(process.execPath, [installedHook], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, "the hook must never block the commit");
    assert.match(result.stderr, /NOT wired/,
      "an unwired hook must warn on stderr instead of failing silently");

    const markerPath = path.join(project, ".agent", "plugins", "graphify", ".hook-unwired.json");
    assert.equal(fs.existsSync(markerPath), true,
      "an unwired hook must leave a durable diagnostic marker");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.kind, "hook_unwired");
    assert.equal(marker.reason, "shared_implementation_not_found");

    // The doctor must be able to report the condition.
    const unwired = graphifyHook.readUnwiredMarker(project);
    assert.equal(unwired.recorded, true);
    assert.equal(unwired.marker.kind, "hook_unwired");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("the installed git post-commit hook reaches the wrapper", () => {
  // The git hook installed by `doctor --fix` runs the wrapper by a path
  // relative to `.git/hooks/`. That path has to climb out of `.git/hooks`
  // and back into `.agent/`; the previous form resolved to
  // `<project>/plugins/...`, which does not exist, so the installed hook
  // never reached the wrapper at all.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graphify-githook-"));
  try {
    const scriptsDir = path.join(project, ".agent", "plugins", "graphify", "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(SHARED_HOOK, path.join(scriptsDir, "post-commit-update.js"));
    execFileSync("git", ["init", "-q"], { cwd: project });

    const installed = require("../../lib/graphify").hook.installHook({ projectRoot: project });
    assert.equal(installed.ok, true, "hook install failed: " + (installed.reason || "unknown"));

    const hookScript = fs.readFileSync(path.join(project, ".git", "hooks", "post-commit"), "utf8");
    assert.match(hookScript, /git rev-parse --show-toplevel/,
      "installed hook must resolve the project root independently of hooksPath");
    assert.match(hookScript, /CORTEX_GRAPHIFY_SOURCE_HEAD/,
      "installed hook must pass the commit identity to the asynchronous wrapper");
    const resolved = path.join(project, ".agent", "plugins", "graphify", "scripts", "post-commit-update.js");
    assert.equal(fs.existsSync(resolved), true,
      "installed hook must point at an existing wrapper; resolved to " + resolved);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("graphify shared implementation has no non-node builtin dependencies", () => {
  // The fix may ship lib/graphify/ into consumer projects. That is only safe
  // while the module tree stays free of third-party requires.
  const dir = fs.readdirSync(GRAPHIFY_LIB_DIR).filter((n) => n.endsWith(".js"));
  assert.ok(dir.length > 0, "lib/graphify must not be empty");
  for (const name of dir) {
    const abs = path.join(GRAPHIFY_LIB_DIR, name);
    // Strip comments first: doc blocks legitimately mention module specifiers
    // (e.g. `@graphify`) that are never actually required.
    const text = fs.readFileSync(abs, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const requires = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    for (const spec of requires) {
      assert.ok(spec.startsWith("node:") || spec.startsWith("./"),
        `${name} must only require node: builtins or local siblings, got "${spec}"`);
    }
  }
});
