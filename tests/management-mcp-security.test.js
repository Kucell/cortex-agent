"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createProject, invoke } = require("./helpers/management-mcp");

function digest(dir) {
  const hash = crypto.createHash("sha256");
  const visit = (current) => fs.readdirSync(current).sort().forEach((name) => {
    const file = path.join(current, name);
    const stat = fs.statSync(file);
    hash.update(path.relative(dir, file));
    if (stat.isDirectory()) visit(file); else hash.update(fs.readFileSync(file));
  });
  visit(dir);
  return hash.digest("hex");
}

test("MCP is single-project, read-only, and fails closed", async (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const before = digest(path.join(project, ".agent"));
  const result = await invoke(project, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1900-01-01" } },
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "cortex://management/secrets" } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mutate", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cortex.query", arguments: { projection: "runs", command: "write" } } },
  ]);
  assert.deepEqual(result.responses.map((response) => response.error.code), [-32602, -32602, -32602, -32602]);
  assert.equal(digest(path.join(project, ".agent")), before);
  assert.doesNotMatch(result.stdout, /runtime-state-mcp/);
  assert.match(result.stderr, /Unsupported/);
});
