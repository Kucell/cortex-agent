"use strict";

// ─── write — 7 management-api CLI write wrappers (runs/queues/sessions/
//   managementWrite/decisions/inbox/waitpoints) ───────────────────────────────
//
// Originally lived inline in lib/commands.js (lines 1490–1570). Extracted so
// the write-side CLI surface can be unit-tested without dragging the full
// command surface into the require graph.
//
// The `runs` wrapper has special-case handling for `list` and `show` (query
// path) and falls through to `managementWrite` for the other writer actions.
// `queues` and `sessions` short-circuit on `list`. The remaining 3 wrappers
// (decisions/inbox/waitpoints) are direct one-liners into `managementWrite`.

const { invokeManagementProject, attachProject } = require("../../management/client.js");
const cliContract = require("../../cli/contract.js");
const {
  invalidManagementUsage,
  managementApiError,
  printManagementPayload,
  queryManagementApi,
} = require("./api-helpers");

// --- decisions help contracts (M-035 MS-001 / P-009) -------------------------
//
// A decisions request carries two independent gate concepts that the old usage
// banner collapsed into one:
//   --gate <mission|agent|user>        workflow gate (who may perform the write)
//   --gate-action <architecture|...>   decision gate action (what is gated)
// Omitting --gate fails closed inside the Management API, so this contract is
// the only sanctioned way to discover the required flag set.
const DECISIONS_DEPRECATION_WARNING =
  "warning: --action is deprecated, use --gate-action instead (will be removed in 2.0)";

function decisionsUsage() {
  return [
    "Usage: cortex-agent decisions <request|resolve|supersede> [options]",
    "",
    "See 'cortex-agent decisions request --help' for the request contract.",
  ].join("\n");
}

function decisionsRequestContract() {
  return [
    "Usage: cortex-agent decisions request --project <path> --decision-id <id> --gate <workflow> --gate-action <action>",
    "                                      --type <type> --requested-by <id> --prompt <text> --resource-ref <ref> --options <json>",
    "",
    "Required:",
    "  --project <path>        Project root directory.",
    "  --decision-id <id>      Decision identifier (e.g. D-ARI-P009-cli-runtime-contract).",
    "  --gate <workflow>       Workflow gate: mission | agent (request is a write;",
    "                          only these two are accepted, not user).",
    "  --gate-action <action>  Decision gate action: architecture | merge | release |",
    "                          destructive | credential | external_side_effect.",
    "  --type <type>           Decision type: approval | architecture | merge | release | risk.",
    "  --requested-by <id>     Requester identity.",
    "  --prompt <text>         Human-readable question being decided.",
    "  --resource-ref <ref>    Gated resource (e.g. proposal:<path>@<digest>).",
    "  --options <json>        JSON array with at least 2 options.",
    "",
    "Options:",
    "  --action <action>       DEPRECATED (removed in 2.0). Alias of --gate-action that",
    "                          emits a stderr warning; --gate-action wins when both are set.",
    "",
    "Notes:",
    "  --gate and --gate-action are distinct concepts. --gate selects the workflow",
    "  allowed to write; --gate-action selects the decision gate being requested.",
    "  Both are required; omitting --gate fails closed with WORKFLOW_GATE_REQUIRED,",
    "  and a gate value outside mission|agent fails closed with the same error code.",
    "",
    "Examples:",
    "  cortex-agent decisions request --project . --decision-id D-ARI-P009-cli-runtime-contract",
    "    --gate mission --gate-action architecture --type approval --requested-by arch-design",
    "    --prompt 'Approve P-009?' --resource-ref proposal:.agent/plans/.../P-009.md",
    "    --options '[\"approve\",\"reject\"]'",
  ].join("\n");
}

// M-035 MS-001/MS-002: --gate-action is primary; --action keeps working
// through the 1.x compatibility window with a one-line stderr warning.
function normalizeDecisionGateFlag(args) {
  const out = [];
  const hasGateAction = args.some(
    (arg) => arg === "--gate-action" || (typeof arg === "string" && arg.startsWith("--gate-action="))
  );
  let warned = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const isActionFlag = arg === "--action";
    const isActionInline = typeof arg === "string" && arg.startsWith("--action=");
    if (isActionFlag || isActionInline) {
      const value = isActionFlag ? args[index + 1] : arg.slice("--action=".length);
      if (isActionFlag) index += 1;
      // When --gate-action is already present the deprecated alias is dropped.
      if (hasGateAction) continue;
      if (!warned) {
        process.stderr.write(DECISIONS_DEPRECATION_WARNING + "\n");
        warned = true;
      }
      out.push("--gate-action", value);
      continue;
    }
    out.push(arg);
  }
  return out;
}

function runs(ctx) {
  const action = ctx.args[1];
  if (action === "list") {
    const payload = queryManagementApi(ctx, "runs");
    if (payload) printManagementPayload(payload);
    return;
  }

  if (action === "show") {
    const runId = ctx.args[2];
    if (!runId) return invalidManagementUsage("cortex-agent runs show <run-id>");
    const payload = queryManagementApi(ctx, "runs");
    if (!payload) return;
    const run = Array.isArray(payload.runs)
      ? payload.runs.find((item) => item && item.run_id === runId)
      : null;
    if (!run) {
      console.error(ctx.lang === "zh" ? `未找到 Run: ${runId}` : `Run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    printManagementPayload({ ok: true, query: "run", generated_at: payload.generated_at, run });
    return;
  }

  managementWrite(ctx, "runs", cliContract.management.writers.runs);
}

function queues(ctx) {
  if (ctx.args[1] === "list") {
    const payload = queryManagementApi(ctx, "queues");
    if (payload) printManagementPayload(payload);
    return;
  }
  managementWrite(ctx, "queues", cliContract.management.writers.queues);
}

function sessions(ctx) {
  if (ctx.args[1] === "list") {
    const payload = queryManagementApi(ctx, "sessions");
    if (payload) printManagementPayload(payload);
    return;
  }
  managementWrite(ctx, "sessions", cliContract.management.writers.sessions);
}

function managementWrite(ctx, resource, allowedActions) {
  const action = ctx.args[1];
  if (!action || !allowedActions.includes(action)) {
    invalidManagementUsage(`cortex-agent ${resource} <${allowedActions.join("|")}> [options]`);
    return;
  }
  const commandArgs = [resource, action];
  for (let index = 2; index < ctx.args.length; index += 1) {
    const raw = ctx.args[index];
    if (raw === "--project") {
      index += 1;
      continue;
    }
    if (raw.startsWith("--project=")) continue;
    commandArgs.push(raw);
  }
  const result = invokeManagementProject(ctx, commandArgs);
  if (!result.ok) {
    managementApiError(ctx, result);
    return;
  }
  printManagementPayload(attachProject(result.payload, result.project));
}

function decisions(ctx) {
  const action = ctx.args[1];
  if (ctx.args.includes("--help") || ctx.args.includes("-h") || ctx.args.includes("-?")) {
    const text = action === "request" ? decisionsRequestContract() : decisionsUsage();
    process.stdout.write(text + "\n");
    return;
  }
  // P-009 / M-035: `decisions request` writes a Decision record. --dry-run was
  // never implemented by the Management API, which ignores unknown flags, so the
  // command silently performed a real, audited write and still exited 0. That is
  // the same class of silent gate degradation this proposal exists to remove, so
  // it now fails closed instead of pretending to preview.
  if (action === "request" && ctx.args.some((arg) => arg === "--dry-run" || arg === "--dry_run")) {
    console.error(
      "error: --dry-run is not supported by `decisions request`; it would have performed a real write. " +
        "Re-run without --dry-run, or target a throwaway project to preview the payload."
    );
    process.exitCode = 2;
    return;
  }
  const normalized = action === "request"
    ? { ...ctx, args: normalizeDecisionGateFlag(ctx.args) }
    : ctx;
  managementWrite(normalized, "decisions", cliContract.management.writers.decisions);
}

function inbox(ctx) {
  managementWrite(ctx, "inbox", cliContract.management.writers.inbox);
}

function waitpoints(ctx) {
  managementWrite(ctx, "waitpoints", cliContract.management.writers.waitpoints);
}

module.exports = {
  runs,
  queues,
  sessions,
  managementWrite,
  decisions,
  decisionsUsage,
  decisionsRequestContract,
  normalizeDecisionGateFlag,
  DECISIONS_DEPRECATION_WARNING,
  inbox,
  waitpoints,
};
