"use strict";

// ─── Governed Manual Dispatch CLI Surface (FAE-001 / M-013 P0 C2) ────────────
//
// This is the *user-facing* dispatcher for `cortex-agent dispatch <subcommand>`.
// It composes two audited owners and keeps every existing safety boundary:
//
//   - `lib/dispatch-plan.js`           read-only plan resolver (FAE-003)
//     - 0 file mutation
//     - returns {task_id, would_proceed, _meta, idempotency, concurrency,
//                locks, worktree, next_run_event, required_gates,
//                warnings, errors, snapshot, mutation_evidence}
//   - `lib/automation-stubs.js`        phase0 stub (FAE-001 reserved surface)
//     - dispatch execute / no-subcommand stays a Phase 0 stub that surfaces
//       {ok: false, implemented: false, phase: 0, error.code: PHASE_ZERO_STUB}
//     - matches `tests/dispatch-vocabulary.test.js` and the cli-06 regression
//
// Boundaries:
//   - In scope: argv parsing, subcommand routing, flag normalization,
//     human/JSON formatting, exit-code mapping (0/2/3).
//   - Out of scope: spawning subprocesses, opening network sockets, writing to
//     .agent/ or .agent-runtime/, reading credentials, real task execution
//     (that lives behind `lib/dispatch-execute.executeDispatch` and is gated
//     on `approved_task + ownership_lease + idempotency_key + host + gate`
//     per FAE-004).
//
// Why a separate module instead of inlining into bin/cli.js:
//   1. Keeps `bin/cli.js` 1-line dispatch (line 350) untouched in shape —
//      the only change is the case body swapping `phaseZeroAutomation` for
//      `dispatchCommand`.
//   2. Lets tests and the future FAE-002 event-bus surface invoke
//      `dispatchCommand(ctx)` directly without going through the CLI binary.
//   3. Mirrors the existing `lib/dispatch-plan.js` / `lib/dispatch-execute.js`
//      naming (flat, no `lib/dispatch/` subdirectory).

const path = require("node:path");

const dispatchPlan = require("./dispatch-plan");
const { phaseZeroAutomation } = require("./automation-stubs");

// ─── argv parsing ────────────────────────────────────────────────────────────

function parseDispatchArgs(args) {
  const out = {
    subcommand: null,
    taskId: null,
    projectRoot: null,
    outputFormat: "human",     // "human" | "json"
    outputJson: false,
    failOnConflict: false,
    showHelp: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      continue;
    }
    if (arg === "--json") {
      out.outputJson = true;
      out.outputFormat = "json";
      continue;
    }
    if (arg === "--output") {
      const v = args[i + 1];
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--output=")) {
      const v = arg.slice("--output=".length);
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
      }
      continue;
    }
    if (arg === "--project") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.projectRoot = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--project=")) {
      out.projectRoot = arg.slice("--project=".length);
      continue;
    }
    if (arg === "--fail-on-conflict") {
      out.failOnConflict = true;
      continue;
    }
    if (arg && arg.startsWith("--")) {
      // Unknown flag: ignore (keep surface permissive; --json / --help already
      // handled above; this matches the "no defaults added" rule from FAE-001).
      continue;
    }
    if (!out.subcommand) {
      out.subcommand = arg;
    } else if (!out.taskId) {
      out.taskId = arg;
    }
  }
  return out;
}

// ─── formatters ──────────────────────────────────────────────────────────────

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function humanDryRunOutput(plan) {
  const lines = [];
  lines.push(`dispatch dry-run task_id=${plan.task_id}`);
  lines.push(`would_proceed=${plan.would_proceed}`);
  lines.push(
    `idempotency.key=${plan.idempotency.key} existing_run_id=${plan.idempotency.existing_run_id || "-"} would_duplicate=${plan.idempotency.would_duplicate}`,
  );
  lines.push(
    `concurrency.key=${plan.concurrency.key} current_active=${plan.concurrency.current_active}`,
  );
  const wouldAcquire = Array.isArray(plan.locks.would_acquire) ? plan.locks.would_acquire.join(",") : "-";
  lines.push(`locks.would_acquire=${wouldAcquire}`);
  if (Array.isArray(plan.locks.would_conflict_with) && plan.locks.would_conflict_with.length > 0) {
    lines.push(`locks.would_conflict_with=${plan.locks.would_conflict_with.join(",")}`);
  }
  if (plan.worktree && plan.worktree.would_create) {
    lines.push(`worktree.would_create=${plan.worktree.would_create} branch=${plan.worktree.branch || "-"}`);
  }
  if (plan.next_run_event) {
    lines.push(`next_run_event.run_id=${plan.next_run_event.run_id} phase=${plan.next_run_event.phase}`);
  }
  if (Array.isArray(plan.errors) && plan.errors.length > 0) {
    lines.push(`errors=${plan.errors.join("; ")}`);
  }
  if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
    lines.push(`warnings=${plan.warnings.join("; ")}`);
  }
  lines.push(`mutation_evidence.mutated_count=${plan.mutation_evidence.mutated_count}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── subcommand: dry-run ─────────────────────────────────────────────────────

function dispatchDryRun(parsed, lang) {
  if (!parsed.taskId) {
    const usage = lang === "zh"
      ? "用法: dispatch dry-run <task-id> [--project <path>] [--output json|human] [--fail-on-conflict]\n错误: <task-id> required"
      : "Usage: dispatch dry-run <task-id> [--project <path>] [--output json|human] [--fail-on-conflict]\nError: <task-id> required";
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  const root = parsed.projectRoot
    ? path.resolve(parsed.projectRoot)
    : process.cwd();

  let plan;
  try {
    plan = dispatchPlan.resolveDispatchPlan(root, parsed.taskId);
  } catch (error) {
    if (parsed.outputJson) {
      printJson({
        ok: false,
        task_id: parsed.taskId,
        would_proceed: false,
        error: {
          code: error.code || "ERR_DISPATCH_PLAN",
          message: error.message,
        },
      });
    } else {
      process.stderr.write(`dispatch dry-run error: ${error.message}\n`);
    }
    process.exitCode = 3;
    return;
  }

  if (parsed.outputJson) {
    printJson(plan);
  } else {
    humanDryRunOutput(plan);
  }

  // Exit code policy:
  //   - 0  → plan resolves cleanly (would_proceed true OR no --fail-on-conflict
  //          but plan reports would_proceed false — dry-run surfaces the
  //          verdict in the payload, the *flag* is what escalates).
  //   - 3  → --fail-on-conflict requested AND plan.would_proceed === false.
  if (!plan.would_proceed && parsed.failOnConflict) {
    process.exitCode = 3;
  } else {
    process.exitCode = 0;
  }
}

// ─── dispatcher entry point ──────────────────────────────────────────────────

function dispatchCommand(ctx) {
  // `ctx.args` is `process.argv.slice(2)`, so `args[0]` is the command name
  // itself ("dispatch"). Strip it so parseDispatchArgs sees only the
  // subcommand + task-id + flags. When dispatchCommand is invoked outside the
  // CLI binary (tests, future FAE-002 callers), ctx.args still starts with
  // "dispatch" by convention, so the strip is safe.
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  const args = rawArgs[0] === "dispatch" ? rawArgs.slice(1) : rawArgs;
  const parsed = parseDispatchArgs(args);

  // No subcommand or explicit help → fall through to the existing Phase 0
  // stub surface so `cortex-agent dispatch` and `cortex-agent dispatch --help`
  // keep their current discovery shape.
  if (parsed.showHelp || !parsed.subcommand) {
    return phaseZeroAutomation(ctx);
  }

  if (parsed.subcommand === "dry-run") {
    return dispatchDryRun(parsed, ctx.lang);
  }

  if (parsed.subcommand === "execute") {
    // Real execute is owned by `lib/dispatch-execute.executeDispatch` and
    // requires --gate / --host / --idempotency-key / approved task / lease.
    // Until those reach the CLI surface, `dispatch execute` keeps the Phase 0
    // stub behavior (regression guard: tests/dispatch-dry-run-cli.test.js
    // VC-013-04-cli-06).
    return phaseZeroAutomation(ctx);
  }

  // Unknown subcommand: route to Phase 0 stub for uniform "unsupported" exit.
  return phaseZeroAutomation(ctx);
}

module.exports = {
  dispatchCommand,
  parseDispatchArgs,
  dispatchDryRun,
};
