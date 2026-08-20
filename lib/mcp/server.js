"use strict";

/**
 * lib/mcp/server.js — cortex-agent stdio MCP server (P-002 MS-003).
 *
 * Exposes 11 tools + 4 resource URI handlers over `.agent/` assets:
 * design systems (delegates to lib/catalog + lib/design), prototypes
 * (.agent/prototypes/), PRDs (.agent/prd/), templates & plugins
 * (lib/catalog kinds), and skills (.agent/skills/).
 *
 * Protocol: JSON-RPC 2.0 over stdio, newline-delimited frames (see
 * lib/mcp/jsonrpc.js). Matches the MCP transport used by the existing
 * runtime-state MCP server.
 *
 * Zero npm deps — node:fs / node:path / node:child_process / node:readline
 * only. Read-only by default; the single write tool (design/install)
 * requires an explicit `confirm: true` argument and delegates to the
 * content-addressed `cortex-agent design install` CLI.
 *
 * Architecture: every tool is a pure function of `deps`, so tests inject
 * stub catalog/scan dependencies and a tmp project root. The stdio loop
 * lives in startServer(); createHandler() returns the pure dispatcher.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const jsonrpc = require("./jsonrpc");

const SERVER_INFO = { name: "cortex-agent-mcp", version: "1.0.0" };
const PROTOCOLS = new Set(["2025-03-26", "2024-11-05"]);

// ─── rpc errors ──────────────────────────────────────────────────────────────

function rpcError(code, message, data) {
  const error = new Error(message);
  error.rpc = { code, message, data };
  return error;
}

// ─── fs helpers (all read-only, best-effort) ────────────────────────────────

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function readSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (_) {
    return null;
  }
}

function listDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (_) {
    return [];
  }
}

function listDirFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => isFile(path.join(dir, name))).sort();
  } catch (_) {
    return [];
  }
}

/** Resolve `rel` inside `base`; null when it escapes (path traversal guard). */
function resolveInside(base, rel) {
  const root = path.resolve(base);
  const target = path.resolve(root, rel || ".");
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Parse `---\nkey: value\n---` frontmatter into an object. */
function parseFrontmatter(text) {
  const out = {};
  if (!text) return out;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return out;
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

// ─── tool definitions (P-002 §4.1) ───────────────────────────────────────────

function toolDefinitions() {
  return [
    {
      name: "design/list",
      description: "List installed design systems (4-level cascade aware)",
      inputSchema: {
        type: "object",
        properties: {
          available: { type: "boolean", description: "List available from upstream (not just installed)" },
          cascade: { type: "boolean", description: "Show full 4-level cascade chain" },
        },
      },
    },
    {
      name: "design/show",
      description: "Show the effective DESIGN.md content (after cascade resolution)",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "design/install",
      description: "Install a design system from upstream (license ack + confirm required)",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, force: { type: "boolean" }, confirm: { type: "boolean", description: "Explicit write confirmation; required" } },
        required: ["id", "confirm"],
      },
    },
    {
      name: "design/resolved",
      description: "Print the active 4-level cascade resolution",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "prototype/list",
      description: "List prototypes under .agent/prototypes/",
      inputSchema: { type: "object", properties: { taskId: { type: "string" } } },
    },
    {
      name: "prototype/show",
      description: "Show prototype files (HTML, flow.md, validation-contract.json)",
      inputSchema: { type: "object", properties: { taskId: { type: "string" }, path: { type: "string" } }, required: ["taskId"] },
    },
    {
      name: "prd/list",
      description: "List PRDs under .agent/prd/",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "prd/show",
      description: "Show PRD content (prd.md / flows.md / screens.md / acceptance-criteria.md)",
      inputSchema: { type: "object", properties: { prdId: { type: "string" }, file: { type: "string" } }, required: ["prdId"] },
    },
    {
      name: "template/list",
      description: "List design templates (open-design upstream + local)",
      inputSchema: { type: "object", properties: { available: { type: "boolean" }, scenario: { type: "string" }, mode: { type: "string" } } },
    },
    {
      name: "plugin/list",
      description: "List installed plugins (open-design upstream + local)",
      inputSchema: { type: "object", properties: { available: { type: "boolean" } } },
    },
    {
      name: "skill/browse",
      description: "Browse .agent/skills/ with on-demand expansion",
      inputSchema: { type: "object", properties: { name: { type: "string" }, expand: { type: "boolean" } } },
    },
  ];
}

function resourceTemplates() {
  return [
    { uri: "design://resolved", name: "Active design spec (4-level cascade effective)", mimeType: "application/json" },
    { uri: "design://systems/{id}", name: "DESIGN.md of installed system {id}", mimeType: "text/markdown" },
    { uri: "prototype://{taskId}/{path}", name: "Prototype file {path} for task {taskId}", mimeType: "text/plain" },
    { uri: "prd://{prdId}/{file}", name: "PRD asset {file} for PRD {prdId}", mimeType: "text/markdown" },
  ];
}

// ─── tool implementations ────────────────────────────────────────────────────

function designList(deps, args) {
  const cwd = deps.cwd;
  const installed = deps.designLockfile.listSystems(cwd).map((s) => ({ ...s, kind: "design-system" }));
  let available = null;
  if (args && args.available) {
    const idx = deps.catalog.loadAllKinds({});
    available = (idx.kinds["design-system"] && idx.kinds["design-system"].entries) || [];
  }
  let cascade = null;
  if (args && args.cascade) {
    cascade = deps.designResolve.resolveCascade({ cwd, templateDir: deps.templateDir });
  }
  return { ok: true, installed, available, cascade };
}

function designShow(deps, args) {
  const id = args && args.id;
  if (!id || typeof id !== "string") return { ok: false, error: "design/show: id required" };
  const sys = deps.designLockfile.getSystem(deps.cwd, id);
  if (!sys) return { ok: false, error: `design/show: not installed: ${id}` };
  const designPath = path.join(deps.cwd, ".agent", "design-systems", id, "DESIGN.md");
  return { ok: true, system: sys, path: designPath, design: readSafe(designPath) };
}

async function designInstall(deps, args) {
  const id = args && args.id;
  if (!id || typeof id !== "string") return { ok: false, error: "design/install: id required" };
  if (!(args && args.confirm === true)) {
    return { ok: false, error: "design/install: write tool — pass confirm: true to proceed" };
  }
  const installed = deps.designLockfile.listSystems(deps.cwd);
  if (!(args.force === true) && installed.some((s) => s.id === id)) {
    return { ok: false, error: `design/install: already installed: ${id} (pass force: true to reinstall)` };
  }
  const idx = deps.catalog.loadAllKinds({});
  const entry = (deps.catalog.findById(idx, id) || []).find((e) => e.kind === "design-system");
  if (!entry) return { ok: false, error: `design/install: id not in catalog: ${id}` };
  const result = await deps.installSystem(id, { force: args.force === true, cwd: deps.cwd });
  return { ok: true, ...result };
}

function designResolved(deps) {
  const layers = deps.designResolve.resolveCascade({ cwd: deps.cwd, templateDir: deps.templateDir });
  return { ok: true, layers, effective: layers.length > 0 ? layers[0] : null };
}

function prototypeList(deps, args) {
  const base = path.join(deps.cwd, ".agent", "prototypes");
  if (args && args.taskId) {
    const dir = path.join(base, String(args.taskId));
    return { ok: true, taskId: String(args.taskId), files: listDirFiles(dir) };
  }
  const prototypes = listDirNames(base).map((taskId) => ({ taskId, files: listDirFiles(path.join(base, taskId)) }));
  return { ok: true, prototypes };
}

function prototypeShow(deps, args) {
  const taskId = args && args.taskId;
  if (!taskId || typeof taskId !== "string") return { ok: false, error: "prototype/show: taskId required" };
  const rel = (args && args.path) || "prototype.html";
  const dir = path.resolve(deps.cwd, ".agent", "prototypes", taskId);
  const target = resolveInside(dir, rel);
  if (!target || !isFile(target)) {
    return { ok: false, error: `prototype/show: file not found: ${taskId}/${rel}` };
  }
  return { ok: true, taskId, path: rel, content: readSafe(target) };
}

function prdList(deps) {
  const base = path.join(deps.cwd, ".agent", "prd");
  const prds = listDirNames(base).map((prdId) => ({ prdId, files: listDirFiles(path.join(base, prdId)) }));
  return { ok: true, prds };
}

function prdShow(deps, args) {
  const prdId = args && args.prdId;
  if (!prdId || typeof prdId !== "string") return { ok: false, error: "prd/show: prdId required" };
  const dir = path.resolve(deps.cwd, ".agent", "prd", prdId);
  const files = listDirFiles(dir);
  const file = (args && args.file) || (files.includes("prd.md") ? "prd.md" : files[0]);
  if (!file) return { ok: false, error: `prd/show: no files under .agent/prd/${prdId}` };
  const target = resolveInside(dir, file);
  if (!target || !isFile(target)) {
    return { ok: false, error: `prd/show: file not found: ${prdId}/${file}` };
  }
  return { ok: true, prdId, file, files, content: readSafe(target) };
}

function templateList(deps, args) {
  const lock = deps.catalogLockfile.readLockfile(deps.cwd);
  const installed = deps.catalogLockfile.listByKind(lock, "template").map((e) => ({ ...e, kind: "template" }));
  // Local scan of .agent/templates/<id> as a fallback view.
  const local = listDirNames(path.join(deps.cwd, ".agent", "templates")).map((id) => ({ id, kind: "template", source: "local" }));
  let available = null;
  if (args && args.available) {
    const idx = deps.catalog.loadAllKinds({});
    available = (idx.kinds.template && idx.kinds.template.entries) || [];
  }
  let filtered = installed;
  if (args && args.scenario) {
    const q = String(args.scenario).toLowerCase();
    filtered = filtered.filter((e) => (e.id || "").includes(q) || (e.name || "").toLowerCase().includes(q));
  }
  return { ok: true, installed: filtered, local, available, mode: (args && args.mode) || null };
}

function pluginList(deps, args) {
  const lock = deps.catalogLockfile.readLockfile(deps.cwd);
  const installed = deps.catalogLockfile.listByKind(lock, "plugin").map((e) => ({ ...e, kind: "plugin" }));
  const local = listDirNames(path.join(deps.cwd, ".agent", "plugins")).map((id) => ({ id, kind: "plugin", source: "local" }));
  let available = null;
  if (args && args.available) {
    const idx = deps.catalog.loadAllKinds({});
    available = (idx.kinds.plugin && idx.kinds.plugin.entries) || [];
  }
  return { ok: true, installed, local, available };
}

function skillBrowse(deps, args) {
  const base = path.join(deps.cwd, ".agent", "skills");
  const cards = [];
  for (const name of listDirNames(base)) {
    const skillFile = path.join(base, name, "SKILL.md");
    if (!isFile(skillFile)) continue;
    const meta = parseFrontmatter(readSafe(skillFile));
    cards.push({
      name,
      area: meta.area || "uncategorized",
      summary: meta.summary || meta.description || "",
    });
  }
  // Fallback: framework template skills when the project has no .agent/skills.
  if (cards.length === 0 && deps.skillBrowse) {
    const fallback = deps.skillBrowse({});
    for (const s of fallback.skills || []) cards.push({ name: s.name, area: s.area, summary: s.summary });
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  let expanded = null;
  if (args && args.name) {
    const skill = cards.find((c) => c.name === String(args.name));
    if (!skill) return { ok: false, error: `skill/browse: unknown skill: ${args.name}` };
    if (args.expand === true) {
      const skillFile = path.join(base, skill.name, "SKILL.md");
      expanded = { name: skill.name, content: readSafe(skillFile) };
    }
    return { ok: true, scanned: cards.length, skills: [skill], expanded };
  }
  return { ok: true, scanned: cards.length, skills: cards, expanded: null };
}

// ─── design/install default backend (content-addressed CLI) ──────────────────

function defaultInstallSystem(id, opts) {
  const cli = path.resolve(__dirname, "..", "..", "bin", "cli.js");
  const result = spawnSync(
    process.execPath,
    [cli, "design", "install", id, "--yes"],
    { cwd: opts.cwd, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) {
    return { status: "error", message: `failed to spawn design install: ${result.error.message}` };
  }
  const stderr = String(result.stderr || "").trim();
  switch (result.status) {
    case 0:
      return { status: "installed", message: String(result.stdout || "").trim() || `installed ${id}` };
    case 2:
      return { status: "rejected", message: stderr || `not installed: ${id} (not in catalog)` };
    case 3:
      return { status: "network_error", message: stderr || "upstream catalog fetch failed" };
    case 4:
      return { status: "license_rejected", message: stderr || "license not accepted" };
    default:
      return { status: "error", message: stderr || `design install exited ${result.status}` };
  }
}

// ─── handler ─────────────────────────────────────────────────────────────────

function createHandler(deps) {
  // Fill any missing dependency with the production default so partial stubs
  // (and direct handler use) never see undefined internals.
  const resolved = Object.assign(defaultDeps({}), deps || {});
  const installedTools = toolDefinitions();

  async function handle(request) {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      throw rpcError(-32600, "Invalid Request", { reason: "invalid_json_rpc_request" });
    }
    const method = request.method;
    const params = request.params || {};

    if (method === "initialize") {
      const requested = params.protocolVersion;
      if (requested && !PROTOCOLS.has(requested)) {
        throw rpcError(-32602, "Unsupported protocol version", { requested, supported: [...PROTOCOLS] });
      }
      return {
        protocolVersion: requested || "2025-03-26",
        capabilities: { resources: {}, tools: {} },
        serverInfo: SERVER_INFO,
        instructions: `cortex-agent MCP bridge for ${deps.cwd}. Read-only design/prototype/prd/template/plugin/skill tools; design/install is the only write tool and requires confirm: true.`,
      };
    }
    if (method === "notifications/initialized") return null;
    if (method === "ping") return { pong: true };
    if (method === "resources/list") {
      return { resources: resourceTemplates() };
    }
    if (method === "resources/read") {
      return { contents: [await readResource(deps, params.uri)] };
    }
    if (method === "tools/list") {
      return { tools: installedTools };
    }
    if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments || {};
      const tool = installedTools.find((t) => t.name === name);
      if (!tool) throw rpcError(-32602, "Unsupported tool", { name: name || null });
      const result = await callTool(name, args, deps);
      if (result && result.ok === false) {
        return {
          content: [{ type: "text", text: typeof result.error === "string" ? result.error : JSON.stringify(result.error) }],
          isError: true,
          structuredContent: result,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
    }
    throw rpcError(-32601, "Method not found", { method });
  }

  return { handle, tools: installedTools, resources: resourceTemplates() };
}

async function callTool(name, args, deps) {
  switch (name) {
    case "design/list": return designList(deps, args);
    case "design/show": return designShow(deps, args);
    case "design/install": return designInstall(deps, args);
    case "design/resolved": return designResolved(deps);
    case "prototype/list": return prototypeList(deps, args);
    case "prototype/show": return prototypeShow(deps, args);
    case "prd/list": return prdList(deps);
    case "prd/show": return prdShow(deps, args);
    case "template/list": return templateList(deps, args);
    case "plugin/list": return pluginList(deps, args);
    case "skill/browse": return skillBrowse(deps, args);
    default:
      return { ok: false, error: `unsupported tool: ${name}` };
  }
}

async function readResource(deps, uri) {
  if (typeof uri !== "string") throw rpcError(-32602, "Unsupported resource URI", { uri: uri || null });

  if (uri === "design://resolved") {
    const result = designResolved(deps);
    return { uri, mimeType: "application/json", text: JSON.stringify(result) };
  }
  const systemsMatch = /^design:\/\/systems\/([^/]+)$/.exec(uri);
  if (systemsMatch) {
    const id = decodeURIComponent(systemsMatch[1]);
    const sys = deps.designLockfile.getSystem(deps.cwd, id);
    if (!sys) throw rpcError(-32602, "Unknown design system", { id });
    const designPath = path.join(deps.cwd, ".agent", "design-systems", id, "DESIGN.md");
    const text = readSafe(designPath);
    if (text === null) throw rpcError(-32602, "Design system missing DESIGN.md", { id });
    return { uri, mimeType: "text/markdown", text };
  }
  const prototypeMatch = /^prototype:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (prototypeMatch) {
    const taskId = decodeURIComponent(prototypeMatch[1]);
    const dir = path.resolve(deps.cwd, ".agent", "prototypes", taskId);
    const target = resolveInside(dir, prototypeMatch[2]);
    if (!target || !isFile(target)) throw rpcError(-32602, "Prototype file not found", { uri });
    return { uri, mimeType: "text/plain", text: readSafe(target) };
  }
  const prdMatch = /^prd:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (prdMatch) {
    const prdId = decodeURIComponent(prdMatch[1]);
    const dir = path.resolve(deps.cwd, ".agent", "prd", prdId);
    const target = resolveInside(dir, prdMatch[2]);
    if (!target || !isFile(target)) throw rpcError(-32602, "PRD file not found", { uri });
    return { uri, mimeType: "text/markdown", text: readSafe(target) };
  }
  throw rpcError(-32602, "Unsupported resource URI", { uri, allowed: ["design://resolved", "design://systems/{id}", "prototype://{taskId}/{path}", "prd://{prdId}/{file}"] });
}

// ─── stdio loop ──────────────────────────────────────────────────────────────

async function startServer(deps) {
  const handler = createHandler(deps).handle;
  // stdout is the MCP protocol channel — diagnostics go to stderr only.
  process.stderr.write(`[cortex-agent mcp] serving ${deps.cwd} (stdio, ${toolDefinitions().length} tools)\n`);
  for await (const request of jsonrpc.readFrames(process.stdin)) {
    try {
      const result = await handler(request);
      if (request.id === undefined || request.id === null || result === null) continue;
      jsonrpc.sendResult(process.stdout, request.id, result);
    } catch (error) {
      const rpc = (error && error.rpc) || { code: -32603, message: "Internal error", data: { reason: "internal_error" } };
      if (request && request.id !== undefined && request.id !== null) {
        jsonrpc.sendError(process.stdout, request.id, rpc.code, rpc.message, rpc.data);
      }
    }
  }
}

// ─── default deps ────────────────────────────────────────────────────────────

function defaultDeps(overrides) {
  const catalog = require("../catalog/index");
  const designResolve = require("../design/resolve");
  const designLockfile = require("../design/lockfile");
  const catalogLockfile = require("../catalog/lockfile");
  const skillBrowse = require("../commands/skill-browse").skillBrowse;
  return Object.assign(
    {
      cwd: process.env.CORTEX_AGENT_PROJECT_ROOT || process.cwd(),
      templateDir: path.resolve(__dirname, "..", "..", "templates"),
      catalog,
      designResolve,
      designLockfile,
      catalogLockfile,
      skillBrowse,
      installSystem: defaultInstallSystem,
    },
    overrides || {},
  );
}

module.exports = {
  SERVER_INFO,
  PROTOCOLS,
  toolDefinitions,
  resourceTemplates,
  createHandler,
  startServer,
  defaultDeps,
  defaultInstallSystem,
  // tool impls (exported for direct unit tests)
  designList,
  designShow,
  designInstall,
  designResolved,
  prototypeList,
  prototypeShow,
  prdList,
  prdShow,
  templateList,
  pluginList,
  skillBrowse,
  // helpers
  parseFrontmatter,
  resolveInside,
};
