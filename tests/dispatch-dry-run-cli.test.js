"use strict";

// ─── dispatch dry-run CLI tests (FAE-003 / M-013 MS-004) ──────────────────
//
// Coverage: cortex-agent dispatch dry-run <task-id> via bin/cli.js,
// tree-diff proof of zero mutation, --output json|human, --fail-on-conflict.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m013-dryrun-"));
  for (const sub of ["runs", "queues", "sessions", "decisions", "waitpoints", "locks"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function captureTree(root) {
  const files = new Map();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          files.set(full, { size: st.size, mtimeMs: st.mtimeMs });
        } catch (_) { /* ignore */ }
      }
    }
  }
  walk(root);
  return files;
}

test("VC-013-04-cli-01 dispatch dry-run JSON output is well-formed", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"),
      "dispatch", "dry-run", "T-DEMO-1",
      "--project", root,
      "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.task_id, "T-DEMO-1");
    assert.equal(json.would_proceed, true);
    assert.ok(json._meta);
    assert.ok(json.idempotency);
    assert.ok(json.concurrency);
    assert.ok(json.locks);
    assert.ok(json.worktree);
    assert.equal(json.mutation_evidence.mutated_count, 0);
  } finally { rmProject(root); }
});

test("VC-013-04-cli-02 dispatch dry-run --json shortcut produces identical shape", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"),
      "dispatch", "dry-run", "T-DEMO-2",
      "--project", root,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.task_id, "T-DEMO-2");
  } finally { rmProject(root); }
});

test("VC-013-04-cli-03 dispatch dry-run human output is human-readable", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"),
      "dispatch", "dry-run", "T-DEMO-3",
      "--project", root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.ok(/dispatch dry-run task_id=T-DEMO-3/.test(result.stdout));
    assert.ok(/would_proceed=/.test(result.stdout));
    assert.ok(/idempotency.key=/.test(result.stdout));
  } finally { rmProject(root); }
});

test("VC-013-04-cli-04 dispatch dry-run exits 3 on --fail-on-conflict when run exists", () => {
  const root = mkProject();
  try {
    fs.writeFileSync(path.join(root, ".agent/runs/R-EXIST.json"), JSON.stringify({
      run_id: "R-EXIST", task_id: "T-CONFLICT", phase: "EXECUTE_FEATURE",
    }));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"),
      "dispatch", "dry-run", "T-CONFLICT",
      "--project", root,
      "--output", "json",
      "--fail-on-conflict",
    ], { encoding: "utf8" });
    assert.equal(result.status, 3);
    const json = JSON.parse(result.stdout);
    assert.equal(json.would_proceed, false);
  } finally { rmProject(root); }
});

test("VC-013-04-cli-05 dispatch dry-run causes zero file mutation in project root", () => {
  const root = mkProject();
  try {
    const before = captureTree(root);
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"),
      "dispatch", "dry-run", "T-MUT-1",
      "--project", root,
      "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const after = captureTree(root);
    assert.equal(before.size, after.size, `before=${before.size} after=${after.size}`);
    for (const [file, info] of before) {
      const newInfo = after.get(file);
      assert.ok(newInfo, `file should still exist: ${file}`);
      assert.equal(newInfo.size, info.size);
      assert.equal(newInfo.mtimeMs, info.mtimeMs);
    }
  } finally { rmProject(root); }
});

test("VC-013-04-cli-06 dispatch (without dry-run) is still Phase 0 stub", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"),
    "dispatch", "execute", "T-DEMO",
    "--project", process.cwd(),
    "--json",
  ], { encoding: "utf8" });
  // Phase 0 stub: exits 2, returns ok:false not_implemented.
  assert.equal(result.status, 2);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.equal(json.implemented, false);
  assert.equal(json.phase, 0);
});

test("VC-013-04-cli-07 dispatch dry-run missing task-id returns exit 2 + usage", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"),
      "dispatch", "dry-run",
      "--project", root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.ok(/<task-id> required/.test(result.stderr));
  } finally { rmProject(root); }
});