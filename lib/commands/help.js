"use strict";

// ─── help — `cliHelp` (JSON contract) + `printHelp` (human-readable) ──────────
//
// Originally lived in lib/commands.js (T-FOLLOW-002 v2 module-split). Body of
// `cliHelp` and `printHelp` is kept byte-identical to the original; only the
// imports change so the helpers come from their canonical home modules.
//
// `cliHelp` references two helpers that used to be local in lib/commands.js
// (`printManagementPayload`, `managementApiError`). To keep the function
// bodies byte-identical and avoid creating a circular require against
// `../commands`, the helpers are inlined here under their original names.
// A future refactor can extract them to a shared `lib/commands/_helpers.js`
// without changing the call sites inside `cliHelp`.

const path = require("node:path");

const cliContract = require("../cli/contract");
const { PLATFORM_REGISTRY } = require("../registry/index");
const PKG_VERSION = require("../../package.json").version;
const { queryManagementProject } = require("../management/client");

// ── helpers (inlined to avoid circular require + preserve function bodies) ────

function printManagementPayload(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

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

// ── extracted entry points ────────────────────────────────────────────────────

function cliHelp(ctx) {
  const topic = ctx.args.slice(1).find((arg) => !arg.startsWith("--")) || null;
  const selected = topic ? cliContract.commands.find((item) => item.name === topic) : null;
  if (topic && !selected) {
    printManagementPayload({ ok: false, error: { code: "UNKNOWN_HELP_TOPIC", message: `Unknown CLI help topic: ${topic}`, details: { topic } } });
    process.exitCode = 2;
    return;
  }
  const payload = {
    ok: true,
    command: "help",
    version: PKG_VERSION,
    contract: topic ? { ...cliContract, commands: [selected] } : cliContract,
  };
  if (topic === "query" && ctx.args.some((arg) => arg === "--project" || arg.startsWith("--project="))) {
    const result = queryManagementProject(ctx, "capabilities");
    if (!result.ok) {
      managementApiError(ctx, result);
      return;
    }
    payload.project = result.project;
    payload.management_capabilities = result.payload;
  }
  printManagementPayload(payload);
}

function printHelp() {
  console.log("Usage: cortex-agent <command> [options]");
  console.log("\nCommands:");
  for (const entry of cliContract.commands) console.log(`  ${entry.usage.padEnd(46)} ${entry.description}`);
  console.log("\nOptions:");
  for (const entry of cliContract.options) console.log(`  ${entry.name.padEnd(46)} ${entry.description}`);
  console.log("\nAvailable platforms:");
  Object.entries(PLATFORM_REGISTRY).forEach(([key, p]) => {
    console.log(`  ${key.padEnd(16)} ${p.name}`);
  });
}

module.exports = {
  cliHelp,
  printHelp,
};
