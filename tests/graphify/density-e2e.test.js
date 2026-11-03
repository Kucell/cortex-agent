"use strict";

// ─── Graphify edge-density end-to-end test (issue #154) ────────────────────
//
// Walks the complete closed loop inside a DISPOSABLE consumer project:
//
//   incremental update -> density drop detected -> detached full rebuild
//   started -> baseline written back
//
// The consumer project is materialised the way `cortex-agent init` builds
// it: the shipped template files are copied in, and the framework's shared
// implementation is installed next to the plugin through the same helper
// the framework uses. That is what makes this an end-to-end test rather
// than a unit test: the shipped wrapper, the installed runtime and the
// template configuration all have to line up for the loop to close.
//
// `graphify` is replaced by a STUB executable on PATH. The real CLI is not
// needed (and not available in every environment): the stub records the
// arguments it was called with and writes the graph state the scenario
// calls for. That keeps the test hermetic and fast while still exercising
// the real spawn/detach/stamp plumbing.
//
// Every artifact lives under the repository's `.agent-work/` scratch
// directory -- never in the temp directory.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const WORK_ROOT = path.join(ROOT, ".agent-work", "test-density-e2e");
const TEMPLATE_PLUGIN = path.join(ROOT, "templates", "_shared", ".agent", "plugins", "graphify");
const graphifyHook = require("../../lib/setup/graphify-hook");
const density = require("../../lib/graphify/density");

// ── The graphify stub ───────────────────────────────────────────────────────

// The stub writes its call log into the project it runs in, so the test can
// assert which command ran (and that the FULL build ran, not an update).
function installGraphifyStub(projectRoot) {
  const binDir = path.join(projectRoot, "stub-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "graphify");
  const script = [
    "#!/usr/bin/env node",
    '"use strict";',
    "const fs = require('fs');",
    "const path = require('path');",
    "const cwd = process.cwd();",
    "const logFile = path.join(cwd, 'stub-calls.log');",
    "fs.appendFileSync(logFile, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }) + '\\n');",
    "const stateFile = path.join(cwd, 'stub-state.json');",
    "let state = { nodes: 0, edges: 0 };",
    "try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}",
    "const full = process.argv[2] === '.';",
    "const nodes = full ? state.fullNodes : state.nodes;",
    "const edges = full ? state.fullEdges : state.edges;",
    "const outDir = path.join(cwd, 'graphify-out');",
    "fs.mkdirSync(outDir, { recursive: true });",
    "const graph = { directed: true, multigraph: false, graph: {},",
    "  nodes: Array.from({ length: nodes }, (_, i) => ({ id: 'n' + i })),",
    "  links: Array.from({ length: edges }, (_, i) => ({ source: 'n' + (i % Math.max(nodes,1)), target: 'n0' })),",
    "  hyperedges: [], built_at_commit: 'stub' };",
    "fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify(graph, null, 2));",
    "process.exit(0);",
    "",
  ].join("\n");
  fs.writeFileSync(stub, script, { mode: 0o755 });
  return binDir;
}

// The wrapper classifies the last commit's changed paths to decide between
// an incremental update and a stale marker. Without a repository of its
// own the project would inherit the enclosing checkout's history, so the
// scenario would depend on where the test happens to run. The project gets
// its own repository with one code file, which is what makes the hook take
// the incremental path deterministically.
function initProjectGit(projectRoot) {
  const git = (...args) => spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "module.js"), "export function f() { return 1; }\n");
  git("add", "-A");
  git("commit", "-qm", "init");
}

function readStubCalls(projectRoot) {
  const file = path.join(projectRoot, "stub-calls.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── The consumer project ────────────────────────────────────────────────────

function makeConsumerProject(name) {
  const root = path.join(WORK_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const pluginDir = path.join(root, ".agent", "plugins", "graphify");
  fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "graphify-out"), { recursive: true });

  // The shipped template files, exactly as `cortex-agent init` lays them down.
  fs.copyFileSync(
    path.join(TEMPLATE_PLUGIN, "scripts", "post-commit-update.js"),
    path.join(pluginDir, "scripts", "post-commit-update.js"),
  );
  fs.copyFileSync(
    path.join(TEMPLATE_PLUGIN, "scripts", "full-rebuild-with-stamp.js"),
    path.join(pluginDir, "scripts", "full-rebuild-with-stamp.js"),
  );
  fs.copyFileSync(
    path.join(TEMPLATE_PLUGIN, "config.yml"),
    path.join(pluginDir, "config.yml"),
  );
  // The threshold configuration the project carries.
  fs.copyFileSync(
    path.join(TEMPLATE_PLUGIN, "threshold.json"),
    path.join(pluginDir, "threshold.json"),
  );

  // The framework installs its shared implementation next to the plugin.
  const runtime = graphifyHook.installGraphifyRuntime(root);
  assert.equal(runtime.ok, true, "runtime install failed: " + (runtime.reason || "unknown"));

  const binDir = installGraphifyStub(root);
  initProjectGit(root);
  return { root, pluginDir, binDir };
}

function writeStubState(projectRoot, state) {
  fs.writeFileSync(path.join(projectRoot, "stub-state.json"), JSON.stringify(state, null, 2));
}

function runWrapper(projectRoot, binDir) {
  const wrapper = path.join(projectRoot, ".agent", "plugins", "graphify", "scripts", "post-commit-update.js");
  return spawnSync(process.execPath, [wrapper], {
    cwd: projectRoot,
    encoding: "utf8",
    env: Object.assign({}, process.env, { PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` }),
  });
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

// ── The closed loop ─────────────────────────────────────────────────────────

test("e2e: incremental update -> density drop -> detached full rebuild -> baseline written back", async () => {
  const { root, binDir } = makeConsumerProject("closed-loop");
  try {
    // A project whose threshold configuration activates the guard.
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "threshold.json"),
      JSON.stringify({
        min_nodes_for_check: 10,
        ratio_drop_threshold: 0.85,
        baseline_edge_node_ratio: null,
        full_rebuild_timeout_seconds: 60,
        rebuild_cooldown_seconds: 0,
      }, null, 2),
    );

    // Step 1: a FULL build establishes the baseline.
    //   100 nodes / 200 edges -> ratio 2.0
    writeStubState(root, { nodes: 100, edges: 200, fullNodes: 100, fullEdges: 200 });
    const full = spawnSync(path.join(binDir, "graphify"), ["."], { cwd: root, encoding: "utf8" });
    assert.equal(full.status, 0, "the full build stub must succeed");
    const stamped = density.stampBaseline(root, { nodes: 100, edges: 200, buildKind: "full" });
    assert.equal(stamped.ok, true);
    assert.equal(stamped.ratio, 2);

    // Step 2: the incremental update degrades the graph.
    //   100 nodes / 60 edges -> ratio 0.6, below baseline * 0.85 = 1.7
    writeStubState(root, { nodes: 100, edges: 60, fullNodes: 100, fullEdges: 200 });

    const run = runWrapper(root, binDir);
    assert.equal(run.status, 0, "the hook must never block the commit");

    // The incremental update ran and the density drop was detected.
    const calls = readStubCalls(root);
    const updateCall = calls.find((c) => c.args[0] === "update");
    assert.ok(updateCall, "the hook must run `graphify update .`");
    assert.match(run.stderr, /edge density/i,
      "the hook must report the density drop");

    // Step 3: the detached full rebuild was started and the baseline was
    // written back. The rebuild is detached, so wait for it to finish.
    const baselineFile = density.baselinePath(root);
    const rebuilt = await waitFor(() => {
      const callsNow = readStubCalls(root);
      return callsNow.some((c) => c.args[0] === ".");
    }, 20000);
    assert.ok(rebuilt, "a detached full rebuild must have been started");

    await waitFor(() => {
      const sidecar = density.readBaselineSidecar(root);
      return sidecar && sidecar.edge_node_ratio === 2;
    }, 20000);
    const sidecar = density.readBaselineSidecar(root);
    assert.ok(sidecar, "the full rebuild must write the baseline sidecar");
    assert.equal(sidecar.edge_node_ratio, 2, "the baseline must be restored to the full-build ratio");
    assert.equal(sidecar.build_kind, "full");

    // The rebuild log lands under .agent/, never in the temp directory.
    const logDir = path.join(root, ".agent", "logs", "graphify");
    assert.equal(fs.existsSync(logDir), true, "the rebuild log must live under .agent/logs/");
    const logs = fs.readdirSync(logDir);
    assert.ok(logs.some((n) => n.startsWith("full-rebuild-") && n.endsWith(".log")),
      "a full-rebuild log must be written");
  } finally {
    cleanup(root);
  }
});

test("e2e: a healthy density does not start a rebuild", () => {
  const { root, binDir } = makeConsumerProject("healthy");
  try {
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "threshold.json"),
      JSON.stringify({
        min_nodes_for_check: 10,
        ratio_drop_threshold: 0.85,
        baseline_edge_node_ratio: 2.0,
        full_rebuild_timeout_seconds: 60,
        rebuild_cooldown_seconds: 0,
      }, null, 2),
    );
    // The incremental state keeps the ratio at 1.9, above 2.0 * 0.85.
    writeStubState(root, { nodes: 100, edges: 190, fullNodes: 100, fullEdges: 200 });
    const run = runWrapper(root, binDir);
    assert.equal(run.status, 0);
    const calls = readStubCalls(root);
    assert.ok(calls.find((c) => c.args[0] === "update"), "the incremental update must run");
    assert.equal(calls.find((c) => c.args[0] === "."), undefined,
      "a healthy density must not start a full rebuild");
    assert.equal(fs.existsSync(density.baselinePath(root)), false,
      "the incremental path must not write the baseline");
  } finally {
    cleanup(root);
  }
});

test("e2e: the shared implementation the wrapper resolves carries the density guard", () => {
  // The consumer project's wrapper resolves the implementation relative to
  // its own directory. The resolved module MUST carry the guard, otherwise
  // the consumer project silently loses the capability again.
  const { root } = makeConsumerProject("resolution");
  try {
    const resolved = path.join(root, ".agent", "plugins", "graphify", "lib", "graphify", "hook.js");
    assert.equal(fs.existsSync(resolved), true, "the shared implementation must be installed");
    const hookLib = require(resolved);
    assert.equal(typeof hookLib.runPostCommit, "function");
    assert.ok(hookLib.HOOK_RESULT.DENSITY_REBUILD_STARTED,
      "the resolved implementation must expose the density result");
    const densityResolved = path.join(root, ".agent", "plugins", "graphify", "lib", "graphify", "density.js");
    assert.equal(fs.existsSync(densityResolved), true,
      "the density module must be installed alongside the hook");
    const densityLib = require(densityResolved);
    assert.equal(typeof densityLib.checkAndMaybeRebuild, "function");
  } finally {
    cleanup(root);
  }
});

test("e2e: the runtime install makes the plugin's runtime state ignored", () => {
  // The template `.agent/.gitignore` is copied ADDITIVELY, so a project
  // that already has one never receives later template additions. A
  // project tracking `.agent/` would therefore start seeing the density
  // baseline, the cooldown marker and the rebuild logs as new files.
  const { root } = makeConsumerProject("ignore-entries");
  try {
    const ignorePath = path.join(root, ".agent", ".gitignore");
    // Pre-existing ignore file, as an established project would have.
    fs.writeFileSync(ignorePath, "metrics/agent-dashboard.html\nsessions/S-*.json\n");
    const before = fs.readFileSync(ignorePath, "utf8");

    const result = graphifyHook.ensureRuntimeIgnoreEntries(root);
    assert.equal(result.ok, true);
    assert.ok(result.added.includes("plugins/graphify/.density-baseline.json"));
    assert.ok(result.added.includes("plugins/graphify/.density-rebuild-state.json"));
    assert.ok(result.added.includes("logs/graphify/"));

    const after = fs.readFileSync(ignorePath, "utf8");
    // The pre-existing content is preserved verbatim.
    assert.ok(after.startsWith(before));

    // Idempotent: a second call adds nothing.
    const second = graphifyHook.ensureRuntimeIgnoreEntries(root);
    assert.equal(second.ok, true);
    assert.deepEqual(second.added, []);
    assert.equal(fs.readFileSync(ignorePath, "utf8"), after);
  } finally {
    cleanup(root);
  }
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

