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

/**
 * Detect whether the project opted into Graphify.
 */
function isGraphifyOptedIn(projectRoot) {
  const pluginDir = path.join(projectRoot, ".agent", "plugins", "graphify");
  return fs.existsSync(pluginDir);
}

/**
 * Ensure the post-commit hook is wired. Returns one of:
 *   { ok, status: "noop" | "created" | "appended" | "unchanged" | "skipped" | "error", reason? }
 */
function ensureGraphifyPostCommitHook(projectRoot) {
  if (!isGraphifyOptedIn(projectRoot)) {
    return { ok: true, status: "skipped", reason: "graphify_not_opted_in" };
  }
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

module.exports = {
  isGraphifyOptedIn,
  ensureGraphifyPostCommitHook,
  readGraphifyHookStatus,
};