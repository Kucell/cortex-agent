"use strict";

const path = require("node:path");
const {
  inspectGovernanceMigration,
  applyGovernanceMigration,
} = require("./index.js");
const {
  commandNone,
  commandRead,
  commandMutation,
  commandFailure,
} = require("../cli/effect.js");

function usage() {
  return [
    "Usage:",
    "  cortex-agent governance-migrate dry-run --plan <.agent/...json> [--project <path>]",
    "  cortex-agent governance-migrate apply --plan <.agent/...json> --gate user [--project <path>]",
    "",
    "dry-run  Zero-write migration preview. Mechanical entries are transformed in memory; decision-required and retain-legacy entries stay blocked.",
    "apply    Apply only mechanical entries whose content SHA still matches the approved plan. Requires --gate user.",
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

function governanceMigrateCommand(ctx) {
  const sub = ctx.args[1];
  if (!sub || sub === "help" || ctx.args.includes("--help") || ctx.args.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return { ...commandNone({ help: true }), project_root: targetRoot(ctx) };
  }

  const projectRoot = targetRoot(ctx);
  const planPath = argValue(ctx.args, "--plan");
  if (!planPath) {
    process.stderr.write("governance-migrate: --plan is required\n");
    process.exitCode = 2;
    return { ...commandFailure("MIGRATION_PLAN_REQUIRED"), project_root: projectRoot };
  }

  if (sub === "dry-run") {
    try {
      const result = inspectGovernanceMigration(projectRoot, planPath);
      print({ action: "governance-migrate dry-run", ...result });
      if (!result.ok) process.exitCode = 3;
      return {
        ...commandRead({
          resources: ["governance-migration-plan"],
          domains: ["filesystem"],
        }),
        ok: result.ok,
        project_root: projectRoot,
        migration: result,
      };
    } catch (error) {
      const payload = { ok: false, code: "MIGRATION_DRY_RUN_FAILED", error: error.message };
      print({ action: "governance-migrate dry-run", ...payload });
      process.exitCode = 3;
      return { ...commandFailure(payload.code), project_root: projectRoot, migration: payload };
    }
  }

  if (sub === "apply") {
    const gate = argValue(ctx.args, "--gate");
    try {
      const result = applyGovernanceMigration(projectRoot, planPath, { gate });
      print({ action: "governance-migrate apply", ...result });
      if (!result.ok) {
        process.exitCode = result.code === "MIGRATION_GATE_REQUIRED" ? 4 : 3;
        return {
          ...commandFailure(result.code || "MIGRATION_APPLY_FAILED"),
          project_root: projectRoot,
          migration: result,
        };
      }
      return {
        ...commandMutation({
          committed: true,
          exact_paths: true,
          resources: result.changed_resources,
          paths: result.changed_paths,
          domains: ["filesystem"],
        }),
        project_root: projectRoot,
        migration: result,
      };
    } catch (error) {
      const payload = { ok: false, code: "MIGRATION_APPLY_FAILED", error: error.message };
      print({ action: "governance-migrate apply", ...payload });
      process.exitCode = 3;
      return { ...commandFailure(payload.code), project_root: projectRoot, migration: payload };
    }
  }

  process.stderr.write("governance-migrate: unknown subcommand: " + sub + "\n");
  process.stderr.write(usage() + "\n");
  process.exitCode = 2;
  return { ...commandFailure("INVALID_USAGE"), project_root: projectRoot };
}

module.exports = {
  usage,
  governanceMigrateCommand,
};
