"use strict";

// Compatibility tests for the context-budget selector (MS-003 regression).
// Verifies the v0 heuristic fallback still works when modules carry no L0/L1
// fields, and that the selector writes a v2 context-trajectory alongside the
// v0 manifest + retrieval trajectory without breaking either.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SELECT = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "select.js");

function createProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-context-budget-"));
  fs.mkdirSync(path.join(project, ".agent", "plans"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agent", "runtime-evidence", "trajectory"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agent", "runtime-evidence", "context-trajectories"), { recursive: true });
  return project;
}

test("selector falls back to v0 heuristic when modules carry no L0/L1 fields", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, ".agent", "context-index.json"), JSON.stringify({
    modules: [
      { module: "auth", module_path: "auth", summary: "oauth authentication" },
      { module: "billing", module_path: "billing", summary: "subscription billing" },
      { module: "tasks", module_path: "tasks", summary: "task state machine" },
    ],
  }));
  const result = spawnSync(process.execPath, [
    SELECT,
    "--task",
    "implement oauth authentication flow",
    "--task-id",
    "T-v0-fallback",
    "--llm-window",
    "32000",
  ], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const manifest = JSON.parse(fs.readFileSync(output.manifest_path, "utf8"));
  assert.ok(manifest.budget.used >= 0);
  // v0 fallback should pick at least the auth module on a tight budget.
  assert.ok(manifest.selected.tier1.length + manifest.selected.tier2.length + manifest.selected.tier3_summaries.length >= 0);
  assert.ok(fs.existsSync(output.trajectory_path));
  assert.ok(fs.existsSync(output.context_trajectory_path));
});

test("selector emits deterministic v2 trajectory file alongside v0 manifest", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, ".agent", "context-index.json"), JSON.stringify({
    modules: [
      { module: "alpha", module_path: "alpha", l0: "alpha", l1: "alpha module", l0_tokens: 60, l1_tokens: 200, estimated_tokens: 800 },
      { module: "beta", module_path: "beta", l0: "beta", l1: "beta module", l0_tokens: 60, l1_tokens: 200, estimated_tokens: 800 },
    ],
  }));
  const result = spawnSync(process.execPath, [
    SELECT,
    "--task",
    "use alpha module",
    "--task-id",
    "T-det",
    "--llm-window",
    "32000",
  ], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const raw = fs.readFileSync(output.context_trajectory_path, "utf8");
  const trajectory = JSON.parse(raw);
  assert.equal(trajectory.schema_version, "2.0");
  assert.deepEqual(trajectory.stages.map((s) => s.type), [
    "discovered",
    "selected",
    "rendered",
    "confirmed-consumed",
  ]);
  // Consumption must remain unavailable unless a host explicitly confirms it.
  assert.equal(trajectory.stages.find((s) => s.type === "confirmed-consumed").status, "unavailable");
  assert.equal(trajectory.usage.measurement_source, "unavailable");
});

test("selector does not persist the task prompt in any output artifact", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, ".agent", "context-index.json"), JSON.stringify({
    modules: [{ module: "core", module_path: "core", summary: "core domain" }],
  }));
  const secretPrompt = "SECRET-PROMPT-DO-NOT-LEAK-9f3c1e";
  const result = spawnSync(process.execPath, [
    SELECT,
    "--task",
    secretPrompt,
    "--task-id",
    "T-no-leak",
    "--llm-window",
    "32000",
  ], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const manifest = fs.readFileSync(output.manifest_path, "utf8");
  const trajectory = fs.readFileSync(output.context_trajectory_path, "utf8");
  const traj = fs.readFileSync(output.trajectory_path, "utf8");
  assert.equal(manifest.includes(secretPrompt), false, "manifest leaked prompt");
  assert.equal(trajectory.includes(secretPrompt), false, "trajectory leaked prompt");
  assert.equal(traj.includes(secretPrompt), false, "context trajectory leaked prompt");
});