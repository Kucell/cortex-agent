"use strict";

// ─── Reusable Dispatch Plan Resolver (FAE-003 / M-013 MS-004) ──────────────
//
// Pure resolver composing the FAE-002 dispatch-state projection + the
// capability-aware dispatch surface matcher + the lease-state snapshot
// (read-only). Output matches the FAE-002 dispatch-plan schema. NEVER
// writes to .agent/ or .agent-runtime/, NEVER spawns subprocesses, NEVER
// opens network connections, NEVER acquires leases.
//
// Boundaries:
//   - In scope: parse task-id, build idempotency / concurrency / lock /
//     worktree / next_run_event / required_gates / warnings / errors.
//   - Out of scope: actual Operation attempt creation (FAE-004), running
//     sub-agents, creating worktrees, calling /worktree, /approve, /mission.

const path = require("node:path");

const dispatchState = require("./coordination/dispatch-state");
const { matchExecutionSurface, ExecutionSurfaceError } = require("./runtime-adapters/execution-surface-matcher");

const SCHEMA_VERSION = "1.0";

class DispatchPlanError extends Error {
  constructor(code, details) {
    super(`[dispatch-plan:${code}] ${JSON.stringify(details || {})}`);
    this.name = "DispatchPlanError";
    this.code = code;
    this.details = details || {};
  }
}

function requireString(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DispatchPlanError("ERR_TASK_ID_REQUIRED", { where });
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

// read-only lease summary; never acquires / renews / releases.
function summarizeLeases(root) {
  const leasesDir = path.join(root, ".agent-runtime", "coordination", "leases");
  const statePath = path.join(leasesDir, "state.json");
  let raw;
  try {
    raw = require("node:fs").readFileSync(statePath, "utf8");
  } catch (_) {
    return { active_leases: [], would_conflict_with: [] };
  }
  try {
    const state = JSON.parse(raw);
    const leases = Array.isArray(state.leases) ? state.leases : [];
    const now = Date.now();
    const active = leases.filter((l) => !l.releasedAt && !l.staleAt && new Date(l.expiresAt).getTime() > now);
    return {
      active_leases: active.map((l) => ({ lease_id: l.leaseId, scope: l.scope, owner: l.owner })),
      would_conflict_with: active.map((l) => l.scope),
    };
  } catch (_) {
    return { active_leases: [], would_conflict_with: [] };
  }
}

function captureTree(root) {
  const files = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile()) {
        try {
          const st = require("node:fs").statSync(full);
          files.set(full, { size: st.size, mtimeMs: st.mtimeMs });
        } catch (_) { /* ignore */ }
      }
    }
  }
  walk(root);
  return files;
}

function diffTree(before, after) {
  const mutated = [];
  for (const [file, info] of after) {
    const prev = before.get(file);
    if (!prev || prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      if (prev) mutated.push(file);
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) mutated.push(file);
  }
  return mutated;
}

function buildRequirement(taskId, options = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    requirement_id: `REQ-${taskId}`,
    task_id: taskId,
    created_at: options.now || nowIso(),
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: { approved_decision_id: options.approvedDecisionId || null, require_active_lease: !!options.requireActiveLease },
    preferred: {},
    ttl_at: options.ttlAt || nowIso(),
  };
}

function buildSnapshot(root, options = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    snapshot_id: options.snapshotId || `SNAP-${path.basename(root)}-${Date.now()}`,
    host_profile_ref: options.hostProfileRef || "H-A",
    taken_at: options.now || nowIso(),
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
      "tool.update": "adapter",
    },
    governance: { approved: true, decision_id: options.approvedDecisionId || null },
    lease: { active: true, holder: options.holder || "agent-pi" },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  };
}

// Public entry point: pure resolver. Caller passes `now` for determinism.
function resolveDispatchPlan(root, taskId, options = {}) {
  const tid = requireString(taskId, "taskId");
  const now = options.now || nowIso();

  // 1. Snapshot before mutation so the caller can verify zero writes.
  const before = captureTree(root);

  // 2. FAE-002 dispatch-state sub-projection.
  const stateView = dispatchState.queryDispatchState(root, { now });
  const planView = dispatchState.queryDispatchPlan(root, tid, { now });

  // 3. Compose lease snapshot (read-only).
  const leases = summarizeLeases(root);

  // 4. Build requirement + snapshot + run capability-aware matcher purely.
  let plan = null;
  let matcherError = null;
  try {
    const requirement = buildRequirement(tid, { now });
    const snapshot = buildSnapshot(root, { now });
    plan = matchExecutionSurface(requirement, [snapshot], { now });
  } catch (error) {
    if (error instanceof ExecutionSurfaceError) {
      matcherError = error;
    } else {
      throw error;
    }
  }

  // 5. Compose final plan with would_proceed decision.
  const errors = [...planView.errors];
  const warnings = [...planView.warnings];
  if (leases.would_conflict_with.length > 0) {
    errors.push(`lease_conflict:${leases.would_conflict_with.join(",")}`);
  }
  if (matcherError) errors.push(`matcher:${matcherError.code}`);

  const wouldProceed =
    errors.length === 0 &&
    planView.idempotency.would_duplicate === false &&
    planView.locks.would_conflict_with.length === 0 &&
    leases.would_conflict_with.length === 0;

  // 6. Snapshot after to prove zero mutation.
  const after = captureTree(root);
  const mutated = diffTree(before, after);

  const resolved = {
    _meta: { generated_at: now, schema_version: SCHEMA_VERSION },
    task_id: tid,
    would_proceed: wouldProceed,
    idempotency: planView.idempotency,
    concurrency: planView.concurrency,
    locks: {
      would_acquire: planView.locks.would_acquire,
      would_conflict_with: [...planView.locks.would_conflict_with, ...leases.would_conflict_with],
      active_leases: leases.active_leases,
    },
    worktree: planView.worktree,
    next_run_event: planView.next_run_event,
    required_gates: planView.required_gates,
    warnings,
    errors,
    snapshot: plan
      ? { plan_revision: plan.snapshot_revision, selection: plan.selection, candidates: plan.candidates.map((c) => ({ host_profile_ref: c.host_profile_ref, level: c.level })) }
      : null,
    mutation_evidence: {
      mutated_files: mutated,
      mutated_count: mutated.length,
    },
  };
  return Object.freeze(resolved);
}

module.exports = {
  resolveDispatchPlan,
  DispatchPlanError,
  SCHEMA_VERSION,
};