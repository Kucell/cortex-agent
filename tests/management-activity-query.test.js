"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const FILES = ["index.js", "normalize-token-usage.js", "projection-registry.json", "query-activity.js"];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-activity-"));
  const scripts = path.join(project, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", file), path.join(scripts, file));
  const taskScripts = path.join(project, ".agent", "tasks", "scripts");
  fs.mkdirSync(taskScripts, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"), path.join(taskScripts, "task-state.js"));
  writeJson(path.join(project, ".agent", "runs", "R-1.json"), {
    run_id: "R-1", task_id: "T-1", mission_id: "M-1", status: "completed", started_at: "2026-07-12T16:00:00.000Z",
    events: [
      { type: "validation_passed", status: "completed", message: "Boundary start", at: "2026-07-12T16:00:00.000Z" },
      { type: "completed", status: "completed", message: "Boundary end", at: "2026-07-19T15:59:59.999Z" },
      { type: "completed", status: "completed", message: "Outside", at: "2026-07-19T16:00:00.000Z" },
    ],
  });
  writeJson(path.join(project, ".agent", "sessions", "S-1.json"), { session_id: "S-1", agent_id: "a", role: "worker", status: "closed", started_at: "2026-07-15T00:00:00.000Z", updated_at: "2026-07-15T01:00:00.000Z" });
  writeJson(path.join(project, ".agent", "decisions", "D-1.json"), { decision_id: "D-1", status: "approved", prompt: "Approve", resolved_at: "2026-07-16T00:00:00.000Z", relations: { task_ids: ["T-1"] } });
  writeJson(path.join(project, ".agent", "handoffs", "H-1.json"), { handoff_id: "H-1", task_id: "T-1", next_action: "Continue", produced_at: "2026-07-17T00:00:00.000Z", artifacts: { artifact_refs: ["artifact:1"] } });
  writeJson(path.join(project, ".agent", "artifacts", "T-1", "001.json"), { artifact_id: "A-1", task_id: "T-1", kind: "validation", summary: "Validated", produced_at: "2026-07-18T00:00:00.000Z" });
  writeJson(path.join(project, ".agent", "tasks", "T-unknown.json"), { task_id: "T-unknown", title: "No timestamp", status: "draft" });
  fs.writeFileSync(path.join(project, ".agent", "plans.md"), "completed 2026-07-18", "utf8");
  return project;
}

function run(project, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: project, encoding: "utf8", env: { ...process.env, LANG: "en_US.UTF-8", TZ: "Asia/Shanghai" } });
}

test("activity uses inclusive local-date boundaries and stable structured facts", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const result = run(project, ["query", "activity", "--since", "2026-07-13", "--until=2026-07-19"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.filters.timezone, "Asia/Shanghai");
  assert.equal(payload.filters.inclusive, true);
  assert.deepEqual(payload.data.activity.map((item) => item.title).filter((title) => title.startsWith("Boundary")), ["Boundary end", "Boundary start"]);
  assert.equal(payload.data.activity.some((item) => item.title === "Outside"), false);
  assert.equal(payload.data.activity.some((item) => item.kind === "validation" && item.resource_id === "A-1"), true);
  assert.equal(payload.data.activity.find((item) => item.title === "Boundary start").relations.task_id, "T-1");
  assert.equal(payload.data.unknown_time.some((item) => item.resource_id === "T-unknown" && item.time_state === "unknown"), true);
  assert.equal(payload.data.activity.some((item) => item.title.includes("completed 2026")), false, "plan text must not become activity");
});

test("activity rejects invalid and reversed date filters", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const [args, code] of [
    [["query", "activity", "--since", "2026-02-30"], "INVALID_SINCE"],
    [["query", "activity", "--since", "2026-07-20", "--until", "2026-07-19"], "INVALID_TIME_RANGE"],
    [["query", "runs", "--since", "2026-07-13"], "INVALID_QUERY_OPTION"],
  ]) {
    const result = run(project, args);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, code);
  }
});
