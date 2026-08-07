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

const { invokeManagementProject } = require("../../management-client");
const cliContract = require("../../cli-contract");
const {
  attachProject,
  invalidManagementUsage,
  managementApiError,
  printManagementPayload,
  queryManagementApi,
} = require("./api-helpers");

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
  managementWrite(ctx, "decisions", cliContract.management.writers.decisions);
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
  inbox,
  waitpoints,
};
