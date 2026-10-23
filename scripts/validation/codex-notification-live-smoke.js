#!/usr/bin/env node
"use strict";

/**
 * Real-host, opt-in Codex notification smoke test.
 * This checks the existing App Server transport, not Desktop UI visibility.
 * Does not write governance data, run a task, approve permissions, or touch repo files.
 */
const crypto = require("node:crypto");
const { deliverCodexWakeup, validateThreadId } = require("../../lib/coordination/codex-app-server-client");

function usage() {
  return [
    "Codex App Server notification smoke test (opt-in)",
    "",
    "Usage:",
    "  node scripts/validation/codex-notification-live-smoke.js --thread-id <id>",
    "  node scripts/validation/codex-notification-live-smoke.js --thread-id <id> --execute",
    "",
    "Without --execute, performs input validation only and does not contact Codex.",
    "Use --timeout-ms <1000..600000> to bound the App Server call (default: 120000).",
    "CORTEX_CODEX_THREAD_ID or CODEX_THREAD_ID can supply the thread ID.",
    "The real run appends a notification turn to the specified Codex thread.",
  ].join("\n");
}

function parseOptions(argv, env = process.env) {
  const options = { execute: false, timeoutMs: 120000, threadId: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--thread-id" || arg === "--timeout-ms") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg);
      if (arg === "--thread-id") options.threadId = value;
      else {
        const timeout = Number(value);
        if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000) {
          throw new Error("--timeout-ms must be an integer from 1000 to 600000");
        }
        options.timeoutMs = timeout;
      }
    } else throw new Error("Unsupported flag: " + arg);
  }
  if (!options.help) {
    options.threadId = validateThreadId(
      options.threadId || env.CORTEX_CODEX_THREAD_ID || env.CODEX_THREAD_ID,
    );
  }
  return options;
}

function buildRequest() {
  return {
    eventId: "codex-smoke-" + crypto.randomUUID(),
    taskId: "CODEX-LOCAL-SMOKE",
    eventType: "task.ready_for_review",
    state: "ready_for_review",
    message: "Transport verification only. Please acknowledge this notice without changing files.",
    evidenceRefs: [],
    requestedAction: null,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv, env);
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const threadFingerprint = crypto.createHash("sha256").update(options.threadId).digest("hex").slice(0, 16);
  if (!options.execute) {
    process.stdout.write(JSON.stringify({
      result: "dry-run",
      threadFingerprint,
      willStartCodexTurn: false,
      transport: "codex app-server --stdio (separate process)",
    }) + "\n");
    return;
  }

  const started = Date.now();
  const result = await deliverCodexWakeup(buildRequest(), {
    threadId: options.threadId,
    timeoutMs: options.timeoutMs,
  });
  process.stdout.write(JSON.stringify({
    result: "rpc_turn_completed",
    threadFingerprint,
    turnStatus: result.status,
    elapsedMs: Date.now() - started,
    desktopUiVisibility: "NOT_VERIFIED",
    governanceAck: "NOT_PERFORMED",
  }) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      result: "failed",
      errorCode: error.code || "ERR_CODEX_SMOKE",
      note: "No Desktop UI or governance acknowledgement is implied; inspect local logs.",
    }) + "\n");
    process.exitCode = 1;
  });
}

module.exports = { buildRequest, main, parseOptions, usage };
