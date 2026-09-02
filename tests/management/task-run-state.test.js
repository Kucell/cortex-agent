"use strict";

// ─── task-state / run-state projection tests (P-007 §3.4) ───────────────────
//
// Coverage: .agent/skills/management-api/scripts/query-task-state.js and
// query-run-state.js — exact-lookup projection returning compact summaries
// (not full task.json events) so the agent pulls state on demand instead
// of carrying it in chat context.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { project: projectTask } = require("../../.agent/skills/management-api/scripts/query-task-state.js");
const { project: projectRun } = require("../../.agent/skills/management-api/scripts/query-run-state.js");

const ROOT = path.resolve(__dirname, "..", "..");
const MGMT_CLI = path.join(ROOT, ".agent", "skills", "management-api", "scripts", "index.js");

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p007-taskrun-"));
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ─── query-task-state.js unit ──────────────────────────────────────────────

test("task-state: returns compact summary for valid task", () => {
  const root = mkProject();
  try {
    writeJSON(path.join(root, ".agent/tasks/T-001.json"), {
      task_id: "T-001",
      title: "demo task",
      description: "verify task-state projection",
      status: "active",
      stage: "implement",
      priority: "P0",
      owner: "root",
      collaborators: ["agent-1", "agent-2"],
      acceptance_criteria: ["a", "b", "c", "d", "e"],
      dependencies: ["T-000"],
      subtasks: ["T-002"],
      source_refs: ["a.md", "b.md", "c.md"],
      validation_commands: ["node test", "node test2", "node test3"],
      required_artifacts: [{ kind: "run", required_for_stage: "done" }],
      artifacts: [],
      gates: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    });
    const r = projectTask(root, "T-001");
    assert.equal(r.ok, true);
    assert.equal(r.task.task_id, "T-001");
    assert.equal(r.task.status, "active");
    assert.equal(r.task.stage, "implement");
    assert.equal(r.task.priority, "P0");
    assert.equal(r.task.collaborators.length, 2);
    assert.equal(r.task.subtasks.length, 1);
    assert.equal(r.task.dependencies.length, 1);
    assert.equal(r.task.source_refs_count, 3);
    // acceptance_criteria preview truncated to first 3
    assert.equal(r.task.acceptance_criteria_preview.length, 3);
    // validation_commands preview truncated to first 2
    assert.equal(r.task.validation_commands_preview.length, 2);
  } finally {
    rmProject(root);
  }
});

test("task-state: rejects invalid task id", () => {
  const r = projectTask("/tmp", "not-a-task-id");
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_task_id");
});

test("task-state: returns task_not_found for missing file", () => {
  const r = projectTask("/tmp", "T-XXX");
  assert.equal(r.ok, false);
  assert.equal(r.error, "task_not_found");
});

test("task-state: handles missing acceptance_criteria/validation_commands gracefully", () => {
  const root = mkProject();
  try {
    writeJSON(path.join(root, ".agent/tasks/T-002.json"), {
      task_id: "T-002",
      title: "minimal",
      description: "no optional fields",
      status: "draft",
      stage: "draft",
      priority: "P3",
      owner: null,
      collaborators: [],
      acceptance_criteria: [],
      dependencies: [],
      subtasks: [],
      required_artifacts: [],
      artifacts: [],
      gates: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const r = projectTask(root, "T-002");
    assert.equal(r.ok, true);
    assert.deepEqual(r.task.acceptance_criteria_preview, []);
    assert.deepEqual(r.task.validation_commands_preview, []);
    assert.equal(r.task.source_refs_count, 0);
  } finally {
    rmProject(root);
  }
});

// ─── query-run-state.js unit ───────────────────────────────────────────────

test("run-state: returns compact summary with recent events", () => {
  const root = mkProject();
  try {
    const now = "2026-08-14T00:00:00.000Z";
    const events = [];
    for (let i = 0; i < 12; i++) {
      events.push({ type: "run_updated", status: "running", at: `2026-08-14T00:0${i}:00.000Z` });
    }
    writeJSON(path.join(root, ".agent/runs/R-001.json"), {
      run_id: "R-001",
      task_id: "T-001",
      mission_id: "M-025",
      agent_id: "pi",
      role: "implementer",
      kind: "implement",
      status: "running",
      phase: "implementing",
      worktree_path: "/tmp/wt",
      branch: "agent/test",
      activity: "doing things",
      started_at: now,
      finished_at: null,
      updated_at: now,
      events,
      commands: [{ name: "test", exit_code: 0 }],
      artifacts: [{ kind: "log", ref: "out" }, { kind: "patch", ref: "p" }],
      validation: { tests_passed: true },
      last_event: events[events.length - 1],
    });
    const r = projectRun(root, "R-001");
    assert.equal(r.ok, true);
    assert.equal(r.run.run_id, "R-001");
    assert.equal(r.run.task_id, "T-001");
    assert.equal(r.run.kind, "implement");
    assert.equal(r.run.events_total, 12);
    assert.equal(r.run.events_recent.length, 5);  // RECENT_EVENTS default
    assert.equal(r.run.artifacts_count, 2);
    assert.equal(r.run.worktree_path, "/tmp/wt");
  } finally {
    rmProject(root);
  }
});

test("run-state: rejects invalid run id", () => {
  const r = projectRun("/tmp", "x");
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_run_id");
});

test("run-state: returns run_not_found for missing file", () => {
  const r = projectRun("/tmp", "R-XXX");
  assert.equal(r.ok, false);
  assert.equal(r.error, "run_not_found");
});

test("run-state: handles empty events array", () => {
  const root = mkProject();
  try {
    writeJSON(path.join(root, ".agent/runs/R-002.json"), {
      run_id: "R-002",
      task_id: null,
      status: "pending",
      started_at: "2026-08-14T00:00:00.000Z",
      finished_at: null,
      updated_at: "2026-08-14T00:00:00.000Z",
      events: [],
      commands: [],
      artifacts: [],
      validation: {},
    });
    const r = projectRun(root, "R-002");
    assert.equal(r.ok, true);
    assert.equal(r.run.events_total, 0);
    assert.equal(r.run.events_recent.length, 0);
    assert.equal(r.run.artifacts_count, 0);
  } finally {
    rmProject(root);
  }
});

// ─── end-to-end: management-api CLI ───────────────────────────────────────

test("cli: query task-state --task returns compact summary via management-api", () => {
  const root = mkProject();
  try {
    writeJSON(path.join(root, ".agent/tasks/T-E2E.json"), {
      task_id: "T-E2E",
      title: "end-to-end",
      description: "verify CLI",
      status: "active",
      stage: "validate",
      priority: "P1",
      owner: "ci",
      collaborators: [],
      acceptance_criteria: ["x", "y"],
      dependencies: [],
      subtasks: [],
      required_artifacts: [],
      artifacts: [],
      gates: [],
      created_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-14T00:00:00.000Z",
    });
    const r = spawnSync(process.execPath, [MGMT_CLI, "query", "task-state", "--task", "T-E2E"], { cwd: root, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.task.task_id, "T-E2E");
    assert.equal(out.task.status, "active");
    assert.equal(out.task.stage, "validate");
  } finally {
    rmProject(root);
  }
});

test("cli: query task-state without --task exits 2", () => {
  const root = mkProject();
  try {
    const r = spawnSync(process.execPath, [MGMT_CLI, "query", "task-state"], { cwd: root, encoding: "utf8" })
      assert.equal(r.status, 2);
  } finally {
    rmProject(root);
  }
});

test("cli: query run-state --run returns compact summary via management-api", () => {
  const root = mkProject();
  try {
    const events = [
      { type: "run_started", status: "running", at: "2026-08-14T00:00:00.000Z" },
      { type: "run_progress", status: "running", at: "2026-08-14T00:01:00.000Z" },
    ];
    writeJSON(path.join(root, ".agent/runs/R-E2E.json"), {
      run_id: "R-E2E",
      task_id: null,
      status: "running",
      started_at: "2026-08-14T00:00:00.000Z",
      finished_at: null,
      updated_at: "2026-08-14T00:01:00.000Z",
      events,
      commands: [],
      artifacts: [],
      validation: {},
    });
    const r = spawnSync(process.execPath, [MGMT_CLI, "query", "run-state", "--run", "R-E2E"], { cwd: root, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.run.run_id, "R-E2E");
    assert.equal(out.run.events_total, 2);
    assert.equal(out.run.events_recent.length, 2);
  } finally {
    rmProject(root);
  }
});

test("cli: query task-state capability appears in capabilities list", () => {
  const root = mkProject();
  try {
    const r = spawnSync(process.execPath, [MGMT_CLI, "query", "capabilities"], { cwd: root, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const names = (out.projections || []).map((p) => p.name);
    assert.ok(names.includes("task-state"), `task-state not in projections: ${names.join(",")}`);
    assert.ok(names.includes("run-state"), `run-state not in projections: ${names.join(",")}`);
  } finally {
    rmProject(root);
  }
});
