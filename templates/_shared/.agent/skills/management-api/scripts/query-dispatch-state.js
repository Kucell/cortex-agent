"use strict";

// ─── Read-only Dispatch State Projection (FAE-002 / M-013 MS-003) ─────────
//
// Pure projection that composes existing read-only projections:
//
//   - `.agent/runs/*.json`                (active + recent history)
//   - `.agent/queues/*.json`              (queued)
//   - `.agent/sessions/*.json`            (stale_sessions; heartbeats > 5m ago)
//   - `.agent/decisions/*.json`           (blocked_by_decision)
//   - `.agent/waitpoints/*.json`          (blocked_by_waitpoint)
//   - `.agent-runtime/coordination/leases/state.json`  (current ownership scope)
//
// This module NEVER mutates state. It NEVER calls `runs upsert`, `queues
// upsert`, `decisions resolve`, `inbox send`, or any other mutation
// primitive. All file reads go through fs.readFileSync on .agent/ and
// .agent-runtime/ JSON; no network or subprocess access.
//
// Empty-state and populated-state always return the same shape so dashboards
// and audit tools can rely on field presence.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const STALE_HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes

function nowIso() {
  return new Date().toISOString();
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => safeReadJson(path.join(dir, name)))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function emptyEnvelope() {
  return {
    _meta: { generated_at: nowIso(), schema_version: SCHEMA_VERSION },
    summary: {
      dispatch_status: "not_started",
      active_dispatches: 0,
      queued_tasks: 0,
      blocked_by_decision: 0,
      blocked_by_waitpoint: 0,
      stale_sessions: 0,
      last_error: null,
    },
    active: [],
    queued: [],
    blocked: { by_decision: [], by_waitpoint: [] },
    stale_sessions: [],
    recent_history: [],
    next_action: "FAE-002 is read-only; use /approve / /worktree / /mission for state mutations.",
  };
}

function summarizeRuns(runs) {
  const active = [];
  const recent = [];
  for (const run of runs) {
    const isActive = !run.closed_at && !run.completed_at && run.status !== "completed";
    if (isActive) {
      active.push({
        task_id: run.task_id || run.relations?.task_id || "unknown",
        run_id: run.run_id,
        phase: run.phase || "EXECUTE_FEATURE",
        started_at: run.started_at || run.created_at || nowIso(),
      });
    } else {
      recent.push({
        run_id: run.run_id,
        task_id: run.task_id || run.relations?.task_id || "unknown",
        phase: run.phase || "EXECUTE_FEATURE",
        completed_at: run.completed_at || run.closed_at || nowIso(),
      });
    }
  }
  // Cap recent history at 10 entries (read-only summary).
  return { active, recent: recent.slice(-10) };
}

function summarizeQueues(queues) {
  const queued = [];
  for (const queue of queues) {
    if (!queue.items) continue;
    for (const item of queue.items) {
      if (item.status === "pending" || item.status === "queued") {
        queued.push({ task_id: item.task_id || item.id, queue_id: queue.queue_id });
      }
    }
  }
  return queued;
}

function summarizeDecisions(decisions) {
  const blocked = [];
  for (const decision of decisions) {
    if (decision.status === "open") {
      blocked.push({
        decision_id: decision.decision_id,
        task_id: (decision.relations && decision.relations.task_ids && decision.relations.task_ids[0]) || "unknown",
      });
    }
  }
  return blocked;
}

function summarizeWaitpoints(waitpoints) {
  const blocked = [];
  for (const wp of waitpoints) {
    if (wp.status === "pending" || wp.status === "blocked") {
      blocked.push({
        waitpoint_id: wp.waitpoint_id,
        task_id: (wp.relations && wp.relations.task_ids && wp.relations.task_ids[0]) || "unknown",
      });
    }
  }
  return blocked;
}

function summarizeSessions(sessions, now = Date.now()) {
  const stale = [];
  for (const session of sessions) {
    if (session.status === "closed" || session.status === "paused") continue;
    const last = session.last_heartbeat_at ? new Date(session.last_heartbeat_at).getTime() : 0;
    if (last === 0 || now - last > STALE_HEARTBEAT_MS) {
      stale.push({
        session_id: session.session_id,
        last_heartbeat_at: session.last_heartbeat_at || null,
      });
    }
  }
  return stale;
}

// Public projection: `query dispatch-state`.
function queryDispatchState(root, options = {}) {
  const agentRoot = path.join(root, ".agent");
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const env = emptyEnvelope();

  const runs = listJson(path.join(agentRoot, "runs"));
  const queues = listJson(path.join(agentRoot, "queues"));
  const sessions = listJson(path.join(agentRoot, "sessions"));
  const decisions = listJson(path.join(agentRoot, "decisions"));
  const waitpoints = listJson(path.join(agentRoot, "waitpoints"));

  const runSummary = summarizeRuns(runs);
  env.active = runSummary.active;
  env.recent_history = runSummary.recent;

  env.queued = summarizeQueues(queues);
  env.blocked.by_decision = summarizeDecisions(decisions);
  env.blocked.by_waitpoint = summarizeWaitpoints(waitpoints);
  env.stale_sessions = summarizeSessions(sessions, now);

  env.summary.active_dispatches = env.active.length;
  env.summary.queued_tasks = env.queued.length;
  env.summary.blocked_by_decision = env.blocked.by_decision.length;
  env.summary.blocked_by_waitpoint = env.blocked.by_waitpoint.length;
  env.summary.stale_sessions = env.stale_sessions.length;
  env.summary.dispatch_status =
    env.summary.active_dispatches > 0 ? "active" : "not_started";

  env._meta.generated_at = new Date(now).toISOString();
  return env;
}

// Public projection: `query triggers` (always empty in Phase 0; FAE-006 owns).
function queryTriggers(root) {
  return {
    _meta: { generated_at: nowIso(), schema_version: SCHEMA_VERSION },
    summary: {
      total: 0,
      enabled: 0,
      disabled: 0,
      by_type: { manual: 0, queue_item: 0, schedule: 0, file_change: 0, post_commit: 0 },
    },
    triggers: [],
    next_action: "FAE-002 is read-only; trigger persistence is owned by FAE-006 (separate approval).",
  };
}

// Public projection: `query dispatch-plan <task-id>`.
// Composes the same read-only sources. Pure: never writes to .agent/ or
// .agent-runtime/. No subprocess / network access.
function queryDispatchPlan(root, taskId, options = {}) {
  if (!taskId || typeof taskId !== "string") {
    throw new Error("queryDispatchPlan: taskId required");
  }
  const agentRoot = path.join(root, ".agent");
  const now = options.now ? new Date(options.now).getTime() : Date.now();

  // Idempotency: surface any existing run for the task.
  const runs = listJson(path.join(agentRoot, "runs"));
  const existingRun = runs.find((r) => (r.task_id || (r.relations && r.relations.task_id)) === taskId);
  const wouldDuplicate = !!existingRun;

  // Concurrency: count active dispatches (heuristic; real limit lives in mission-plan).
  const activeCount = runs.filter((r) => !r.closed_at && !r.completed_at && r.status !== "completed").length;

  // Locks: scan .agent/locks/ for matching lock files.
  let wouldConflict = [];
  try {
    const locks = fs.readdirSync(path.join(agentRoot, "locks"))
      .filter((n) => n.startsWith(`task-${taskId}`) || n.endsWith(`-${taskId}.json`));
    wouldConflict = locks;
  } catch (_) { /* dir missing → empty */ }

  const plan = {
    _meta: { generated_at: new Date(now).toISOString(), schema_version: SCHEMA_VERSION },
    task_id: taskId,
    would_proceed: !wouldDuplicate && wouldConflict.length === 0,
    idempotency: {
      key: `${taskId}:main:${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}`,
      existing_run_id: existingRun ? existingRun.run_id : null,
      would_duplicate: wouldDuplicate,
    },
    concurrency: {
      key: `repo:${path.basename(root)}`,
      current_active: activeCount,
      limit: null,
      would_exceed: false,
    },
    locks: {
      would_acquire: [`task:${taskId}`],
      would_conflict_with: wouldConflict,
    },
    worktree: {
      would_create: `../${path.basename(root)}-worktrees/${taskId}`,
      branch: `agent/${taskId}`,
      base_commit: null,
    },
    next_run_event: existingRun ? null : {
      run_id: `R-${new Date(now).toISOString().replace(/[-:.]/g, "").slice(0, 14)}-${taskId}`,
      phase: "EXECUTE_FEATURE",
      activity: "dispatch_dry_run",
    },
    required_gates: [],
    warnings: [],
    errors: [],
  };
  if (wouldDuplicate) {
    plan.warnings.push(`run for task_id=${taskId} already exists; use --force or pick a fresh idempotency-key`);
  }
  if (wouldConflict.length > 0) {
    plan.errors.push(`conflicting locks found: ${wouldConflict.join(", ")}`);
  }
  return plan;
}

module.exports = {
  SCHEMA_VERSION,
  queryDispatchState,
  queryTriggers,
  queryDispatchPlan,
};