"use strict";

// ─── agent — Host Event Bridge / T-ACN-016 surface ───────────────────────────
//
// Originally lived in lib/commands.js (line 2215). Forks the Host Event Bridge
// and Governed-Launch CLI under a CoordinationApplicationService. Extracted so
// callers can require this surface in isolation.

const fs = require("node:fs");
const path = require("node:path");
const { executeBridgeCommand } = require("../../coordination/host-event-bridge.js");
const { printManagementPayload } = require("../management/api-helpers");

async function agent(ctx, dependencies = {}) {
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  let service = dependencies.service;
  let ownedService = false;

  if (!service) {
    try {
      const { CoordinationApplicationService } = require("../../coordination/application-service");
      const { loadAuthorizationPolicy } = require("../../coordination/authorization-policy");
      const runtimeRoot = path.join(projectRoot, ".agent-runtime");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const runtimeIgnore = path.join(runtimeRoot, ".gitignore");
      if (!fs.existsSync(runtimeIgnore)) {
        fs.writeFileSync(runtimeIgnore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
      }
      service = CoordinationApplicationService.open(
        path.join(runtimeRoot, "coordination"),
        { authorization: loadAuthorizationPolicy(projectRoot) },
      );
      ownedService = true;
    } catch (_) {
      service = null;
    }
  }

  try {
    if (ctx.args[1] === "launch") {
      const { executeGovernedLaunch } = require("../../governed/launch-cli.js");
      const result = await executeGovernedLaunch(ctx.args.slice(2), {
        service,
        projectRoot,
        releaseService() {
          if (!ownedService || !service || typeof service.close !== "function") return;
          service.close();
          ownedService = false;
        },
      });
      printManagementPayload(result);
      if (!result.ok) process.exitCode = result.exitCode || 3;
      return;
    }
    const result = executeBridgeCommand(ctx.args, { service });
    printManagementPayload(result);
    if (!result.ok) process.exitCode = result.exitCode || 3;
  } finally {
    if (ownedService && service && typeof service.close === "function") service.close();
  }
}

module.exports = { agent };
