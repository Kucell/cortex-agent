"use strict";

// ─── query — `cortex-agent query <projection>` CLI surface ────────────────────
//
// Originally lived inline in lib/commands.js (lines 1393–1488). Extracted so
// that the projection router / capability filter / legacy-fallback logic
// can be unit-tested without spinning up a child process running the
// management-api script.
//
// The function is a strict copy of the original — only the require paths
// change to point at the new sibling module `./api-helpers`.

const {
  formatQueryPayload,
  queryManagementProject,
} = require("../../management/client.js");
const {
  invalidManagementUsage,
  managementApiError,
  printManagementPayload,
} = require("./api-helpers");

function managementQuery(ctx) {
  const projection = ctx.args[1];
  if (!projection || projection.startsWith("--")) {
    invalidManagementUsage("cortex-agent query <projection> [--project <path>]");
    return;
  }
  const capabilityResult = queryManagementProject(ctx, "capabilities");
  if (!capabilityResult.ok) {
    // Pre-1.9.0 Management APIs (1.6.0–1.8.x) do not expose a `capabilities`
    // projection. Fall through to a direct query so older projects can still
    // serve projections the legacy hardcoded dispatcher handled (dashboard-state,
    // runs, queues, sessions, inbox, decisions, waitpoints). The Management API
    // itself will reject projections it does not know about.
    if (capabilityResult.error.code === "UNSUPPORTED_COMMAND") {
      const directResult = queryManagementProject(ctx, projection);
      if (!directResult.ok) {
        managementApiError(ctx, directResult);
        return;
      }
      const payload = directResult.payload || {};
      printManagementPayload({
        ok: true,
        command: "query",
        projection,
        project: directResult.project && {
          root: directResult.project.root,
          agent_root: directResult.project.agent_root,
        },
        data: payload,
        summary: { legacy_dispatcher: true, capability_filter: "skipped" },
      });
      return;
    }
    managementApiError(ctx, capabilityResult);
    return;
  }
  const capabilities = capabilityResult.payload;
  const capability = Array.isArray(capabilities.projections)
    ? capabilities.projections.find((item) => item && item.name === projection)
    : null;
  if (!capability) {
    managementApiError(ctx, {
      error: {
        code: "UNSUPPORTED_PROJECTION",
        message: `Unsupported Management API projection: ${projection}`,
        details: {
          projection,
          supported: (capabilities.projections || []).map((item) => item.name),
        },
      },
      exitCode: 2,
    });
    return;
  }
  const queryArgs = [];
  for (let index = 2; index < ctx.args.length; index += 1) {
    const raw = ctx.args[index];
    if (raw === "--project") {
      index += 1;
      continue;
    }
    if (raw.startsWith("--project=")) continue;
    if (!raw.startsWith("--")) {
      invalidManagementUsage("cortex-agent query <projection> [--project <path>] [projection filters]");
      return;
    }
    const equalAt = raw.indexOf("=");
    const optionName = (equalAt === -1 ? raw : raw.slice(0, equalAt)).slice(2);
    if (!Array.isArray(capability.filters) || !capability.filters.includes(optionName)) {
      managementApiError(ctx, {
        error: {
          code: "INVALID_QUERY_OPTION",
          message: `Projection ${projection} does not support --${optionName}.`,
          details: { projection, option: optionName, supported: capability.filters || [] },
        },
        exitCode: 2,
      });
      return;
    }
    const value = equalAt === -1 ? ctx.args[++index] : raw.slice(equalAt + 1);
    if (!value || value.startsWith("--")) {
      managementApiError(ctx, {
        error: { code: "INVALID_QUERY_OPTION", message: `--${optionName} requires a value.`, details: { option: optionName } },
        exitCode: 2,
      });
      return;
    }
    queryArgs.push(`--${optionName}`, value);
  }
  const result = queryManagementProject(ctx, projection, queryArgs);
  if (!result.ok) {
    managementApiError(ctx, result);
    return;
  }
  printManagementPayload(formatQueryPayload(result.payload, projection, capability, result.project));
}

module.exports = {
  managementQuery,
};
