"use strict";

/**
 * Graphify hook integration helper (T-GWG-001 / P-001 §4.6).
 *
 * Exposed to `init` and `doctor --fix` so they can idempotently install
 * the Graphify post-commit hook without ever overwriting an existing
 * unrelated user hook.
 *
 * The contract:
 *   - If the project has no `.agent/plugins/graphify/` (i.e. opted out),
 *     this helper is a no-op and never touches the .git directory.
 *   - If the plugin is present, the helper writes a marker file
 *     `.agent/plugins/graphify/.hook-installed` recording the action
 *     taken (created / appended / unchanged). The marker is gitignored
 *     by the standard Cortex Agent ignore template; it never enters the
 *     source tree as a regular product file.
 *   - On re-run, the helper checks the marker and the hook script and
 *     does not duplicate work. This is what makes `init` and
 *     `doctor --fix` idempotent.
 *
 * Hook source lives at `<project>/.agent/plugins/graphify/scripts/post-commit-update.js`
 * after `init`. The wrapper installed into `.git/hooks/post-commit`
 * simply delegates to that script.
 */

const fs = require("node:fs");
const path = require("node:path");
const graphifyLib = require("../graphify");

const MARKER_NAME = ".hook-installed";

// The post-commit hook shipped into a project is a thin wrapper that
// delegates to the shared Graphify implementation. Issue #152: the wrapper
// could not resolve that implementation inside a consumer project, so it
// exited 0 in silence and the knowledge graph stopped updating everywhere.
//
// The implementation therefore has to be INSTALLED into the project, next
// to the wrapper, at install time — from the framework's own copy. Copying
// it into the template tree instead would mean maintaining the same module
// in two places (lib/graphify/ and templates/_shared/.agent/plugins/…/lib/)
// and letting the two drift; the copy in the template tree would also be
// frozen at template-authoring time while the framework's copy keeps
// evolving.
const PLUGIN_DIR = path.join(".agent", "plugins", "graphify");
const RUNTIME_DIR = path.join(PLUGIN_DIR, "lib", "graphify");
const RUNTIME_FILES = Object.freeze([
  "hook.js",
  "index.js",
  "manifest.js",
  "markers.js",
  "policy.js",
  "receipt.js",
  "resolver.js",
  "worktree.js",
]);

// Where the framework's own copy of the shared implementation lives.
function frameworkRuntimeDir() {
  return path.join(__dirname, "..", "graphify");
}

/**
 * Detect whether the project opted into Graphify.
 */
function isGraphifyOptedIn(projectRoot) {
  const pluginDir = path.join(projectRoot, ".agent", "plugins", "graphify");
  return fs.existsSync(pluginDir);
}

/**
 * Install the shared Graphify implementation into the project, so the
 * project's own post-commit wrapper can resolve it without depending on
 * where the framework happens to be installed.
 *
 * The copy is additive and content-addressed: a file that already matches
 * the framework's copy is left alone, a file that differs is refreshed
 * (the directory is framework-owned runtime, not user content), and a file
 * the framework no longer ships is LEFT IN PLACE — it may be a module the
 * user added, and removing files we never owned would destroy content.
 *
 * Returns { ok, action: "installed" | "updated" | "unchanged" | "skipped",
 *           files: [...], reason? }.
 */
function installGraphifyRuntime(projectRoot) {
  if (!projectRoot) return { ok: false, action: "skipped", reason: "project_root_required" };
  const sourceDir = frameworkRuntimeDir();
  if (!fs.existsSync(sourceDir)) {
    return { ok: false, action: "skipped", reason: "framework_runtime_missing" };
  }
  const destDir = path.join(projectRoot, RUNTIME_DIR);
  const files = [];
  const updated = [];

  for (const name of RUNTIME_FILES) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destDir, name);
    files.push(name);
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(fs.readFileSync(src))) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    updated.push(name);
  }

  // Files the framework no longer ships are LEFT IN PLACE rather than
  // deleted. The directory is framework-written, but a user may have added
  // a module of their own next to it; removing files we do not recognise
  // would destroy content we never owned. A module the framework dropped
  // simply stops being referenced by the ones we do install.
  const action = updated.length === 0
    ? "unchanged"
    : (files.length > 0 && updated.length === files.length ? "installed" : "updated");
  return { ok: true, action, files, updated };
}

/**
 * Report whether the project's copy of the shared implementation matches
 * the framework's. Read-only — never writes.
 *
 * Returns { ok, inSync, installed, missing: [...] }.
 */
function readRuntimeStatus(projectRoot) {
  const sourceDir = frameworkRuntimeDir();
  const destDir = path.join(projectRoot, RUNTIME_DIR);
  const missing = [];
  const differing = [];
  for (const name of RUNTIME_FILES) {
    const src = path.join(sourceDir, name);
    const dest = path.join(destDir, name);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dest)) { missing.push(name); continue; }
    if (!fs.readFileSync(dest).equals(fs.readFileSync(src))) differing.push(name);
  }
  const installed = fs.existsSync(destDir);
  return {
    ok: true,
    inSync: missing.length === 0 && differing.length === 0,
    installed,
    missing,
    differing,
  };
}

/**
 * Ensure the post-commit hook is wired. Returns one of:
 *   { ok, status: "noop" | "created" | "appended" | "unchanged" | "skipped" | "error", reason? }
 */
function ensureGraphifyPostCommitHook(projectRoot) {
  if (!isGraphifyOptedIn(projectRoot)) {
    return { ok: true, status: "skipped", reason: "graphify_not_opted_in" };
  }
  // Install the shared implementation FIRST, and independently of the git
  // hook: the wrapper is useless without it, and a project whose hook is
  // already installed still needs the runtime (that is exactly the state
  // issue #152 left behind — hook present, implementation absent).
  const runtime = installGraphifyRuntime(projectRoot);
  if (!runtime.ok) {
    return { ok: false, status: "error", reason: runtime.reason || "runtime_install_failed" };
  }
  // A project whose wrapper previously failed to resolve the implementation
  // carries a stale diagnostic marker. Once the runtime is in place the
  // marker is no longer true, so it is cleared.
  clearUnwiredMarker(projectRoot);
  const state = graphifyLib.hook.detectPluginState(projectRoot);
  if (!state.cli) {
    // Without the Graphify CLI binary, the hook would always be a no-op.
    // We still mark it as installed so re-runs are cheap, but we surface
    // the CLI-missing detail to the caller.
    writeMarker(projectRoot, { status: "skipped", reason: "graphify_cli_missing" });
    return { ok: true, status: "skipped", reason: "graphify_cli_missing" };
  }
  if (state.hooksInstalled) {
    writeMarker(projectRoot, { status: "unchanged" });
    return { ok: true, status: "unchanged" };
  }
  const result = graphifyLib.hook.installHook({ projectRoot });
  if (!result.ok) {
    return { ok: false, status: "error", reason: result.reason || "install_failed" };
  }
  writeMarker(projectRoot, { status: result.action });
  return { ok: true, status: result.action };
}

/**
 * Read the recorded hook install action. Used by `doctor --fix` to skip
 * redundant work on repeated invocations.
 */
function readGraphifyHookStatus(projectRoot) {
  const markerPath = path.join(projectRoot, ".agent", "plugins", "graphify", MARKER_NAME);
  if (!fs.existsSync(markerPath)) return { recorded: false, status: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return { recorded: true, status: parsed };
  } catch (_) {
    return { recorded: true, status: null, reason: "marker_corrupt" };
  }
}

function writeMarker(projectRoot, payload) {
  const markerPath = path.join(projectRoot, ".agent", "plugins", "graphify", MARKER_NAME);
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify(Object.assign({ recordedAt: new Date().toISOString() }, payload), null, 2),
    );
  } catch (_) {
    // Non-fatal: marker is best-effort metadata. The hook itself is the
    // source of truth; doctor inspects the live state via hookLib.
  }
}

// The wrapper writes this marker when it cannot resolve the shared
// implementation (issue #152). It is the signal that the hook is present
// but inert — indistinguishable from a healthy hook without it.
const UNWIRED_MARKER_NAME = ".hook-unwired.json";

function unwiredMarkerPath(projectRoot) {
  return path.join(projectRoot, PLUGIN_DIR, UNWIRED_MARKER_NAME);
}

/**
 * Read the "hook is not wired" diagnostic marker. Returns
 * { recorded, marker, reason? } — never throws.
 */
function readUnwiredMarker(projectRoot) {
  const markerPath = unwiredMarkerPath(projectRoot);
  if (!fs.existsSync(markerPath)) return { recorded: false, marker: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return { recorded: true, marker: parsed };
  } catch (_) {
    return { recorded: true, marker: null, reason: "marker_corrupt" };
  }
}

/**
 * Clear the "hook is not wired" marker. Called once the shared
 * implementation is installed, because the marker no longer describes the
 * project's state.
 */
function clearUnwiredMarker(projectRoot) {
  const markerPath = unwiredMarkerPath(projectRoot);
  if (!fs.existsSync(markerPath)) return { ok: true, cleared: false };
  try {
    fs.unlinkSync(markerPath);
    return { ok: true, cleared: true };
  } catch (_) {
    return { ok: false, cleared: false };
  }
}

module.exports = {
  isGraphifyOptedIn,
  ensureGraphifyPostCommitHook,
  readGraphifyHookStatus,
  installGraphifyRuntime,
  readRuntimeStatus,
  readUnwiredMarker,
  clearUnwiredMarker,
  UNWIRED_MARKER_NAME,
};
