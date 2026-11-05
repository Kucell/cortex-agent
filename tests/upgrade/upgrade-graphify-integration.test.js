"use strict";

// ─── Graphify integration in the upgrade path ─────────────────────────────────
//
// A project installed before the edge-density guard existed must converge to
// the same capability as a freshly initialized one when it upgrades:
//
//   1. the shared runtime is installed into the project,
//   2. the superseded wrapper is replaced by the current one,
//   3. the project-owned threshold.json gains the keys the newer framework
//      introduced — WITHOUT losing a single value the project chose,
//   4. the .gitignore covers the density state directory,
//   5. the Git post-commit hook is wired,
//   6. a second run changes nothing (idempotent).
//
// The fixture reproduces a real old project: the byte-identical copy of the
// wrapper that framework versions up to 1.15.7 published, a threshold.json
// without the density keys, and no runtime directory at all.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const TEMPLATE_WRAPPER = path.join(
  ROOT,
  "templates",
  "_shared",
  ".agent",
  "plugins",
  "graphify",
  "scripts",
  "post-commit-update.js",
);
const SUPERSEDED_WRAPPER = path.join(
  ROOT,
  "tests",
  "fixtures",
  "graphify",
  "post-commit-update.superseded.js",
);

function oldProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-graphify-upgrade-"));
  const plugin = path.join(cwd, ".agent", "plugins", "graphify");
  fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "config.yml"), "graphify:\n  version: 1\n", "utf8");
  fs.writeFileSync(
    path.join(plugin, "threshold.json"),
    JSON.stringify({
      min_nodes_for_check: 100,
      ratio_drop_threshold: 0.85,
      baseline_edge_node_ratio: 2.43,
      full_rebuild_timeout_seconds: 1500,
      repo: "legacy",
    }, null, 2) + "\n",
    "utf8",
  );
  fs.copyFileSync(SUPERSEDED_WRAPPER, path.join(plugin, "scripts", "post-commit-update.js"));
  fs.writeFileSync(path.join(cwd, ".agent", ".gitignore"), "plugins/graphify/.hook-installed\n", "utf8");
  spawnSync("git", ["init", "-q"], { cwd });
  return cwd;
}

function update(cwd) {
  return spawnSync(process.execPath, [CLI, "update"], { cwd, encoding: "utf8" });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("update: an old project converges to the full Graphify integration", () => {
  const cwd = oldProject();
  const result = update(cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // 1. the shared runtime is installed into the project.
  const runtime = path.join(cwd, ".agent", "plugins", "graphify", "lib", "graphify");
  for (const file of ["hook.js", "density.js", "density-gate.js", "full-rebuild-runner.js"]) {
    assert.ok(fs.existsSync(path.join(runtime, file)), "runtime file missing: " + file);
  }

  // 2. the superseded wrapper is replaced by the current one.
  const wrapper = path.join(cwd, ".agent", "plugins", "graphify", "scripts", "post-commit-update.js");
  assert.equal(
    fs.readFileSync(wrapper, "utf8"),
    fs.readFileSync(TEMPLATE_WRAPPER, "utf8"),
    "the superseded wrapper must be replaced by the current one",
  );

  // 3. the threshold gains the new keys and keeps every project value.
  const threshold = readJson(path.join(cwd, ".agent", "plugins", "graphify", "threshold.json"));
  assert.equal(threshold.baseline_edge_node_ratio, 2.43, "project baseline must survive");
  assert.equal(threshold.full_rebuild_timeout_seconds, 1500, "project timeout must survive");
  assert.equal(threshold.repo, "legacy", "unknown project keys must survive");
  assert.ok(Array.isArray(threshold.full_rebuild_args), "the rebuild args must be filled in");
  assert.equal(threshold.full_rebuild_args[0], "extract");
  assert.ok(threshold.full_rebuild_args.includes("--force"));

  // 4. the ignore rules cover the density state directory.
  const ignore = fs.readFileSync(path.join(cwd, ".agent", ".gitignore"), "utf8");
  assert.ok(ignore.includes("plugins/graphify/.density-worktrees/"));

  // 5. the update report states what was synced.
  const report = readJson(path.join(cwd, ".agent", "updates", "latest.json"));
  assert.ok(report.graphify, "the report must describe the Graphify sync");
  assert.equal(report.graphify.applied, true);
  assert.equal(report.graphify.result.runtime.inSync, true);
  assert.equal(report.graphify.result.assets.threshold.addedKeys.includes("full_rebuild_args"), true);
});

test("update: the Graphify sync is idempotent", () => {
  const cwd = oldProject();
  assert.equal(update(cwd).status, 0);
  const thresholdPath = path.join(cwd, ".agent", "plugins", "graphify", "threshold.json");
  const ignorePath = path.join(cwd, ".agent", ".gitignore");
  const first = {
    threshold: fs.readFileSync(thresholdPath, "utf8"),
    ignore: fs.readFileSync(ignorePath, "utf8"),
  };

  assert.equal(update(cwd).status, 0);
  assert.equal(fs.readFileSync(thresholdPath, "utf8"), first.threshold);
  assert.equal(fs.readFileSync(ignorePath, "utf8"), first.ignore);

  const report = readJson(path.join(cwd, ".agent", "updates", "latest.json"));
  assert.equal(report.graphify.result.assets.action, "unchanged");
});

test("update: a user-modified wrapper is not replaced", () => {
  const cwd = oldProject();
  const wrapper = path.join(cwd, ".agent", "plugins", "graphify", "scripts", "post-commit-update.js");
  const customized = fs.readFileSync(SUPERSEDED_WRAPPER, "utf8") + "\n// user patch\n";
  fs.writeFileSync(wrapper, customized, "utf8");

  // A protected local script makes the update report a partial completion —
  // that is the framework's designed outcome, not a crash.
  update(cwd);
  assert.equal(
    fs.readFileSync(wrapper, "utf8"),
    customized,
    "a locally modified wrapper must survive the upgrade",
  );
  const report = readJson(path.join(cwd, ".agent", "updates", "latest.json"));
  const protectedPaths = (report.changes && report.changes.protected || []).map((item) => item.path);
  assert.ok(
    protectedPaths.some((item) => item.endsWith("post-commit-update.js")),
    "the locally modified wrapper must be reported as protected",
  );
});
