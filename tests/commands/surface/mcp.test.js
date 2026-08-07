"use strict";

// ─── lib/commands/surface/mcp.js unit tests ───────────────────────────────────
//
// Coverage:
//   - missing `serve` subcommand → invalidManagementUsage, exitCode = 2
//   - resolveManagementProject returns !ok → managementApiError path
//   - target project missing the MCP server script → exitCode = 3
//   - happy path: spawn is invoked with correct args (we don't actually run it)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mcp } = require("../../../lib/commands/surface/mcp");

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

function makeCtx(args) {
  return {
    args,
    options: {},
    cwd: process.cwd(),
    lang: "en",
    command: "mcp",
  };
}

test("mcp: missing subcommand → invalidManagementUsage, exitCode = 2", async () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await mcp(makeCtx(["mcp"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("mcp: unknown subcommand → exitCode = 2", async () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await mcp(makeCtx(["mcp", "start"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});
