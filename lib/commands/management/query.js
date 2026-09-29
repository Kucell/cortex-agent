"use strict";

// `cortex-agent query <projection>` remains a compatibility-stable CLI
// surface. M-040 MS-002 routes its reads through the canonical SDK facade;
// the SDK local transport delegates to the existing Management API owner.

const { formatQueryPayload } = require("../../management/client.js");
const { createLocalCortexClient } = require("../../sdk/local-client.js");
const {
  invalidManagementUsage,
  managementApiError,
  printManagementPayload,
} = require("./api-helpers");

function sdkFailure(error, fallbackExitCode = 3) {
  return {
    error: {
      code: error && error.code ? error.code : "MANAGEMENT_API_QUERY_FAILED",
      message: error && error.message ? error.message : String(error),
      details: error && error.details ? error.details : {},
    },
    exitCode: error && error.exitCode ? error.exitCode : fallbackExitCode,
  };
}

function managementQuery(ctx) {
  const projection = ctx.args[1];
  if (!projection || projection.startsWith("--")) {
    invalidManagementUsage("cortex-agent query <projection> [--project <path>]");
    return;
  }

  const client = createLocalCortexClient(ctx);
  let capabilities;
  try {
    capabilities = client.management.capabilities();
  } catch (error) {
    // Pre-1.9.0 Management APIs (1.6.0–1.8.x) do not expose a capabilities
    // projection. Preserve the legacy direct-query fallback.
    if (error.code === "UNSUPPORTED_COMMAND") {
      try {
        const payload = client.management.query(projection);
        const project = client.project.resolve();
        printManagementPayload({
          ok: true,
          command: "query",
          projection,
          project: {
            root: project.root,
            agent_root: project.agent_root,
          },
          data: payload,
          summary: { legacy_dispatcher: true, capability_filter: "skipped" },
        });
      } catch (directError) {
        managementApiError(ctx, sdkFailure(directError));
      }
      return;
    }
    managementApiError(ctx, sdkFailure(error));
    return;
  }

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

  const filters = {};
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
        error: {
          code: "INVALID_QUERY_OPTION",
          message: `--${optionName} requires a value.`,
          details: { option: optionName },
        },
        exitCode: 2,
      });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(filters, optionName)) {
      filters[optionName] = Array.isArray(filters[optionName])
        ? [...filters[optionName], value]
        : [filters[optionName], value];
    } else {
      filters[optionName] = value;
    }
  }

  let payload;
  let project;
  try {
    payload = client.management.query(projection, filters);
    project = client.project.resolve();
  } catch (error) {
    managementApiError(ctx, sdkFailure(error));
    return;
  }

  printManagementPayload(formatQueryPayload(payload, projection, capability, {
    root: project.root,
    agent_root: project.agent_root,
  }));
}

module.exports = {
  managementQuery,
  sdkFailure,
};
