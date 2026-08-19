#!/usr/bin/env node
"use strict";

// ─── query-run-state (P-007 §3.4) ─────────────────────────────────────────────
//
// Read `.agent/runs/<R-...>.json` and return a compact state summary. Heavy
// `events[]` array is reduced to last_event + count + recent types so the
// agent can pull "what's happening now" without blowing context.

const fs = require("node:fs");
const path = require("node:path");

const RUNS_DIR = ".agent/runs";
const RECENT_EVENTS = 5;

function loadRun(projectRoot, runId) {
  if (!/^R-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    return { ok: false, error: "invalid_run_id", reason: `runId must match R-...: "${runId}"` };
  }
  const file = path.join(projectRoot, RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(file)) {
    return { ok: false, error: "run_not_found", reason: file };
  }
  try {
    return { ok: true, run: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: "run_parse_error", reason: error.message };
  }
}

function recentEventTypes(events, n = RECENT_EVENTS) {
  if (!Array.isArray(events)) return [];
  const slice = events.slice(-n);
  return slice.map((e) => ({ type: e.type, status: e.status, at: e.at }));
}

function project(projectRoot, runId) {
  const result = loadRun(projectRoot, runId);
  if (!result.ok) return result;
  const r = result.run;
  const events = Array.isArray(r.events) ? r.events : [];
  const artifacts = Array.isArray(r.artifacts) ? r.artifacts : [];
  const runSummary = {
    ok: true,
    run_id: r.run_id,
    task_id: r.task_id || null,
    mission_id: r.mission_id || null,
    agent_id: r.agent_id || null,
    role: r.role || null,
    kind: r.kind || null,
    status: r.status,
    phase: r.phase || null,
    worktree_path: r.worktree_path || null,
    branch: r.branch || null,
    activity: r.activity || null,
    started_at: r.started_at,
    finished_at: r.finished_at,
    updated_at: r.updated_at,
    events_total: events.length,
    events_recent: recentEventTypes(events),
    artifacts_count: artifacts.length,
    last_event: r.last_event || null,
    validation: r.validation || {},
  };
  // MS-004 R1: wrap the projection body under a `run` key so the CLI's
  // formatQueryPayload() can extract it via capability.data_field = "run".
  return { ok: true, run: runSummary };
}

function queryRunState(projectRoot, args) {
  const runId = args.run || args["--run"];
  if (!runId) {
    return { ok: false, error: "run_required", reason: "pass --run <R-...>" };
  }
  return project(projectRoot, runId);
}

module.exports = { project, queryRunState, loadRun };

if (require.main === module) {
  const ROOT = process.cwd();
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--run") { args.run = process.argv[++i]; continue; }
    if (a.startsWith("--run=")) { args.run = a.slice("--run=".length); continue; }
  }
  const result = queryRunState(ROOT, args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 2;
}
