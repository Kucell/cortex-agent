"use strict";

// tests/mcp/ping.test.js — MCP health-check tests (P-002 MS-003).
// Spawns tiny fake server scripts; no real network involved.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ping, parseTimeout } = require("../../lib/mcp/ping");

const FAKE_OK_SERVER = `
process.stdin.on('data', (chunk) => {
  for (const line of String(chunk).split('\\n')) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {
        tools: [{ name: 'design/list', description: 'd' }, { name: 'prd/list', description: 'p' }],
        serverInfo: { name: 'fake-server', version: '1.0.0' }
      } }) + '\\n');
    }
  }
});
process.stdin.on('end', () => {});
`;

const FAKE_SILENT_SERVER = `
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
`;

function writeScript(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-ping-"));
  const file = path.join(dir, "fake-server.js");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("parseTimeout parses ms and seconds", () => {
  assert.equal(parseTimeout(undefined), 5000);
  assert.equal(parseTimeout(""), 5000);
  assert.equal(parseTimeout("5s"), 5000);
  assert.equal(parseTimeout("10s"), 10000);
  assert.equal(parseTimeout("1500"), 1500);
  assert.equal(parseTimeout("1500ms"), 1500);
  assert.equal(parseTimeout("garbage"), 5000);
});

test("ping returns ok with tools when the server answers tools/list", async () => {
  const cli = writeScript(FAKE_OK_SERVER);
  try {
    const result = await ping({ cli, timeout: 3000, cwd: os.tmpdir() });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tools.length, 2);
    assert.equal(result.tools[0].name, "design/list");
    assert.equal(result.serverInfo.name, "fake-server");
    assert.ok(typeof result.latencyMs === "number");
  } finally { fs.rmSync(path.dirname(cli), { recursive: true, force: true }); }
});

test("ping fails with timeout when the server never responds", async () => {
  const cli = writeScript(FAKE_SILENT_SERVER);
  try {
    const result = await ping({ cli, timeout: 250, cwd: os.tmpdir() });
    assert.equal(result.ok, false);
    assert.match(result.error, /timeout/);
  } finally { fs.rmSync(path.dirname(cli), { recursive: true, force: true }); }
});

test("ping fails cleanly when the server process cannot be spawned", async () => {
  const missing = path.join(os.tmpdir(), "no-such-cli-xyz.js");
  const result = await ping({ cli: missing, timeout: 500, cwd: os.tmpdir() });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("ping fails when the server exits before responding", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-ping-exit-"));
  const cli = path.join(dir, "exit-server.js");
  fs.writeFileSync(cli, "process.stdin.on('end', () => {}); process.exit(0);\n", "utf8");
  try {
    const result = await ping({ cli, timeout: 1000, cwd: os.tmpdir() });
    assert.equal(result.ok, false);
    assert.match(result.error, /exited|error/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
