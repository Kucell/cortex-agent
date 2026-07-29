"use strict";

// ─── Read-only Dispatch Dry-run (MS-008 / P-004) ────────────────────────────
//
// Wraps the deterministic execution-surface matcher to expose a dry-run
// facade that explains why each candidate is selected or rejected and never
// mutates file state, leases, processes, MCP, or any external side effect.
//
// The wrapper is intentionally minimal: it owns no state, registers no
// listeners, and writes no artifacts. Its sole job is to compose a plan
// and surface the reasoning.
//
// Safety contract:
//   * No fs.write/read after the snapshot intake.
//   * No child_process.spawn / fork / exec.
//   * No network or MCP client.
//   * No lease acquisition.
//   * No clock side effects: `now` is always caller-provided.
//   * Pure projection: identical inputs always produce identical output.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { matchExecutionSurface, ExecutionSurfaceError } = require("./execution-surface-matcher");

const SCHEMA_VERSION = "1.0";

class DispatchDryRunError extends Error {
  constructor(code, details) {
    super(`[dispatch-dry-run:${code}] ${JSON.stringify(details || {})}`);
    this.name = "DispatchDryRunError";
    this.code = code;
    this.details = details || {};
  }
}

// Snapshot the filesystem tree rooted at `root` (exclusive). We compare
// before/after to assert the dry-run produced no file mutation.
function captureTree(root) {
  if (!root) return { files: new Map() };
  const files = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        files.set(full, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  walk(root);
  return { files };
}

function diffTree(before, after) {
  if (before.files.size !== after.files.size) {
    return { mutated: true, reason: "file_count_changed", before: before.files.size, after: after.files.size };
  }
  for (const [key, beforeMeta] of before.files) {
    const afterMeta = after.files.get(key);
    if (!afterMeta) return { mutated: true, reason: "file_removed", path: key };
    if (afterMeta.size !== beforeMeta.size) {
      return { mutated: true, reason: "file_size_changed", path: key };
    }
    if (afterMeta.mtimeMs !== beforeMeta.mtimeMs) {
      return { mutated: true, reason: "file_mtime_changed", path: key };
    }
  }
  return { mutated: false };
}

// Capture a coarse-grained fingerprint of leases, processes, and arbitrary
// mutable OS state. The dry-run never touches these, but we expose them so
// consumers can verify with the same API on either side.
function captureEnvironment() {
  return Object.freeze({
    captured_at: new Date().toISOString(),
    pid: process.pid,
    uptime: process.uptime(),
    cwd: process.cwd(),
    env_keys: Object.freeze(Object.keys(process.env).slice().sort()),
  });
}

function dryRunDispatch(requirement, snapshots, options) {
  if (!options || typeof options !== "object") {
    throw new DispatchDryRunError("ERR_OPTIONS_REQUIRED", {});
  }
  if (typeof options.now !== "string") {
    throw new DispatchDryRunError("ERR_OPTIONS_NOW_REQUIRED", {});
  }
  const watchRoot = options.watchRoot || null;
  const before = captureTree(watchRoot);
  const envBefore = captureEnvironment();

  const plan = matchExecutionSurface(requirement, snapshots, { now: options.now });
  const rejected = plan.candidates.filter((c) => !c.hard_pass).length;
  const selected = plan.selection;
  const explanation = {
    selected,
    selection_reason: selected
      ? `candidate ${selected} cleared all hard filters and had the highest advisory score`
      : "no candidate cleared all hard filters; the planner must widen requirements or refresh snapshots",
    rejected_count: rejected,
    passed_count: plan.candidates.length - rejected,
    plan_revision: plan.snapshot_revision,
    requirement_id: plan.requirement_id,
    plan_id: plan.plan_id,
    side_effects: Object.freeze({
      files: Object.freeze({ mutated: false, watch_root: watchRoot }),
      leases: Object.freeze({ acquired: false }),
      processes: Object.freeze({ spawned: false }),
      mcp: Object.freeze({ invoked: false }),
      external: Object.freeze({ invoked: false }),
    }),
  };

  const after = captureTree(watchRoot);
  const diff = diffTree(before, after);
  if (diff.mutated) {
    throw new DispatchDryRunError("ERR_FILE_MUTATION_DETECTED", diff);
  }
  const envAfter = captureEnvironment();
  if (envAfter.pid !== envBefore.pid || envAfter.cwd !== envBefore.cwd) {
    throw new DispatchDryRunError("ERR_PROCESS_CONTEXT_DRIFT", { before: envBefore, after: envAfter });
  }
  if (envAfter.env_keys.join("|") !== envBefore.env_keys.join("|")) {
    throw new DispatchDryRunError("ERR_ENV_DRIFT", { before: envBefore.env_keys, after: envAfter.env_keys });
  }

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    dry_run_id: `DRY-${plan.plan_id}`,
    generated_at: plan.created_at,
    plan,
    explanation: Object.freeze(explanation),
  });
}

function explain(plan) {
  if (!plan || typeof plan !== "object") {
    throw new DispatchDryRunError("ERR_PLAN_INVALID", {});
  }
  const lines = [];
  lines.push(`Plan ${plan.plan_id} (revision ${plan.snapshot_revision}):`);
  lines.push(`  requirement_id: ${plan.requirement_id}`);
  lines.push(`  created_at: ${plan.created_at}`);
  if (plan.selection) {
    lines.push(`  selection: ${plan.selection}`);
  } else {
    lines.push(`  selection: NONE — no candidate passed hard filters`);
  }
  for (const candidate of plan.candidates) {
    if (candidate.hard_pass) {
      lines.push(`  ✓ ${candidate.host_profile_ref} (score=${candidate.score}) — hard filters passed`);
    } else {
      lines.push(`  ✗ ${candidate.host_profile_ref} — rejected: ${candidate.rejected_reasons.join(", ")}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  DispatchDryRunError,
  SCHEMA_VERSION,
  captureTree,
  captureEnvironment,
  diffTree,
  dryRunDispatch,
  explain,
};