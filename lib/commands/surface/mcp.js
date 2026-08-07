"use strict";

// ─── mcp — runtime-state MCP server spawner ──────────────────────────────────
//
// Originally lived in lib/commands.js (line 2180). Forks a Node child that runs
// the runtime-state MCP server under the target project's root. Extracted so
// callers can require this surface in isolation.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveManagementProject } = require("../../management/client.js");
const {
  managementApiError,
  invalidManagementUsage,
} = require("../management/api-helpers");

async function mcp(ctx) {
  if (ctx.args[1] !== "serve") {
    invalidManagementUsage("cortex-agent mcp serve --project <path>");
    return;
  }
  const resolved = resolveManagementProject(ctx);
  if (!resolved.ok) {
    managementApiError(ctx, resolved);
    return;
  }
  const server = path.join(resolved.project.agent_root, "skills", "runtime-state-mcp", "scripts", "server.js");
  if (!fs.existsSync(server)) {
    managementApiError(ctx, {
      error: { code: "MCP_SERVER_UNAVAILABLE", message: "Target project is missing the runtime-state MCP server.", details: { server } },
      exitCode: 3,
    });
    return;
  }
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [server], { cwd: resolved.project.root, env: process.env, stdio: "inherit" });
    child.once("error", (error) => {
      console.error(`cortex-agent mcp: ${error.message}`);
      process.exitCode = 3;
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (signal) process.exitCode = 1;
      else if (typeof code === "number" && code !== 0) process.exitCode = code;
      resolve();
    });
  });
}

module.exports = { mcp };
