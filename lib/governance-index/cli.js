"use strict";

const path = require("node:path");
const {
  verifyGovernanceIndexes,
  rebuildGovernanceIndexes,
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
    "  cortex-agent governance-index verify [--project <path>] [--json]",
    "  cortex-agent governance-index rebuild [--project <path>] [--json]",
    "",
    "verify  Read-only: project Decision/Waitpoint indexes from authoritative records and report drift.",
    "rebuild Write only decisions/index.json and waitpoints/index.json; fails closed if a source cannot be safely projected.",
  ].join("\n");
}

function targetRoot(ctx) {
  if (ctx.options && ctx.options.project) return path.resolve(ctx.cwd, ctx.options.project);
  return ctx.cwd;
}

function print(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function governanceIndexCommand(ctx) {
  const sub = ctx.args[1];
  if (!sub || sub === "help" || ctx.args.includes("--help") || ctx.args.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return { ...commandNone({ help: true }), project_root: targetRoot(ctx) };
  }

  const projectRoot = targetRoot(ctx);
  if (sub === "verify") {
    const result = verifyGovernanceIndexes(projectRoot);
    print({ action: "governance-index verify", ...result });
    if (!result.ok) process.exitCode = 1;
    return {
      ...commandRead({
        resources: ["projection:decisions-index", "projection:waitpoints-index"],
        domains: ["filesystem"],
      }),
      ok: result.ok,
      project_root: projectRoot,
      verification: result,
    };
  }

  if (sub === "rebuild") {
    const result = rebuildGovernanceIndexes(projectRoot);
    if (!result.ok) {
      print({ action: "governance-index rebuild", ...result });
      process.exitCode = 3;
      return {
        ...commandFailure(result.code || "GOVERNANCE_INDEX_REBUILD_FAILED"),
        project_root: projectRoot,
        rebuild: result,
      };
    }
    print({ action: "governance-index rebuild", ...result });
    return {
      ...commandMutation({
        committed: true,
        exact_paths: true,
        resources: result.changed_resources,
        paths: result.changed_paths,
        domains: ["filesystem"],
      }),
      project_root: projectRoot,
      rebuild: result,
    };
  }

  process.stderr.write("governance-index: unknown subcommand: " + sub + "\n");
  process.stderr.write(usage() + "\n");
  process.exitCode = 2;
  return { ...commandFailure("INVALID_USAGE"), project_root: projectRoot };
}

module.exports = {
  usage,
  governanceIndexCommand,
};
