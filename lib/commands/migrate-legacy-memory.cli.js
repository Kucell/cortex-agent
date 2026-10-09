"use strict";

// ─── migrate-legacy-memory CLI (M-LEGACY-MEM-001) ─────────────────────────────
//
// Wires lib/commands/migrate-legacy-memory.js to bin/cli.js. Two subcommands:
//
//   cortex-agent migrate-legacy-memory detect [--project <path>]
//     Read-only: list files using legacy frontmatter.
//
//   cortex-agent migrate-legacy-memory apply  [--project <path>] [--overrides <path.json>] [--confirm]
//     Mutates: rewrites legacy frontmatter to memory-protocol compliant shape,
//     renames files to ASCII slugs, removes source files when path changes.
//     Original record-style fields are preserved under metadata:.
//     --overrides is a JSON file keyed by legacy filename; values may set
//     { name, description, type, tags }. First-class confirmation flag is
//     --confirm; without it the apply is rejected (no implicit approval).
//
// MEMORY.md is not touched by this command. After apply, run
//   cortex-agent memory validate --fix --yes
// to reconcile the index.

const fs = require("node:fs");
const path = require("node:path");
const migrator = require("./migrate-legacy-memory");
const { commandRead, commandMutation, commandFailure, commandNone } = require("../cli/effect.js");

function usage() {
  return [
    "Usage:",
    "  cortex-agent migrate-legacy-memory detect [--project <path>]",
    "  cortex-agent migrate-legacy-memory apply  [--project <path>] [--overrides <path.json>] [--confirm]",
    "",
    "detect   Read-only: list files using legacy frontmatter (record_id/kind/distilled_at/generated_at).",
    "apply    Mutate: rewrite frontmatter + rename files. Requires --confirm.",
    "After apply, run memory validate --fix --yes to reconcile MEMORY.md."
  ].join("\n");
}

function argValue(args, flag) {
  const exact = args.indexOf(flag);
  if (exact >= 0) {
    const value = args[exact + 1];
    return value && !value.startsWith("--") ? value : "";
  }
  const pref = args.find((arg) => typeof arg === "string" && arg.startsWith(flag + "="));
  return pref ? pref.slice(flag.length + 1) : "";
}

function targetRoot(ctx) {
  if (ctx.options && ctx.options.project) return path.resolve(ctx.cwd, ctx.options.project);
  return ctx.cwd;
}

function print(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function detectSubcommand(ctx, projectRoot) {
  const r = migrator.detectLegacyFiles({ projectRoot });
  print({ action: "migrate-legacy-memory detect", ...r });
  return {
    ...commandRead({ resources: ["memory-topic-files"], domains: ["filesystem"] }),
    ok: r.ok, project_root: projectRoot, detection: r
  };
}

function applySubcommand(ctx, projectRoot) {
  const overridesPath = argValue(ctx.args, "--overrides");
  let overrides = {};
  if (overridesPath) {
    try {
      overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8"));
    } catch (error) {
      process.stderr.write("migrate-legacy-memory: failed to read --overrides: " + error.message + "\n");
      process.exitCode = 2;
      return { ...commandFailure("OVERRIDES_READ_FAILED"), project_root: projectRoot };
    }
  }
  const plan = migrator.planMigration({ projectRoot, overrides });
  if (!plan.ok || plan.planned.length === 0) {
    print({ action: "migrate-legacy-memory apply", ok: true, applied: 0, planned: plan.planned, skipped: plan.skipped });
    return { ...commandNone({ dry_run: true }), ok: true, project_root: projectRoot, plan };
  }
  const confirm = ctx.args.includes("--confirm") || ctx.args.includes("--yes");
  const result = migrator.applyMigration(plan, { confirm });
  print({ action: "migrate-legacy-memory apply", ...result, planned: plan.planned, skipped: plan.skipped });
  if (!result.ok) {
    process.exitCode = 3;
    const errCode = (result.errors && result.errors[0] && result.errors[0].code) || "ERR_APPLY_FAILED";
    return { ...commandFailure(errCode), project_root: projectRoot, apply: result };
  }
  return {
    ...commandMutation({
      committed: true, exact_paths: true,
      resources: ["memory-topic-files"],
      paths: result.written.map((w) => path.relative(projectRoot, w.target)),
      domains: ["filesystem"]
    }),
    ok: true, project_root: projectRoot, apply: result
  };
}

function migrateLegacyMemoryCommand(ctx) {
  const sub = ctx.args[1];
  if (!sub || sub === "help" || ctx.args.includes("--help") || ctx.args.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return { ...commandNone({ help: true }) };
  }
  const projectRoot = targetRoot(ctx);
  if (sub === "detect") return detectSubcommand(ctx, projectRoot);
  if (sub === "apply") return applySubcommand(ctx, projectRoot);
  process.stderr.write("migrate-legacy-memory: unknown subcommand: " + sub + "\n");
  process.stderr.write(usage() + "\n");
  process.exitCode = 2;
  return { ...commandFailure("INVALID_USAGE"), project_root: projectRoot };
}

module.exports = { usage, migrateLegacyMemoryCommand };
