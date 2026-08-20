"use strict";

// tests/mcp/server.test.js — stdio MCP server handler tests (P-002 MS-003).
// Uses a tmp fixture project + stub catalog/skill dependencies; no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createHandler,
  toolDefinitions,
  resourceTemplates,
  defaultDeps,
  defaultInstallSystem,
} = require("../../lib/mcp/server");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-server-"));
  // design system (v1 lock + installed files)
  fs.mkdirSync(path.join(root, ".agent", "design-systems", "acme"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "design-systems", "acme", "DESIGN.md"), "# Acme Design\n\n## Colors\n- primary: #123456\n");
  fs.writeFileSync(
    path.join(root, ".agent", "design-systems.lock"),
    JSON.stringify({ lockfileVersion: 1, schemaVersion: "od-design-system-project/v1", systems: [{ id: "acme", license: "Apache-2.0", category: "Brand" }] }, null, 2),
  );
  fs.writeFileSync(path.join(root, "DESIGN.md"), "# User override\n");
  // prototypes
  fs.mkdirSync(path.join(root, ".agent", "prototypes", "T-1"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "prototypes", "T-1", "prototype.html"), "<h1>Hello</h1>\n");
  fs.writeFileSync(path.join(root, ".agent", "prototypes", "T-1", "validation-contract.json"), "{}\n");
  // prd
  fs.mkdirSync(path.join(root, ".agent", "prd", "PRD-001"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "prd", "PRD-001", "prd.md"), "# PRD-001\n");
  fs.writeFileSync(path.join(root, ".agent", "prd", "PRD-001", "flows.md"), "# Flows\n");
  // skills
  fs.mkdirSync(path.join(root, ".agent", "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Alpha skill\narea: swe\n---\n# Alpha\n");
  // templates + plugins (local scan)
  fs.mkdirSync(path.join(root, ".agent", "templates", "saas-landing"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "templates", "saas-landing", "SKILL.md"), "# Saas Landing\n");
  fs.mkdirSync(path.join(root, ".agent", "plugins", "od-figma-migration"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "plugins", "od-figma-migration", "manifest.json"), "{}\n");
  return root;
}

function stubCatalog(overrides) {
  const starter = {
    "design-system": { entries: [{ id: "acme", kind: "design-system", source: "starter" }] },
    plugin: { entries: [{ id: "od-figma-migration", kind: "plugin", source: "starter" }] },
    skill: { entries: [] },
    template: { entries: [{ id: "saas-landing", kind: "template", source: "starter" }] },
  };
  return Object.assign(
    {
      loadAllKinds: () => ({ kinds: starter }),
      loadAllKindsAsync: async () => ({ kinds: starter }),
      findById: (idx, id) => {
        const found = [];
        for (const kind of Object.keys(starter)) {
          for (const e of starter[kind].entries) if (e.id === id) found.push({ ...e, kind });
        }
        return found;
      },
      listKind: (idx, kind) => starter[kind] ? starter[kind].entries : [],
    },
    overrides || {},
  );
}

function stubCatalogLockfile(overrides) {
  return Object.assign(
    {
      readLockfile: () => ({ lockfileVersion: 2, catalogs: [] }),
      listByKind: () => [],
    },
    overrides || {},
  );
}

function makeHandler(root, overrides) {
  const deps = defaultDeps({
    cwd: root,
    templateDir: path.join(root, "templates"), // absent — no starter layer
    catalog: stubCatalog(),
    catalogLockfile: stubCatalogLockfile(),
    installSystem: async (id, opts) => ({ status: "installed", message: `installed ${id}` }),
    skillBrowse: () => ({ skills: [{ name: "fallback-skill", area: "swe", summary: "fb" }] }),
  });
  return createHandler(Object.assign(deps, overrides || {}));
}

async function call(h, request) {
  return h.handle(request);
}

function expectRpcError(promise) {
  return promise.then(
    () => { throw new Error("expected rpc error"); },
    (err) => err.rpc,
  );
}

// ─── protocol basics ─────────────────────────────────────────────────────────

test("tools/list returns exactly the 11 P-002 tools", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = result.tools.map((t) => t.name);
    assert.equal(names.length, 11);
    for (const expected of [
      "design/list", "design/show", "design/install", "design/resolved",
      "prototype/list", "prototype/show", "prd/list", "prd/show",
      "template/list", "plugin/list", "skill/browse",
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("toolDefinitions and resourceTemplates match handler surface", () => {
  assert.equal(toolDefinitions().length, 11);
  assert.equal(resourceTemplates().length, 4);
  assert.deepEqual(resourceTemplates().map((r) => r.uri), [
    "design://resolved", "design://systems/{id}", "prototype://{taskId}/{path}", "prd://{prdId}/{file}",
  ]);
});

test("initialize returns protocol version and server info", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.equal(result.serverInfo.name, "cortex-agent-mcp");
    assert.match(result.instructions, /read-only/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("notifications/initialized returns null (no response)", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    assert.equal(result, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ping returns pong", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 9, method: "ping", params: {} });
    assert.deepEqual(result, { pong: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unknown method yields JSON-RPC -32601", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const rpc = await expectRpcError(call(h, { jsonrpc: "2.0", id: 1, method: "bogus", params: {} }));
    assert.equal(rpc.code, -32601);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ─── design tools ────────────────────────────────────────────────────────────

test("design/list returns installed systems + optional cascade", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design/list", arguments: { cascade: true } } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.installed.length, 1);
    assert.equal(result.structuredContent.installed[0].id, "acme");
    assert.ok(Array.isArray(result.structuredContent.cascade));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("design/show returns the installed DESIGN.md content", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design/show", arguments: { id: "acme" } } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.system.id, "acme");
    assert.match(result.structuredContent.design, /# Acme Design/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("design/show for an unknown id returns an isError result", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design/show", arguments: { id: "nope" } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not installed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("design/install requires confirm:true (write gate)", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design/install", arguments: { id: "acme" } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /confirm/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("design/install delegates to installSystem when confirmed", async () => {
  const root = makeFixture();
  try {
    const calls = [];
    const h = makeHandler(root, {
      installSystem: async (id, opts) => { calls.push({ id, opts }); return { status: "installed", message: `ok ${id}` }; },
    });
    // acme is already installed in the fixture lock → force: true to reinstall.
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design/install", arguments: { id: "acme", confirm: true, force: true } } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, "installed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "acme");
    assert.equal(calls[0].opts.force, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("design/install refuses reinstall without force", async () => {
  const root = makeFixture();
  try {
    const calls = [];
    const h = makeHandler(root, {
      installSystem: async (id, opts) => { calls.push({ id, opts }); return { status: "installed" }; },
    });
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design/install", arguments: { id: "acme", confirm: true } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already installed/);
    assert.equal(calls.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("design/resolved returns the 4-level cascade chain", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design/resolved", arguments: {} } });
    const layers = result.structuredContent.layers;
    assert.ok(layers.some((l) => l.kind === "user-override"));
    assert.ok(layers.some((l) => l.kind === "installed" && l.id === "acme"));
    assert.equal(result.structuredContent.effective.kind, "user-override");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ─── prototype / prd tools ───────────────────────────────────────────────────

test("prototype/list and prototype/show read fixture files", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const list = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "prototype/list", arguments: {} } });
    assert.equal(list.structuredContent.prototypes.length, 1);
    assert.equal(list.structuredContent.prototypes[0].taskId, "T-1");
    const show = await call(h, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "prototype/show", arguments: { taskId: "T-1", path: "prototype.html" } } });
    assert.match(show.structuredContent.content, /Hello/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("prd/list and prd/show read fixture files (default prd.md)", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const list = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "prd/list", arguments: {} } });
    assert.equal(list.structuredContent.prds.length, 1);
    assert.equal(list.structuredContent.prds[0].prdId, "PRD-001");
    const show = await call(h, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "prd/show", arguments: { prdId: "PRD-001" } } });
    assert.equal(show.structuredContent.file, "prd.md");
    assert.match(show.structuredContent.content, /PRD-001/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("prd/show rejects path traversal", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "prd/show", arguments: { prdId: "PRD-001", file: "../../../etc/passwd" } } });
    assert.equal(result.isError, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ─── template / plugin / skill tools ─────────────────────────────────────────

test("template/list returns installed + local + optional available", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "template/list", arguments: { available: true } } });
    assert.ok(result.structuredContent.local.some((e) => e.id === "saas-landing"));
    assert.ok(Array.isArray(result.structuredContent.available));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("plugin/list returns installed + local entries", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plugin/list", arguments: {} } });
    assert.ok(result.structuredContent.local.some((e) => e.id === "od-figma-migration"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("skill/browse lists project skills and expands on demand", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const list = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skill/browse", arguments: {} } });
    assert.equal(list.structuredContent.scanned, 1);
    assert.equal(list.structuredContent.skills[0].name, "alpha");
    const expanded = await call(h, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "skill/browse", arguments: { name: "alpha", expand: true } } });
    assert.match(expanded.structuredContent.expanded.content, /# Alpha/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("skill/browse falls back to template skills when .agent/skills is empty", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-skill-fb-"));
  try {
    const h = makeHandler(root);
    const result = await call(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skill/browse", arguments: {} } });
    assert.ok(result.structuredContent.skills.some((s) => s.name === "fallback-skill"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ─── resources ───────────────────────────────────────────────────────────────

test("resources/read resolves design://resolved and design://systems/{id}", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const resolved = await call(h, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "design://resolved" } });
    assert.match(resolved.contents[0].text, /"ok":true/);
    const sys = await call(h, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "design://systems/acme" } });
    assert.match(sys.contents[0].text, /Acme Design/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resources/read resolves prototype:// and prd:// and blocks traversal", async () => {
  const root = makeFixture();
  try {
    const h = makeHandler(root);
    const proto = await call(h, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "prototype://T-1/prototype.html" } });
    assert.match(proto.contents[0].text, /Hello/);
    const prd = await call(h, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "prd://PRD-001/prd.md" } });
    assert.match(prd.contents[0].text, /PRD-001/);
    const rpc = await expectRpcError(call(h, { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "prototype://T-1/../../../etc/passwd" } }));
    assert.equal(rpc.code, -32602);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ─── install backend ─────────────────────────────────────────────────────────

test("defaultInstallSystem maps design install exit codes to status", () => {
  // Exit 2 (id not in catalog) is the deterministic offline path.
  const result = defaultInstallSystem("definitely-not-in-catalog", { cwd: process.cwd() });
  assert.ok(["rejected", "network_error", "error"].includes(result.status), result.status);
  assert.ok(typeof result.message === "string");
});
