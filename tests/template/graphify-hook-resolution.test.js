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

const ROOT = path.resolve(__dirname, "..", "..");
const SHARED_HOOK = path.join(
  ROOT, "templates", "_shared", ".agent", "plugins", "graphify", "scripts", "post-commit-update.js"
);
const GRAPHIFY_LIB_DIR = path.join(ROOT, "lib", "graphify");

// The wrapper's own candidate list, mirrored from the template. Keeping it in
// sync with the template is itself part of what this test verifies.
function wrapperCandidates(scriptPath) {
  return [
    path.join(scriptPath, "..", "..", "..", "..", "lib", "graphify", "hook.js"),
    path.join(scriptPath, "..", "..", "lib", "graphify", "hook.js"),
  ];
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

    const resolved = wrapperCandidates(installedHook).find((c) => fs.existsSync(c));
    assert.ok(resolved,
      "the installed hook must resolve lib/graphify/hook.js from a consumer project; " +
      `candidates tried: ${wrapperCandidates(installedHook).join(", ")}`);

    // The resolved module must expose the entry point the wrapper calls.
    const hookLib = require(resolved);
    assert.equal(typeof hookLib.runPostCommit, "function",
      "resolved hook module must export runPostCommit");
    assert.ok(hookLib.HOOK_RESULT, "resolved hook module must export HOOK_RESULT");
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
