"use strict";

// ─── dispatch — Dispatch dry-run + execute (FAE-003 / FAE-004) ───────────────
//
// Originally lived in lib/commands.js (line 1811–1999). Two surfaces share this
// module: `dispatch dry-run` (read-only) and `dispatch <task-id>` (mutating).
// Both delegate to lib/dispatch-plan and lib/dispatch-execute respectively.
// Extracted so callers can require this surface in isolation.

const path = require("node:path");

function dispatchDryRunUsage(ctx) {
  const lines = [
    "Usage:",
    "  cortex-agent dispatch dry-run <task-id> [options]",
    "",
    "Options:",
    "  --idempotency-key <key>      custom idempotency key (default: <task-id>:main:<YYYYMMDD>)",
    "  --concurrency-key <scope>     concurrency scope (default: repo:<basename>)",
    "  --queue <queue-id>            queue hint (informational; default: Q-main)",
    "  --output json|human           output format (default: human)",
    "  --fail-on-conflict            non-zero exit on would_conflict_with / would_duplicate",
    "  --project <path>              target project root",
    "  --json                        shortcut for --output json",
    "",
    "Pure resolver; NEVER writes to .agent/ or .agent-runtime/; NEVER spawns subprocesses.",
  ];
  return lines.join("\n");
}

function dispatchDryRunFlag(ctx, name, fallback = null) {
  const idx = ctx.args.indexOf(name);
  if (idx === -1 || !ctx.args[idx + 1]) return fallback;
  return ctx.args[idx + 1];
}

function dispatchDryRunHandler(ctx) {
  const taskId = ctx.args[0]; // dispatch dry-run <task-id>
  if (!taskId || taskId.startsWith("--")) {
    console.error("dispatch dry-run: <task-id> required");
    console.log(dispatchDryRunUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const dispatchPlan = require("../../dispatch/plan.js");
  const projectRoot = ctx.options && ctx.options.project
    ? path.resolve(ctx.cwd, ctx.options.project)
    : path.resolve(ctx.cwd, ".");
  const outputJson = ctx.args.includes("--json") || ctx.args.includes("--output=json") || (() => {
    const out = dispatchDryRunFlag(ctx, "--output");
    return out === "json";
  })();
  const failOnConflict = ctx.args.includes("--fail-on-conflict");
  const result = dispatchPlan.resolveDispatchPlan(projectRoot, taskId);
  if (outputJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`dispatch dry-run task_id=${result.task_id}`);
    console.log(`  would_proceed=${result.would_proceed}`);
    console.log(`  idempotency.key=${result.idempotency.key}`);
    console.log(`  idempotency.would_duplicate=${result.idempotency.would_duplicate}`);
    console.log(`  concurrency.current_active=${result.concurrency.current_active}`);
    console.log(`  locks.would_conflict_with=${JSON.stringify(result.locks.would_conflict_with)}`);
    console.log(`  worktree.would_create=${result.worktree.would_create}`);
    console.log(`  errors=${result.errors.length}`);
    if (result.errors.length > 0) console.log(`    ${result.errors.join("\n    ")}`);
  }
  if (failOnConflict && (!result.would_proceed || result.locks.would_conflict_with.length > 0 || result.errors.length > 0)) {
    process.exitCode = 3;
  }
  // Prove zero mutation in human output (and machine output via mutation_evidence).
  if (result.mutation_evidence.mutated_count > 0) {
    console.error(`WARN: dispatch dry-run mutated ${result.mutation_evidence.mutated_count} files (unexpected): ${result.mutation_evidence.mutated_files.join(", ")}`);
    process.exitCode = 4;
  }
}

function dispatchDryRun(ctx) {
  // ctx.args[0] = "dispatch", ctx.args[1] = subcommand (default: help/dry-run)
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
    console.log(dispatchDryRunUsage(ctx));
    return;
  }
  const sub = ctx.args[1] || "help";
  switch (sub) {
    case "dry-run":
      // Shift args so dispatchDryRunHandler sees the task-id in ctx.args[0].
      const shifted = { ...ctx, args: ctx.args.slice(2) };
      return dispatchDryRunHandler(shifted);
    default:
      console.error(`dispatch ${sub}: Phase 0 contract stub; use 'dispatch dry-run <task-id>' for FAE-003 read-only preview.`);
      console.log(dispatchDryRunUsage(ctx));
      process.exitCode = 2;
  }
}

function dispatchExecuteUsage(ctx) {
  const lines = [
    "Usage:",
    "  cortex-agent dispatch <task-id> \\",
    "    --idempotency-key <key> \\",
    "    --host <claude-code|pi|codex|cursor> \\",
    "    --gate <mission|agent|user|owner> \\",
    "    [--ttl <seconds>] [--no-rollback] [--force] [--output json|human]",
    "",
    "Routes through existing audited owners: capability-aware-dispatch +",
    "operation-lifecycle + boundary-event + Coordination Task + notification",
    "pump handshake. NEVER spawns subprocesses; NEVER opens network sockets;",
    "NEVER accesses credentials. Reuses FAE-007 public lease acquire.",
    "",
    "Prerequisites:",
    "  - The task must be approved by an existing Decision in .agent/decisions/",
    "    whose relations.task_ids includes <task-id>.",
    "  - The lease scope (task:<task-id>) must not be held by another owner.",
    "  - The dispatch plan must would_proceed (idempotency free, no lock conflict).",
  ];
  return lines.join("\n");
}

function dispatchExecuteFlag(ctx, name, fallback = null) {
  const idx = ctx.args.indexOf(name);
  if (idx === -1 || !ctx.args[idx + 1]) return fallback;
  return ctx.args[idx + 1];
}

function dispatchExecuteHandler(ctx) {
  const taskId = ctx.args[0];
  if (!taskId || taskId.startsWith("--")) {
    console.error("dispatch: <task-id> required");
    console.log(dispatchExecuteUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const dispatchExecute = require("../../agents/dispatch-execute.js");
  const args = {
    taskId,
    idempotencyKey: dispatchExecuteFlag(ctx, "--idempotency-key"),
    host: dispatchExecuteFlag(ctx, "--host"),
    gate: dispatchExecuteFlag(ctx, "--gate"),
    ttl: dispatchExecuteFlag(ctx, "--ttl"),
    projectRoot: ctx.options && ctx.options.project
      ? path.resolve(ctx.cwd, ctx.options.project)
      : path.resolve(ctx.cwd, "."),
  };
  if (!args.idempotencyKey || !args.host || !args.gate) {
    console.error("dispatch: --idempotency-key, --host, --gate are all required");
    console.log(dispatchExecuteUsage(ctx));
    process.exitCode = 2;
    return;
  }
  try {
    const result = dispatchExecute.executeDispatch(args);
    const outputJson = ctx.args.includes("--json") || ctx.args.includes("--output=json") || (() => {
      const out = dispatchExecuteFlag(ctx, "--output");
      return out === "json";
    })();
    if (outputJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`dispatch execute task_id=${taskId} host=${args.host}`);
      console.log(`  idempotent=${result.idempotent}`);
      console.log(`  operation_attempt_id=${result.run.operation_attempt_id}`);
      console.log(`  lease_id=${result.lease.lease_id} fencing_token=${result.lease.fencing_token}`);
      console.log(`  approval=${result.approval.decision_id}`);
      console.log(`  record=${result.record_path}`);
    }
  } catch (error) {
    if (ctx.args.includes("--json")) {
      console.log(JSON.stringify({ ok: false, action: "dispatch_execute", code: error.code || "ERR_DISPATCH_FAILED", message: error.message, details: error.details || {} }, null, 2));
    } else {
      console.error(`dispatch execute failed: ${error.code || "ERR_DISPATCH_FAILED"} ${error.message}`);
    }
    process.exitCode = 3;
  }
}

function dispatchExecute(ctx) {
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
    console.log(dispatchExecuteUsage(ctx));
    return;
  }
  const sub = ctx.args[1];
  if (sub !== "execute") {
    // For `dispatch <task-id> ...` form, ctx.args[0] is "dispatch", ctx.args[1] is task-id.
    // Caller routes via bin/cli.js case "dispatch" → dispatchExecute(ctx) when no dry-run.
    // We need to re-parse: if ctx.args[1] doesn't look like a subcommand and looks like a task-id,
    // pass through. Otherwise error.
    const looksLikeTaskId = ctx.args[1] && !ctx.args[1].startsWith("--") && !["execute", "dry-run"].includes(ctx.args[1]);
    if (!looksLikeTaskId) {
      console.error(`dispatch ${sub || "(missing subcommand)"}: Phase 0 contract stub or unknown subcommand.`);
      console.log(dispatchExecuteUsage(ctx));
      process.exitCode = 2;
      return;
    }
  }
  // Pass through with shifted args so the handler sees the task-id in ctx.args[0].
  const shifted = { ...ctx, args: ctx.args.slice(1) };
  return dispatchExecuteHandler(shifted);
}

module.exports = {
  dispatchDryRunUsage,
  dispatchDryRunFlag,
  dispatchDryRunHandler,
  dispatchDryRun,
  dispatchExecuteUsage,
  dispatchExecuteFlag,
  dispatchExecuteHandler,
  dispatchExecute,
};
