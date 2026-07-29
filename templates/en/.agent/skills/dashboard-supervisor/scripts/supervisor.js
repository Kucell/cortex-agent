#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const result = spawnSync("cortex-agent", [
  "dashboard",
  ...process.argv.slice(2),
  "--project",
  process.cwd(),
], {
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: "CORTEX_AGENT_CLI_UNAVAILABLE",
      message: "Use the standard `cortex-agent dashboard` CLI or add it to PATH.",
    },
  }, null, 2)}\n`);
  process.exitCode = 3;
} else {
  process.exitCode = Number.isInteger(result.status) ? result.status : 3;
}
