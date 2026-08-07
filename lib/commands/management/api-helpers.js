"use strict";

// ─── api-helpers — shared helpers for management-api query / write commands ────
//
// Originally lived inline in lib/commands.js (lines 1364–1391). Extracted so
// that `query.js`, `write.js` and `coordination.js` can share the same error
// formatting, usage banner and JSON payload printer without re-importing the
// rest of the 3000-line command surface.

const { attachProject, queryManagementProject } = require("../../management-client");

function managementApiError(ctx, error) {
  const normalized = typeof error === "string"
    ? {
        error: { code: "MANAGEMENT_API_QUERY_FAILED", message: error, details: {} },
        exitCode: 3,
      }
    : error;
  const prefix = ctx.lang === "zh" ? "Management API 查询失败" : "Management API query failed";
  console.error(`${prefix}: ${normalized.error.message}`);
  printManagementPayload({ ok: false, error: normalized.error });
  process.exitCode = normalized.exitCode || 3;
  return null;
}

function queryManagementApi(ctx, resource, extraArgs = []) {
  const result = queryManagementProject(ctx, resource, extraArgs);
  if (!result.ok) return managementApiError(ctx, result);
  return attachProject(result.payload, result.project);
}

function printManagementPayload(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function invalidManagementUsage(usage) {
  console.error(`Usage: ${usage}`);
  process.exitCode = 2;
}

module.exports = {
  managementApiError,
  queryManagementApi,
  printManagementPayload,
  invalidManagementUsage,
};
