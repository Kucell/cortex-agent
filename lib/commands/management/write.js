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
// (decisions/inbox/waitpoints) now share the `--help` short-circuit pattern
// that was first introduced for `decisions` (M-035 MS-001 / P-009).
//
// Every public entry point returns a structured result:
//   { ok: true, mutated: false, help: true }        --help handled (zero side effects)
//   { ok: true, mutated: false, read: true }        list/show (no state mutation)
//   { ok: true, mutated: true }                     successful management write
//   { ok: false, mutated: false, code?: '...' }     usage error or API failure
//
// `bin/cli.js` calls `shouldAutoSyncManagementWriter(args, result)` to decide
// whether `fireAndForgetSync` should run. That helper short-circuits on any
// non-mutating result, which is what closes the regression described in
// GitHub issue #15 (`waitpoints create --help` previously swept pre-existing
// dirty state into an automatic commit + push).

const { invokeManagementProject, attachProject } = require("../../management/client.js");
const cliContract = require("../../cli/contract.js");
const {
  invalidManagementUsage,
  managementApiError,
  printManagementPayload,
  queryManagementApi,
} = require("./api-helpers");
const {
  commandNone,
  commandRead,
  commandMutation,
  commandFailure,
} = require("../../cli/effect.js");

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

// --- waitpoints / inbox help contracts (GitHub issue #15) -------------------
//
// Before the fix, `waitpoints create --help` (or `inbox send --help`) fell
// through to `managementWrite`, which forwarded `--help` to the Management
// API. The API rejected the request with WORKFLOW_GATE_REQUIRED and the
// caller exited nonzero. Worse, `bin/cli.js` then invoked
// `fireAndForgetSync` unconditionally, which scanned the inner .agent/ repo
// and pushed every pre-existing dirty state file into a commit — including
// files unrelated to the help probe. This was a recurrence of the same
// failure class recorded in M-026 command log (issue #15 source pointers).
//
// The contract below mirrors `decisionsRequestContract`: it documents the
// required flag set so help can be answered before any validation runs.
function waitpointsUsage() {
  return [
    "Usage: cortex-agent waitpoints <create|release|cancel> [options]",
    "",
    "See 'cortex-agent waitpoints create --help' for the create contract.",
  ].join("\n");
}

function waitpointsCreateContract() {
  return [
    "Usage: cortex-agent waitpoints create --project <path> --waitpoint-id <id>",
    "                                       --gate <workflow> --owner-workflow <workflow>",
    "                                       --reason <text> --action <action>",
    "                                       --resource-ref <ref> --decision-id <id>",
    "",
    "Required:",
    "  --project <path>            Project root directory.",
    "  --waitpoint-id <id>         Waitpoint identifier (e.g. WP-M026-freeze-window).",
    "  --gate <workflow>           Workflow gate: mission | agent | user.",
    "  --owner-workflow <workflow> Owning workflow that controls this waitpoint.",
    "  --reason <text>             Human-readable reason for the waitpoint.",
    "  --action <action>           Gated action that the waitpoint blocks.",
    "  --resource-ref <ref>        Resource under wait (e.g. branch:refs/heads/main).",
    "  --decision-id <id>          Linked Decision identifier.",
    "",
    "Notes:",
    "  --gate must be one of: mission, agent, user. A gate value outside this",
    "  set fails closed with WORKFLOW_GATE_REQUIRED. A --help probe must not",
    "  trigger any project write, commit, push, or network call — that is the",
    "  regression closed in GitHub issue #15.",
  ].join("\n");
}

function inboxUsage() {
  return [
    "Usage: cortex-agent inbox <send|transition> [options]",
    "",
    "See 'cortex-agent inbox send --help' for the send contract.",
  ].join("\n");
}

function inboxSendContract() {
  return [
    "Usage: cortex-agent inbox send --project <path> --message-id <id>",
    "                                  --gate <workflow> --sender-id <id>",
    "                                  --recipient-ids <ids> --subject <text>",
    "",
    "Required:",
    "  --project <path>     Project root directory.",
    "  --message-id <id>    Message identifier.",
    "  --gate <workflow>    Workflow gate: mission | agent | user.",
    "  --sender-id <id>     Sender identity.",
    "  --recipient-ids <ids> Comma-separated list of recipient identifiers.",
    "  --subject <text>     Message subject.",
    "",
    "Notes:",
    "  --gate must be one of: mission, agent, user. A --help probe must not",
    "  trigger any project write, commit, push, or network call — same rule",
    "  as waitpoints / decisions (GitHub issue #15).",
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

function isHelpRequest(args) {
  return Array.isArray(args) && args.some(
    (arg) => arg === "--help" || arg === "-h" || arg === "-?",
  );
}

function runs(ctx) {
  const action = ctx.args[1];
  if (isHelpRequest(ctx.args)) {
    process.stdout.write(runsUsage() + "\n");
    return commandNone({ help: true });
  }
  if (action === "list") {
    const payload = queryManagementApi(ctx, "runs");
    if (payload) printManagementPayload(payload);
    return commandRead();
  }

  if (action === "show") {
    const runId = ctx.args[2];
    if (!runId) {
      invalidManagementUsage("cortex-agent runs show <run-id>");
      return commandFailure("INVALID_USAGE");
    }
    const payload = queryManagementApi(ctx, "runs");
    if (!payload) return commandFailure("QUERY_FAILED");
    const run = Array.isArray(payload.runs)
      ? payload.runs.find((item) => item && item.run_id === runId)
      : null;
    if (!run) {
      console.error(ctx.lang === "zh" ? `未找到 Run: ${runId}` : `Run not found: ${runId}`);
      process.exitCode = 1;
      return commandFailure("RUN_NOT_FOUND");
    }
    printManagementPayload({ ok: true, query: "run", generated_at: payload.generated_at, run });
    return commandRead();
  }

  return managementWrite(ctx, "runs", cliContract.management.writers.runs);
}

function runsUsage() {
  return "Usage: cortex-agent runs <list|show|upsert|event|checkpoint|tokens|transcript-link> [options]";
}

function queues(ctx) {
  if (isHelpRequest(ctx.args)) {
    process.stdout.write(queuesUsage() + "\n");
    return commandNone({ help: true });
  }
  if (ctx.args[1] === "list") {
    const payload = queryManagementApi(ctx, "queues");
    if (payload) printManagementPayload(payload);
    return commandRead();
  }
  return managementWrite(ctx, "queues", cliContract.management.writers.queues);
}

function queuesUsage() {
  return "Usage: cortex-agent queues <list|upsert|item> [options]";
}

function sessions(ctx) {
  if (isHelpRequest(ctx.args)) {
    process.stdout.write(sessionsUsage() + "\n");
    return commandNone({ help: true });
  }
  if (ctx.args[1] === "list") {
    const payload = queryManagementApi(ctx, "sessions");
    if (payload) printManagementPayload(payload);
    return commandRead();
  }
  return managementWrite(ctx, "sessions", cliContract.management.writers.sessions);
}

function sessionsUsage() {
  return "Usage: cortex-agent sessions <list|open|heartbeat|pause|close> [options]";
}

function managementWrite(ctx, resource, allowedActions) {
  const action = ctx.args[1];
  if (!action || !allowedActions.includes(action)) {
    invalidManagementUsage(`cortex-agent ${resource} <${allowedActions.join("|")}> [options]`);
    return commandFailure("INVALID_USAGE");
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
    return commandFailure((result.error && result.error.code) || "API_FAILED");
  }
  printManagementPayload(attachProject(result.payload, result.project));
  const changedPaths = Array.isArray(result.payload && result.payload.changed_paths)
    ? result.payload.changed_paths
    : [];
  const changedResources = Array.isArray(result.payload && result.payload.changed_resources)
    ? result.payload.changed_resources
    : deriveManagementResourceRefs(resource, result.payload);
  return commandMutation({
    committed: true,
    exact_paths: Array.isArray(result.payload && result.payload.changed_paths),
    resources: changedResources,
    paths: changedPaths,
    domains: ["filesystem"],
  });
}

function deriveManagementResourceRefs(resource, payload = {}) {
  const candidates = [
    payload.decision && payload.decision.decision_id,
    payload.waitpoint && payload.waitpoint.waitpoint_id,
    payload.message && payload.message.message_id,
    payload.run && payload.run.run_id,
    payload.queue && payload.queue.queue_id,
    payload.session && payload.session.session_id,
  ].filter((value) => typeof value === "string" && value.length > 0);
  return [...new Set(candidates.map((id) => `${resource}:${id}`))];
}

function decisions(ctx) {
  const action = ctx.args[1];
  if (isHelpRequest(ctx.args)) {
    const text = action === "request" ? decisionsRequestContract() : decisionsUsage();
    process.stdout.write(text + "\n");
    return commandNone({ help: true });
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
    return commandFailure("DRY_RUN_UNSUPPORTED");
  }
  const normalized = action === "request"
    ? { ...ctx, args: normalizeDecisionGateFlag(ctx.args) }
    : ctx;
  return managementWrite(normalized, "decisions", cliContract.management.writers.decisions);
}

function inbox(ctx) {
  // GitHub issue #15: --help must print the contract and exit without any
  // project mutation. Without this short-circuit, --help flows into
  // managementWrite, the API rejects with WORKFLOW_GATE_REQUIRED, and the
  // follow-up fireAndForgetSync sweeps pre-existing dirty state into a push.
  if (isHelpRequest(ctx.args)) {
    const text = ctx.args[1] === "send" ? inboxSendContract() : inboxUsage();
    process.stdout.write(text + "\n");
    return commandNone({ help: true });
  }
  return managementWrite(ctx, "inbox", cliContract.management.writers.inbox);
}

function waitpoints(ctx) {
  // GitHub issue #15: same contract as `inbox` / `decisions` above. The
  // previous implementation forwarded --help straight to the Management API
  // and then unconditionally triggered state-sync, which is what the issue
  // reproduced on the inner .agent/ repo.
  if (isHelpRequest(ctx.args)) {
    const text = ctx.args[1] === "create" ? waitpointsCreateContract() : waitpointsUsage();
    process.stdout.write(text + "\n");
    return commandNone({ help: true });
  }
  return managementWrite(ctx, "waitpoints", cliContract.management.writers.waitpoints);
}

// shouldAutoSyncManagementWriter — gates the bin/cli.js fireAndForgetSync tail.
//
// Returns true ONLY when the command result indicates a real, successful
// state mutation. Help, read, invalid-usage, and API-error results are all
// non-mutating and must not trigger `state-sync`, which would otherwise
// sweep pre-existing dirty files into an automatic commit and push
// (regression closed in GitHub issue #15).
function shouldAutoSyncManagementWriter(_args, result) {
  return Boolean(result && result.ok && result.mutated);
}

function managementSyncPaths(result) {
  if (!result || !result.ok || !result.mutated || !result.effect) return null;
  if (result.effect.kind !== "mutation" || result.effect.committed !== true) return null;
  if (result.effect.exact_paths !== true || !Array.isArray(result.effect.paths)) return null;
  return result.effect.paths.length > 0 ? [...result.effect.paths] : null;
}

module.exports = {
  runs,
  queues,
  sessions,
  managementWrite,
  decisions,
  decisionsUsage,
  decisionsRequestContract,
  inbox,
  inboxUsage,
  inboxSendContract,
  waitpoints,
  waitpointsUsage,
  waitpointsCreateContract,
  normalizeDecisionGateFlag,
  DECISIONS_DEPRECATION_WARNING,
  shouldAutoSyncManagementWriter,
  managementSyncPaths,
  deriveManagementResourceRefs,
};