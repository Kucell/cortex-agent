"use strict";

// ─── notification — coordination notification CLI surface (FAE-006) ──────────
//
// Originally lived in lib/commands.js (line 2172). Routes through
// executeNotificationCommand and createNotificationHarness; this is a thin
// adapter. Extracted so callers can require this surface in isolation.

const path = require("node:path");
const { executeNotificationCommand } = require("../../coordination/notification-cli");
const { createNotificationHarness } = require("../../coordination/notification-host");
const { printManagementPayload } = require("../management/api-helpers");

async function notification(ctx, dependencies = {}) {
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  const harness = dependencies.harness || createNotificationHarness(projectRoot);
  const result = await executeNotificationCommand(ctx.args, harness);
  printManagementPayload(result);
  if (!result.ok) process.exitCode = result.exitCode || 3;
}

module.exports = { notification };
