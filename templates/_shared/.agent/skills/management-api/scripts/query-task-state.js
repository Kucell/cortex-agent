#!/usr/bin/env node
"use strict";

// ─── query-task-state (P-007 §3.4) ─────────────────────────────────────────────
//
// Read `.agent/tasks/<T-...>.json` and return a compact state summary. The
// agent uses this to pull task context on demand (not "remember everything
// in chat context"). Heavy fields (acceptance_criteria.full text,
// validation_commands full list) are truncated to preview slices to keep
// the response small.

const fs = require("node:fs");
const path = require("node:path");

const TASKS_DIR = ".agent/tasks";

function loadTask(projectRoot, taskId) {
  if (!/^T-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    return { ok: false, error: "invalid_task_id", reason: `taskId must match T-...: "${taskId}"` };
  }
  const file = path.join(projectRoot, TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(file)) {
    return { ok: false, error: "task_not_found", reason: file };
  }
  try {
    return { ok: true, task: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: "task_parse_error", reason: error.message };
  }
}

function preview(arr, n = 3) {
  if (!Array.isArray(arr)) return arr;
  return arr.slice(0, n);
}

function project(projectRoot, taskId) {
  const result = loadTask(projectRoot, taskId);
  if (!result.ok) return result;
  const t = result.task;
  const criteriaPreview = preview(t.acceptance_criteria, 3);
  const validationPreview = preview(t.validation_commands || [], 2);
  return {
    ok: true,
    task_id: t.task_id,
    title: t.title,
    description: t.description,
    status: t.status,
    stage: t.stage,
    priority: t.priority,
    owner: t.owner || null,
    collaborators: t.collaborators || [],
    subtasks: t.subtasks || [],
    dependencies: t.dependencies || [],
    source_refs_count: Array.isArray(t.source_refs) ? t.source_refs.length : 0,
    acceptance_criteria_preview: criteriaPreview,
    validation_commands_preview: validationPreview,
    required_artifacts: t.required_artifacts || [],
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function queryTaskState(projectRoot, args) {
  const taskId = args.task || args["--task"];
  if (!taskId) {
    return { ok: false, error: "task_required", reason: "pass --task <T-...>" };
  }
  return project(projectRoot, taskId);
}

module.exports = { project, queryTaskState, loadTask };

if (require.main === module) {
  const ROOT = process.cwd();
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--task") { args.task = process.argv[++i]; continue; }
    if (a.startsWith("--task=")) { args.task = a.slice("--task=".length); continue; }
  }
  const result = queryTaskState(ROOT, args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 2;
}
