"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ROOT, createProject, invoke } = require("./helpers/management-mcp");

test("cortex-agent mcp serve negotiates resources and read-only query tool", async (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const result = await invoke(project, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.responses[0].result.protocolVersion, "2025-03-26");
  assert.match(result.responses[0].result.instructions, /Writer tools are disabled/);
  assert.equal(result.responses[1].result.resources.some((item) => item.uri === "cortex://management/activity"), true);
  assert.deepEqual(result.responses[2].result.tools.map((tool) => tool.name), ["cortex.query"]);
});

test("local and localized MCP skills document standard read-only serve", () => {
  for (const file of [
    path.join(ROOT, ".agent", "skills", "runtime-state-mcp", "SKILL.md"),
    path.join(ROOT, "templates", "en", ".agent", "skills", "runtime-state-mcp", "SKILL.md"),
    path.join(ROOT, "templates", "zh", ".agent", "skills", "runtime-state-mcp", "SKILL.md"),
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /cortex-agent mcp serve --project/);
    assert.match(source, /cortex:\/\/management\/<projection>/);
    assert.match(source, /Writer tools (?:are disabled|默认并持续禁用)/);
  }
});
