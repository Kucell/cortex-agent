"use strict";

// ─── Cross-Project Automation Pipeline CLI (P-006 Capability F) ───────────────
//
// Public surface:
//   cortex-agent automation materialise-mission --proposal <abs-path> [--mission <id>] [--host-root <path>]
//   cortex-agent automation emit-on-done --mission <id> [--root <path>] [--source-project <id>]
//   cortex-agent automation watch-inbox [--handler <id>] [--root <path>]
//   cortex-agent automation approve-and-launch --proposal <abs-path> [--mission <id>] [--host-root <path>]
//   cortex-agent automation help
//
// Conventions:
//   • exit 0 = success
//   • exit 2 = invalid usage
//   • exit 3 = runtime failure
//   • --json toggles machine-readable output
//
// Source: P-006 §4 CLI 接口.

const fs = require("node:fs");
const path = require("node:path");

const p2m = require("../automation/proposal-to-mission");
const inboxListener = require("../automation/inbox-listener");
const completionHook = require("../automation/mission-completion-hook");

const SUBCOMMANDS = ["materialise-mission", "emit-on-done", "watch-inbox", "approve-and-launch", "help"];

function usage() {
  return [
    "Usage:",
    "  cortex-agent automation materialise-mission --proposal <abs-path> [--mission <id>] [--host-root <path>] [--json]",
    "  cortex-agent automation emit-on-done --mission <id> [--source-project <id>] [--root <path>] [--json]",
    "  cortex-agent automation watch-inbox [--handler <id>] [--root <path>] [--json]",
    "  cortex-agent automation approve-and-launch --proposal <abs-path> [--mission <id>] [--host-root <path>] [--json]",
    "  cortex-agent automation help",
    "",
    "Cross-Project Automation Pipeline (P-006). Materialises missions from",
    "proposals, drains the inbox into dispatch sidecars, and emits completion",
    "events when missions transition to \"done\".",
  ].join("\n");
}

function parseArgs(args) {
  const out = { positional: [], flags: {}, json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--proposal") { out.flags.proposal = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--proposal=")) out.flags.proposal = a.slice("--proposal=".length);
    else if (a === "--mission") { out.flags.mission = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--mission=")) out.flags.mission = a.slice("--mission=".length);
    else if (a === "--host-root") { out.flags.hostRoot = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--host-root=")) out.flags.hostRoot = a.slice("--host-root=".length);
    else if (a === "--root") { out.flags.root = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--root=")) out.flags.root = a.slice("--root=".length);
    else if (a === "--handler") { out.flags.handler = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--handler=")) out.flags.handler = a.slice("--handler=".length);
    else if (a === "--source-project") { out.flags.sourceProject = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--source-project=")) out.flags.sourceProject = a.slice("--source-project=".length);
    else if (a && a.startsWith("--")) out.flags[a.slice(2)] = true;
    else out.positional.push(a);
  }
  return out;
}

function resolveRoot(ctx, override) {
  if (override) return path.resolve(override);
  return path.resolve(ctx.cwd || process.cwd(), ".");
}

function invalidUsage(message, parsed) {
  if (parsed && parsed.json) {
    console.log(JSON.stringify({ ok: false, command: "automation", error: { code: "INVALID_USAGE", message } }, null, 2));
  } else {
    console.error(`automation: ${message}`);
    console.log(usage());
  }
  process.exitCode = 2;
}

function runtimeError(message, details, parsed) {
  if (parsed && parsed.json) {
    console.log(JSON.stringify({ ok: false, command: "automation", error: { code: "AUTOMATION_RUNTIME", message, details } }, null, 2));
  } else {
    console.error(`automation: ${message}`);
    if (details) console.error(JSON.stringify(details, null, 2));
  }
  process.exitCode = 3;
}

function materialiseHandler(ctx, parsed) {
  const proposal = parsed.flags.proposal;
  if (!proposal) return invalidUsage("--proposal <abs-path> is required", parsed);
  const hostRoot = resolveRoot(ctx, parsed.flags.hostRoot);
  const result = p2m.materialiseMission({
    proposalAbsPath: path.resolve(proposal),
    hostRoot,
    missionId: parsed.flags.mission || undefined,
  });
  if (!result.ok) return invalidUsage(result.errors.join("; "), parsed);
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, command: "automation", action: "materialise-mission", ...result }, null, 2));
  } else {
    console.log(`automation materialise-mission: mission_id=${result.mission_id} dir=${result.mission_dir}`);
    for (const [name, full] of Object.entries(result.files || {})) {
      console.log(`  - ${name}: ${full}`);
    }
  }
}

function emitOnDoneHandler(ctx, parsed) {
  const mission = parsed.flags.mission;
  if (!mission) return invalidUsage("--mission <id> is required", parsed);
  const root = resolveRoot(ctx, parsed.flags.root);
  const result = completionHook.emitOnCompletion(root, {
    mission_id: mission,
    source_project_id: parsed.flags.sourceProject || undefined,
    new_state: "done",
  });
  if (!result.ok) return runtimeError(result.errors.join("; "), null, parsed);
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, command: "automation", action: "emit-on-done", ...result }, null, 2));
  } else {
    if (result.skipped) {
      console.log(`automation emit-on-done: mission=${mission} skipped=${result.skipped}`);
    } else {
      console.log(`automation emit-on-done: mission=${mission} emitted=${result.emitted.length}`);
      for (const id of result.emitted) console.log(`  - ${id}`);
    }
  }
}

function watchInboxHandler(ctx, parsed) {
  const root = resolveRoot(ctx, parsed.flags.root);
  let result;
  if (parsed.flags.handler) {
    result = inboxListener.runOnce(root, { handler_id: parsed.flags.handler });
    if (!result.ok) return runtimeError(result.errors.join("; "), null, parsed);
  } else {
    result = inboxListener.runAllOnce(root);
  }
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, command: "automation", action: "watch-inbox", result }, null, 2));
  } else {
    if (Array.isArray(result.runs)) {
      console.log(`automation watch-inbox: handlers=${result.runs.length}`);
      for (const run of result.runs) {
        console.log(`  - handler=${run.handler_id} dispatched=${run.dispatched ? run.dispatched.length : "n/a"}`);
      }
    } else {
      console.log(`automation watch-inbox: dispatched=${result.dispatched.length} scanned=${result.scanned}`);
    }
  }
}

function approveAndLaunchHandler(ctx, parsed) {
  // approve-and-launch = materialise-mission + (already-approved proposal is
  // understood to have status: approved). Side-effect: the materialised mission
  // is left at state=planned for downstream agents (/mission / /start-task) to
  // dispatch.
  materialiseHandler(ctx, parsed);
}

function automationCommand(ctx) {
  process.exitCode = 0;
  const args = Array.isArray(ctx.args) ? ctx.args.slice(1) : [];
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    if (ctx.args && ctx.args.includes("--json")) {
      console.log(JSON.stringify({ ok: true, command: "automation", help: usage() }, null, 2));
    } else {
      console.log(usage());
    }
    return;
  }
  if (!SUBCOMMANDS.includes(sub)) {
    return invalidUsage(`unknown subcommand: ${sub}`, { json: (ctx.args || []).includes("--json") });
  }
  const parsed = parseArgs(args.slice(1));
  switch (sub) {
    case "materialise-mission": return materialiseHandler(ctx, parsed);
    case "emit-on-done": return emitOnDoneHandler(ctx, parsed);
    case "watch-inbox": return watchInboxHandler(ctx, parsed);
    case "approve-and-launch": return approveAndLaunchHandler(ctx, parsed);
    default: invalidUsage(`unsupported subcommand: ${sub}`, parsed);
  }
}

module.exports = {
  automationCommand,
  // Exposed for tests
  parseArgs,
  usage,
};
