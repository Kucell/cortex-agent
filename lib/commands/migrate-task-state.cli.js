"use strict";

// ─── migrate-task-state CLI (T-TS-002 / MS-2) ───────────────────────────────
//
// Wires lib/commands/migrate-task-state.js to bin/cli.js. Three subcommands:
//
//   cortex-agent migrate-task-state detect [--project <path>]
//     Read-only: report whether the project still uses the legacy
//     task-progress.md shape.
//
//   cortex-agent migrate-task-state plan   [--project <path>]
//     Read-only: emit the migration plan (tasks to create, archives to write,
//     index drift) without touching the project.
//
//   cortex-agent migrate-task-state apply  [--project <path>] --confirm
//     Mutating: snapshot the original file, write structured task records,
//     split the closeout log into date-range archives, rebuild
//     tasks/index.json and rewrite task-progress.md as a derived view.
//     --confirm is required; there is no implicit approval.

const fs = require("node:fs");
const path = require("node:path");
const migrator = require("./migrate-task-state");
const { commandRead, commandMutation, commandFailure, commandNone } = require("../cli/effect.js");

function usage() {
  return [
    "Usage:",
    "  cortex-agent migrate-task-state detect [--project <path>]",
    "  cortex-agent migrate-task-state plan   [--project <path>]",
    "  cortex-agent migrate-task-state apply  [--project <path>] --confirm",
    "",
    "detect  Read-only: report legacy task-progress.md state and index drift.",
    "plan    Read-only: emit the migration plan without touching the project.",
    "apply   Mutate: snapshot + structured records + date-range archives +",
    "        rebuilt index + regenerated view. Requires --confirm.",
  ].join("\n");
}

function targetRoot(ctx) {
  if (ctx.options && ctx.options.project) return path.resolve(ctx.cwd, ctx.options.project);
  return ctx.cwd;
}

function print(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function detectSubcommand(ctx, projectRoot) {
  const r = migrator.detectTaskState({ projectRoot });
  // The machine-readable contract of this command is snake_case, like every
  // other JSON envelope the CLI emits (doctor, plan). The internal API stays
  // camelCase — that is the JavaScript convention — so the mapping happens
  // here, at the boundary. Spreading the detection object instead would leak
  // the internal shape into the contract and put `needsMigration` next to
  // `already_migrated` in the same document.
  print({
    action: "migrate-task-state detect",
    ok: r.ok,
    found: r.found,
    needs_migration: r.needsMigration,
    reason: r.reason,
    findings: r.findings,
    progress_file: r.progressFile,
    tasks_dir: r.tasksDir,
    existing_task_count: r.existingTaskCount,
    line_count: r.lineCount,
    byte_size: r.byteSize,
    table_task_ids: r.tableTaskIds,
    without_record: r.withoutRecord,
    missing_from_index: r.missingFromIndex,
  });
  return {
    ...commandRead({ resources: ["task-progress", "task-records"], domains: ["filesystem"] }),
    ok: r.ok, project_root: projectRoot, detection: r
  };
}

function planSubcommand(ctx, projectRoot) {
  const plan = migrator.planMigration({ projectRoot });
  print({
    action: "migrate-task-state plan",
    ok: plan.ok,
    already_migrated: plan.alreadyMigrated,
    planned_tasks: plan.planned.map((t) => t.task_id),
    skipped: plan.skipped,
    archives: plan.archives.map((a) => ({ file: a.fileName, date_range: a.dateRange, items: a.items })),
    // Whether the records this plan would write satisfy the project's own
    // task.schema.json. `apply` refuses to write records that do not, so the
    // verdict belongs in the read-only preview too — a plan that cannot be
    // applied should be visible before the user commits to it.
    validation: plan.validation
      ? {
        ok: plan.validation.ok,
        skipped: plan.validation.skipped,
        reason: plan.validation.reason || null,
        errors: plan.validation.errors || [],
      }
      : null,
  });
  return {
    ...commandRead({ resources: ["task-progress", "task-records"], domains: ["filesystem"] }),
    ok: plan.ok, project_root: projectRoot, plan
  };
}

function applySubcommand(ctx, projectRoot) {
  const plan = migrator.planMigration({ projectRoot });
  if (!plan.ok) {
    print({ action: "migrate-task-state apply", ok: false, error: plan.error });
    process.exitCode = 2;
    return { ...commandFailure("PLAN_FAILED"), project_root: projectRoot };
  }
  if (plan.alreadyMigrated || (plan.planned.length === 0 && plan.archives.length === 0)) {
    print({ action: "migrate-task-state apply", ok: true, applied: 0, reason: "already_migrated" });
    return { ...commandNone({ dry_run: true }), ok: true, project_root: projectRoot };
  }
  const confirm = ctx.args.includes("--confirm") || ctx.args.includes("--yes");
  const result = migrator.applyMigration(plan, { confirm });
  print({ action: "migrate-task-state apply", ...result });
  if (!result.ok) {
    process.exitCode = 3;
    const errCode = (result.errors && result.errors[0] && result.errors[0].code) || "ERR_APPLY_FAILED";
    return { ...commandFailure(errCode), project_root: projectRoot, apply: result };
  }
  return {
    ...commandMutation({
      committed: true, exact_paths: true,
      resources: ["task-progress", "task-records"],
      paths: result.written.map((w) => w.path),
      domains: ["filesystem"]
    }),
    ok: true, project_root: projectRoot, apply: result
  };
}

function migrateTaskStateCommand(ctx) {
  const sub = ctx.args[1];
  if (!sub || sub === "help" || ctx.args.includes("--help") || ctx.args.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return { ...commandNone({ help: true }) };
  }
  const projectRoot = targetRoot(ctx);
  if (sub === "detect") return detectSubcommand(ctx, projectRoot);
  if (sub === "plan") return planSubcommand(ctx, projectRoot);
  if (sub === "apply") return applySubcommand(ctx, projectRoot);
  process.stderr.write("migrate-task-state: unknown subcommand: " + sub + "\n");
  process.stderr.write(usage() + "\n");
  process.exitCode = 2;
  return { ...commandFailure("INVALID_USAGE"), project_root: projectRoot };
}

module.exports = { usage, migrateTaskStateCommand };
