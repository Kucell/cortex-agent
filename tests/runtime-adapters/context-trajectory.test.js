"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SELECT = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "select.js");
const MANAGEMENT = path.join(ROOT, ".agent", "skills", "management-api", "scripts", "index.js");
const {
  validateContextTrajectory,
} = require("../../lib/runtime-adapters/context-trajectory.js");

function sha(char) { return `sha256:${char.repeat(64)}`; }

function fixture(overrides = {}) {
  return {
    schema_version: "2.0",
    trajectory_id: "CTX-test",
    task_id: "T-test",
    created_at: "2026-07-28T00:00:00.000Z",
    stages: [
      { type: "discovered", status: "confirmed", source: "context-index", items: [{ uri: "cortex://references/auth", revision: sha("a") }] },
      { type: "selected", status: "confirmed", source: "selector", items: [{ uri: "cortex://references/auth", tier: "L1", estimated_tokens: 12 }] },
      { type: "rendered", status: "unavailable", source: "not-exposed", items: [] },
      { type: "confirmed-consumed", status: "unavailable", source: "not-exposed", items: [] },
    ],
    usage: {
      estimated_selected_tokens: 12,
      host_reported_input_tokens: "unknown",
      host_reported_cache_tokens: "unknown",
      measurement_source: "unavailable",
    },
    outcome_refs: [],
    ...overrides,
  };
}

function createProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-context-trajectory-"));
  fs.mkdirSync(path.join(project, ".agent", "plans"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agent", "runtime-evidence", "context-trajectories"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agent", "tasks", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agent", "plans", "task-progress.md"), "# Tasks\n");
  fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"), path.join(project, ".agent", "tasks", "scripts", "task-state.js"));
  return project;
}

test("trajectory contract keeps discovered, selected, rendered, and confirmed-consumed distinct", () => {
  const value = validateContextTrajectory(fixture());
  assert.deepEqual(value.stages.map((stage) => stage.type), ["discovered", "selected", "rendered", "confirmed-consumed"]);
  assert.equal(value.stages[2].status, "unavailable");
  assert.equal(value.stages[3].status, "unavailable");
  assert.equal(value.usage.host_reported_input_tokens, "unknown");
});

test("consumption and rendering cannot be inferred from selection", () => {
  const inferredConsumption = fixture();
  inferredConsumption.stages[3] = { type: "confirmed-consumed", status: "confirmed", source: "selector", items: [] };
  assert.throws(() => validateContextTrajectory(inferredConsumption), (error) => error.code === "ERR_CONSUMPTION_NOT_CONFIRMED");

  const inferredRender = fixture();
  inferredRender.stages[2] = { type: "rendered", status: "confirmed", source: "context-index", items: [] };
  assert.throws(() => validateContextTrajectory(inferredRender), (error) => error.code === "ERR_RENDER_NOT_CONFIRMED");
});

test("closed evidence schema rejects prompt/file bodies, secrets, and unsupported token claims", () => {
  for (const [field, value] of [["prompt", "private prompt"], ["file_body", "source body"], ["secret", "sk-secret"], ["exact_tokens", 12]]) {
    const candidate = fixture({ [field]: value });
    assert.throws(() => validateContextTrajectory(candidate), (error) => error.code === "ERR_FIELD_UNKNOWN", field);
  }
  const unsupported = fixture();
  unsupported.usage.host_reported_input_tokens = 99;
  assert.throws(() => validateContextTrajectory(unsupported), (error) => error.code === "ERR_HOST_USAGE_UNSUPPORTED");
});

test("selector writes v2 evidence without task prompt and leaves consumption unavailable", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, ".agent", "context-index.json"), JSON.stringify({ modules: [{ module: "auth", module_path: "auth", summary: "oauth authentication", estimated_tokens: 20 }] }));
  const prompt = "implement oauth with DO-NOT-PERSIST-PROMPT";
  const result = spawnSync(process.execPath, [SELECT, "--task", prompt, "--task-id", "T-observe", "--llm-window", "1000"], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const raw = fs.readFileSync(output.context_trajectory_path, "utf8");
  assert.equal(raw.includes(prompt), false);
  assert.equal(raw.includes("DO-NOT-PERSIST-PROMPT"), false);
  const trajectory = validateContextTrajectory(JSON.parse(raw));
  assert.equal(trajectory.stages.find((stage) => stage.type === "rendered").status, "unavailable");
  assert.equal(trajectory.stages.find((stage) => stage.type === "confirmed-consumed").status, "unavailable");
});

test("focused Management API projection filters by correlation and strips unknown bodies", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const evidence = fixture({ run_id: "R-1", session_id: "S-1", host_profile_ref: "HOST-1", prompt: "must-not-project" });
  fs.writeFileSync(path.join(project, ".agent", "runtime-evidence", "context-trajectories", "one.json"), JSON.stringify(evidence));
  const result = spawnSync(process.execPath, [MANAGEMENT, "query", "context-trajectories", "--task", "T-test", "--run", "R-1"], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.context_trajectories.length, 1);
  assert.equal(JSON.stringify(payload).includes("must-not-project"), false);
  assert.deepEqual(payload.filters, { task: "T-test", run: "R-1" });
  assert.deepEqual(payload.summary, { total: 1, rendered_confirmed: 0, consumed_confirmed: 0 });
});
