"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { createProject, direct, invoke } = require("./helpers/management-mcp");

function semantic(payload) {
  const normalized = structuredClone(payload);
  delete normalized.generated_at;
  return normalized;
}

test("every listed MCP resource is readable and matches the real Management API", async (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const listed = await invoke(project, [{ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} }]);
  assert.equal(listed.code, 0, listed.stderr);
  const resources = listed.responses[0].result.resources;
  const reads = await invoke(project, resources.map((resource, index) => ({ jsonrpc: "2.0", id: index + 1, method: "resources/read", params: { uri: resource.uri } })));
  assert.equal(reads.code, 0, reads.stderr);
  resources.forEach((resource, index) => {
    const projection = resource.uri.slice("cortex://management/".length);
    assert.deepEqual(semantic(JSON.parse(reads.responses[index].result.contents[0].text)), semantic(direct(project, projection)));
  });

  const tool = await invoke(project, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cortex.query", arguments: { projection: "runs" } } }]);
  assert.deepEqual(semantic(tool.responses[0].result.structuredContent), semantic(direct(project, "runs")));
});
