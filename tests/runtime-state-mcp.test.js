"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const EN = path.join(ROOT, "templates/en/.agent/skills/runtime-state-mcp");
const ZH = path.join(ROOT, "templates/zh/.agent/skills/runtime-state-mcp");
const SERVER = path.join(EN, "scripts/server.js");
const QUERIES = ["runtime-state", "workspaces", "hook-runs", "resource-leases", "composite-workspaces", "resource-events", "guided-reviews", "benchmarks"];

function frame(value) {
  return `${JSON.stringify(value)}\n`;
}

function invoke(requests, apiScript, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, "--management-api-script", apiScript], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      resolve({ responses, stderr });
    });
    child.stdin.end(requests.map(frame).join(""));
  });
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-state-mcp-"));
  const projection = { ok: true, query: "", generated_at: "2026-07-19T00:00:00Z", resources: [{ resource_type: "workspace", resource_id: "W-1", status: "active" }], summary: { total: 1 }, recent_events: [], blocking: [], evidence_readiness: { ready: 1, missing: 0, unavailable: 0 } };
  const api = path.join(dir, "fake-api.js");
  fs.writeFileSync(api, `const q=process.argv[3];const p=${JSON.stringify(projection)};p.query=q;process.stdout.write(JSON.stringify(p));\n`);
  const marker = path.join(dir, "fixture.json");
  fs.writeFileSync(marker, JSON.stringify({ immutable: true }) + "\n");
  return { dir, api, marker, projection };
}

test("lists the frozen allowlist and reads deep-identical Management API projections", async () => {
  const f = fixture(); const before = fs.readFileSync(f.marker);
  const requests = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }];
  QUERIES.forEach((query, index) => requests.push({ jsonrpc: "2.0", id: index + 3, method: "resources/read", params: { uri: `cortex://runtime-state/${query}` } }));
  const result = await invoke(requests, f.api, f.dir);
  assert.deepEqual(result.responses[1].result.resources.map((item) => item.uri), QUERIES.map((q) => `cortex://runtime-state/${q}`));
  QUERIES.forEach((query, index) => assert.deepEqual(JSON.parse(result.responses[index + 2].result.contents[0].text), { ...f.projection, query }));
  assert.deepEqual(fs.readFileSync(f.marker), before);
  assert.equal(result.stderr, "");
});

test("unknown URI and mutation methods fail closed", async () => {
  const f = fixture();
  const result = await invoke([
    { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "cortex://runtime-state/secrets" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mutate" } },
  ], f.api, f.dir);
  assert.equal(result.responses[0].error.code, -32602);
  assert.equal(result.responses[1].error.code, -32601);
  assert.match(result.stderr, /Unsupported resource URI/);
});

test("unavailable Management API produces a structured diagnostic error", async () => {
  const f = fixture();
  const result = await invoke([{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "cortex://runtime-state/workspaces" } }], path.join(f.dir, "missing.js"), f.dir);
  assert.equal(result.responses[0].error.code, -32001);
  assert.equal(result.responses[0].error.data.reason, "management_api_query_failed");
  assert.match(result.stderr, /Management API query workspaces failed/);
});

test("locale machine files are byte-identical and contain no direct state parser", () => {
  const en = fs.readFileSync(path.join(EN, "scripts/server.js"), "utf8");
  const zh = fs.readFileSync(path.join(ZH, "scripts/server.js"), "utf8");
  assert.equal(zh, en);
  assert.doesNotMatch(en, /readFileSync|\.agent\/(?:runs|workspaces|sessions)/);
  assert.doesNotMatch(en, /tools\/list|tools\/call.*result/);
});
