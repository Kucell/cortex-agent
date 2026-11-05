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

// The plugin's runtime state that must never enter the source tree. These
// are also listed in the template `.agent/.gitignore`, but that file is
// copied ADDITIVELY: a project that already has `.agent/.gitignore` never
// receives the template's later additions. A project that tracks `.agent/`
// would therefore start seeing the density baseline, the rebuild-cooldown
// marker and the rebuild logs as untracked new files. The runtime install
// therefore ensures the entries in the project's own ignore file.
const RUNTIME_IGNORE_PATTERNS = Object.freeze([
  "plugins/graphify/.hook-installed",
  "plugins/graphify/.hook-unwired.json",
  "plugins/graphify/.density-baseline.json",
  "plugins/graphify/.density-rebuild-state.json",
  "plugins/graphify/.density-tickets/",
  "plugins/graphify/.density-displaced/",
  "plugins/graphify/.density-gates/",
  "plugins/graphify/.density-staging/",
  "plugins/graphify/.density-generation",
  "plugins/graphify/.density-rebuild.lock",
  "plugins/graphify/.density-rebuild.lock.move-*",
  "plugins/graphify/.density-pending/",
  "plugins/graphify/.*.tmp-*",
  "plugins/graphify/.density-claimed/",
  "plugins/graphify/.density-commit.json",
  // The density state lives in a worktree-isolated directory: two
  // worktrees of one repository must not share a lock, a baseline or a
  // pending request.
  "plugins/graphify/.density-worktrees/",
  "logs/graphify/",
]);

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
  "density-baseline.js",
  "density-files.js",
  "density-gate.js",
  "density-lock.js",
  "density-pending.js",
  "density-update.js",
  "density.js",
  "full-rebuild-runner.js",
  "hook.js",
  "index.js",
  "manifest.js",
  "markers.js",
  "policy.js",
  "receipt.js",
  "resolver.js",
  "worktree.js",
  // The edge-density guard (issue #154). `hook.js` requires it, so it
  // must ship with the rest of the shared implementation.
  "density.js",
  // The density guard is split into focused modules: `density.js` is the
  // facade and requires the others, so they have to ship with it.
  "density-files.js",
  "density-lock.js",
  // The publication gate. `density-lock.js` and `density-baseline.js`
  // require it, so it has to ship with them.
  "density-gate.js",
  "density-baseline.js",
  "density-pending.js",
  // The guarded graph update. Every path that writes the graph runs it
  // through this module, so it has to ship with the rest of the shared
  // implementation.
  "density-update.js",
  // The full-rebuild runner. The density guard spawns IT -- not the
  // consumer project's own wrapper -- so the timeout, the lock release and
  // the baseline stamp all end together in one process. Without it the
  // guard would have no timeout and no lock ownership.
  "full-rebuild-runner.js",
]);

// ─── Plugin-owned assets ────────────────────────────────────────────────────
//
// The Graphify plugin carries three kinds of file, and they have three
// different ownership rules:
//
//   1. the shared runtime  → framework-owned, installed verbatim
//   2. the thin wrapper    → framework-owned, managed as an L1 script
//   3. the project config  → PROJECT-owned, tuned by the team that owns the
//      repository (SamHMI keeps --code-only --no-cluster, hmi-platform
//      keeps its own baseline and timeout)
//
// For (3) the framework may only ADD what a new framework version
// introduced. Overwriting a value the project chose would silently change
// how that project builds its graph, so the refresh is a merge: keys the
// project already has are never touched, keys it lacks are filled in with
// the framework default.
//
// This is what makes `cortex-agent update` complete. A project installed
// before the density guard existed has a threshold.json without
// `full_rebuild_args` and a .gitignore without the density state directory.
// Both are refreshed here, additively, so an old project converges to the
// same capability as a freshly initialized one — without the framework
// touching a single project-chosen value.
const THRESHOLD_RELATIVE = path.join("plugins", "graphify", "threshold.json");

// The framework's default threshold configuration. The shipped template is
// the source of truth (it is what a fresh project receives); the runtime
// default is the fallback for a package installed without its templates.
function frameworkThresholdDefaults() {
  const templateFile = path.join(
    __dirname,
    "..",
    "..",
    "templates",
    "_shared",
    ".agent",
    "plugins",
    "graphify",
    "threshold.json",
  );
  try {
    const parsed = JSON.parse(fs.readFileSync(templateFile, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    /* fall through to the runtime default */
  }
  try {
    const density = require("../graphify/density");
    return Object.assign({}, density.DEFAULT_THRESHOLD);
  } catch (_) {
    return {};
  }
}

function thresholdConfigPath(projectRoot) {
  return path.join(projectRoot, PLUGIN_DIR, "threshold.json");
}

/**
 * Merge the framework defaults into the project's threshold.json.
 *
 * Project values always win. Only keys the project does not have at all are
 * added, so a project that pinned its own baseline, timeout or rebuild
 * arguments keeps them across every upgrade.
 *
 * Returns { ok, action: "created" | "updated" | "unchanged", file,
 *           addedKeys: [...] }.
 */
function refreshThresholdConfig(projectRoot) {
  const file = thresholdConfigPath(projectRoot);
  const defaults = frameworkThresholdDefaults();
  const defaultKeys = Object.keys(defaults);

  if (!fs.existsSync(file)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + "\n", "utf8");
    } catch (error) {
      return { ok: false, action: "error", file, reason: error.message };
    }
    return { ok: true, action: "created", file, addedKeys: defaultKeys };
  }

  let local;
  try {
    local = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // A corrupt config is the project's own content: never rewrite it.
    // The runtime already degrades to its defaults for a corrupt file.
    return { ok: false, action: "skipped", file, reason: "threshold_unparsable", detail: error.message };
  }
  if (!local || typeof local !== "object" || Array.isArray(local)) {
    return { ok: false, action: "skipped", file, reason: "threshold_not_an_object" };
  }

  const missing = defaultKeys.filter((key) => !(key in local));
  if (missing.length === 0) {
    return { ok: true, action: "unchanged", file, addedKeys: [] };
  }

  // The project's own key order is preserved; the missing keys are appended
  // at the end. A minimal diff matters here: this file is the project's
  // configuration, and a reordering would look like a framework takeover.
  const merged = Object.assign({}, local);
  for (const key of missing) merged[key] = defaults[key];
  try {
    const temporary = file + ".tmp-" + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(merged, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(file + ".tmp-" + process.pid); } catch (_) { /* no staged file */ }
    return { ok: false, action: "error", file, reason: error.message };
  }
  return { ok: true, action: "updated", file, addedKeys: missing };
}

/**
 * Make sure the project's .agent/.gitignore covers the Graphify runtime
 * state. The ignore file is shared with every other framework asset, so
 * only the missing Graphify lines are appended — the rest of the file is
 * the project's own content and is never rewritten.
 */
function refreshIgnoreRules(projectRoot) {
  // The ignore rules are the framework's own list (the same one the
  // runtime install writes), so the two paths can never drift.
  const result = ensureRuntimeIgnoreEntries(projectRoot);
  return {
    ok: result.ok,
    action: result.added && result.added.length > 0 ? "updated" : "unchanged",
    file: result.path,
    added: result.added || [],
  };
}

/**
 * Refresh the project-owned Graphify assets. Additive only: the framework
 * fills in what a newer framework version introduced and leaves every value
 * the project chose untouched.
 */
function refreshGraphifyPluginAssets(projectRoot) {
  if (!projectRoot) return { ok: false, action: "skipped", reason: "project_root_required" };
  const threshold = refreshThresholdConfig(projectRoot);
  const ignore = refreshIgnoreRules(projectRoot);
  const unchanged = threshold.action === "unchanged" && ignore.action === "unchanged";
  return {
    ok: threshold.ok && ignore.ok,
    action: unchanged ? "unchanged" : "updated",
    threshold,
    ignore,
  };
}

function planThresholdConfig(projectRoot) {
  const file = thresholdConfigPath(projectRoot);
  const defaults = frameworkThresholdDefaults();
  if (!fs.existsSync(file)) return { action: "created", addedKeys: Object.keys(defaults) };
  let local;
  try {
    local = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return { action: "skipped", addedKeys: [], reason: "threshold_unparsable" };
  }
  if (!local || typeof local !== "object" || Array.isArray(local)) {
    return { action: "skipped", addedKeys: [], reason: "threshold_not_an_object" };
  }
  const missing = Object.keys(defaults).filter((key) => !(key in local));
  return missing.length === 0
    ? { action: "unchanged", addedKeys: [] }
    : { action: "updated", addedKeys: missing };
}

function planIgnoreRules(projectRoot) {
  const file = path.join(projectRoot, ".agent", ".gitignore");
  let body = "";
  try {
    body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  } catch (_) {
    return { action: "skipped", added: [], reason: "gitignore_unreadable" };
  }
  const present = new Set(
    body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  );
  const missing = RUNTIME_IGNORE_PATTERNS.filter((line) => !present.has(line));
  return missing.length === 0
    ? { action: "unchanged", added: [] }
    : { action: "updated", added: missing };
}

/**
 * Read-only preview of what `ensureGraphifyIntegration` would change.
 */
function planGraphifyIntegration(projectRoot) {
  if (!isGraphifyOptedIn(projectRoot)) {
    return { ok: true, optedIn: false, needsWork: false };
  }
  const runtime = readRuntimeStatus(projectRoot);
  const assets = {
    threshold: planThresholdConfig(projectRoot),
    ignore: planIgnoreRules(projectRoot),
  };
  const state = graphifyLib.hook.detectPluginState(projectRoot);
  const needsWork = !runtime.inSync
    || assets.threshold.action !== "unchanged"
    || assets.ignore.action !== "unchanged"
    || !state.hooksInstalled;
  return { ok: true, optedIn: true, needsWork, runtime, assets, hook: state };
}

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
  // Refuse a partial install. The hook, density guard, and full rebuild
  // runner form one runtime set; copying whichever files happen to exist
  // could leave an older project with a mixed implementation.
  const missingSources = RUNTIME_FILES.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
  if (missingSources.length > 0) {
    return {
      ok: false,
      action: "skipped",
      reason: "framework_runtime_incomplete",
      missing: missingSources,
    };
  }
  try {
    // Load the public entrypoint before touching the consumer copy. This
    // catches a missing sibling dependency while the existing runtime is
    // still intact.
    require(path.join(sourceDir, "index.js"));
  } catch (error) {
    return {
      ok: false,
      action: "skipped",
      reason: "framework_runtime_unloadable",
      detail: error && error.message ? error.message : String(error),
    };
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
    const temporary = `${dest}.runtime-tmp-${process.pid}`;
    try {
      fs.copyFileSync(src, temporary);
      fs.renameSync(temporary, dest);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) { /* no staged file */ }
      throw error;
    }
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
  const ignored = ensureRuntimeIgnoreEntries(projectRoot);
  return { ok: true, action, files, updated, ignored };
}

/**
 * Ensure the plugin's runtime state is ignored by the project.
 *
 * The ignore file is `.agent/.gitignore` — the same file the template
 * ships. It is written APPEND-ONLY and idempotently: an existing entry is
 * never rewritten or reordered, and a file the project does not have yet is
 * created with just these entries.
 *
 * Returns { ok, path, added: [...] }.
 */
function ensureRuntimeIgnoreEntries(projectRoot) {
  const ignorePath = path.join(projectRoot, ".agent", ".gitignore");
  let current = "";
  try {
    current = fs.readFileSync(ignorePath, "utf8");
  } catch (_) {
    current = "";
  }
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = RUNTIME_IGNORE_PATTERNS.filter((pattern) => !existing.has(pattern));
  if (missing.length === 0) return { ok: true, path: ignorePath, added: [] };
  try {
    fs.mkdirSync(path.dirname(ignorePath), { recursive: true });
    const header = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    const block = `${header}# Graphify plugin runtime state (framework-owned, local only).\n${missing.join("\n")}\n`;
    fs.appendFileSync(ignorePath, block);
  } catch (_) {
    // The ignore entries are a hygiene measure, never a hard dependency:
    // a project that cannot write them still gets a working hook.
    return { ok: false, path: ignorePath, added: [] };
  }
  return { ok: true, path: ignorePath, added: missing };
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

/**
 * Bring a project's Graphify integration up to the current framework
 * version. This is the single entry point the upgrade path uses, so an
 * existing project converges to the same capability as a freshly
 * initialized one:
 *
 *   1. the shared runtime is installed into the project (verbatim),
 *   2. the project-owned assets are refreshed additively (threshold.json,
 *      .gitignore) — project-chosen values are never overwritten,
 *   3. the Git post-commit hook is wired (idempotent, never overwrites an
 *      unrelated user hook).
 *
 * `apply: false` produces a read-only preview instead of writing.
 */
function ensureGraphifyIntegration(projectRoot, { apply = true } = {}) {
  if (!projectRoot) {
    return { ok: false, action: "skipped", reason: "project_root_required" };
  }
  if (!isGraphifyOptedIn(projectRoot)) {
    return { ok: true, action: "skipped", reason: "graphify_not_opted_in" };
  }
  if (!apply) {
    return Object.assign({ action: "preview" }, planGraphifyIntegration(projectRoot));
  }

  const hook = ensureGraphifyPostCommitHook(projectRoot);
  const assets = refreshGraphifyPluginAssets(projectRoot);
  const runtime = readRuntimeStatus(projectRoot);

  // A project that is not a Git repository cannot carry a post-commit
  // hook. That is not an upgrade failure — the runtime and the assets are
  // still refreshed — so it is reported as a skip, not an error.
  const hookSkipped = hook && hook.reason === "not_a_git_repo";
  const hookOk = hook && (hook.ok === true || hookSkipped);

  return {
    ok: hookOk !== false && assets.ok !== false && runtime.inSync !== false,
    action: "applied",
    runtime,
    assets,
    hook,
  };
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
  ensureGraphifyIntegration,
  readGraphifyHookStatus,
  installGraphifyRuntime,
  ensureRuntimeIgnoreEntries,
  readRuntimeStatus,
  refreshGraphifyPluginAssets,
  planGraphifyIntegration,
  readUnwiredMarker,
  clearUnwiredMarker,
  UNWIRED_MARKER_NAME,
  RUNTIME_IGNORE_PATTERNS,
};
