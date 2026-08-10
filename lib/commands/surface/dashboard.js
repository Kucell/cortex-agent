"use strict";

// ─── dashboard — Dashboard Supervisor spawner ────────────────────────────────
//
// Originally lived in lib/commands.js (line 1572). Forks the Dashboard
// Supervisor under the target project's root and forwards CLI args (skipping
// `--project` so the child does not see conflicting project flags). Extracted
// so callers can require this surface in isolation.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveManagementProject } = require("../../management/client.js");
const { managementApiError } = require("../management/api-helpers");

function dashboard(ctx) {
  const resolved = resolveManagementProject(ctx);
  if (!resolved.ok) {
    managementApiError(ctx, resolved);
    return;
  }
  const script = path.join(__dirname, "..", "..", "dashboard", "supervisor.js");
  if (!fs.existsSync(script)) {
    managementApiError(ctx, {
      error: {
        code: "DASHBOARD_SUPERVISOR_UNAVAILABLE",
        message: "Target project is missing the Dashboard Supervisor skill.",
        details: { script },
      },
      exitCode: 3,
    });
    return;
  }
  const forwarded = [];
  for (let index = 1; index < ctx.args.length; index += 1) {
    const value = ctx.args[index];
    if (value === "--project") {
      index += 1;
      continue;
    }
    if (value.startsWith("--project=")) continue;
    forwarded.push(value);
  }
  if (forwarded.length === 0) forwarded.push("--help");
  const result = spawnSync(process.execPath, [script, ...forwarded], {
    cwd: resolved.project.root,
    stdio: "inherit",
  });
  if (result.error) {
    managementApiError(ctx, {
      error: {
        code: "DASHBOARD_SUPERVISOR_UNAVAILABLE",
        message: result.error.message,
        details: { script },
      },
      exitCode: 3,
    });
    return;
  }
  process.exitCode = Number.isInteger(result.status) ? result.status : 3;
}

module.exports = { dashboard };
