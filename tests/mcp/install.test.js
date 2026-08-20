"use strict";

// tests/mcp/install.test.js — per-agent MCP config writer tests (P-002 MS-003).
// Uses tmp home dirs (real fs) plus one in-memory `io` mock.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  install,
  uninstall,
  listInstalled,
  listAgents,
  validateToken,
  generateToken,
  serverEntry,
  TOKEN_RE,
} = require("../../lib/mcp/install");

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-install-"));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("install claude writes mcpServers.cortex-agent with token env", () => {
  const home = makeHome();
  try {
    const token = "ab".repeat(32);
    const result = install("claude", { home, token, cwd: "/proj" });
    assert.equal(result.ok, true);
    assert.equal(result.path, path.join(home, ".claude", "mcp_servers.json"));
    const cfg = readJson(result.path);
    assert.equal(cfg.mcpServers["cortex-agent"].command, "cortex-agent");
    assert.deepEqual(cfg.mcpServers["cortex-agent"].args, ["mcp", "serve"]);
    assert.equal(cfg.mcpServers["cortex-agent"].env.CORTEX_AGENT_PROJECT_ROOT, "/proj");
    assert.equal(cfg.mcpServers["cortex-agent"].env.CORTEX_AGENT_MCP_TOKEN, token);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("install preserves existing mcpServers entries", () => {
  const home = makeHome();
  try {
    const cfgPath = path.join(home, ".claude", "mcp_servers.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    install("claude", { home, token: "ab".repeat(32) });
    const cfg = readJson(cfgPath);
    assert.ok(cfg.mcpServers.other, "existing server preserved");
    assert.ok(cfg.mcpServers["cortex-agent"], "cortex-agent added");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("install codex appends a TOML [mcp_servers.cortex-agent] section", () => {
  const home = makeHome();
  try {
    const result = install("codex", { home, token: "ab".repeat(32) });
    assert.equal(result.format, "toml");
    const toml = fs.readFileSync(result.path, "utf8");
    assert.match(toml, /\[mcp_servers\.cortex-agent\]/);
    assert.match(toml, /command = "cortex-agent"/);
    assert.match(toml, /CORTEX_AGENT_MCP_TOKEN = "ab/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("install codex is idempotent — no duplicated TOML section", () => {
  const home = makeHome();
  try {
    install("codex", { home, token: "ab".repeat(32) });
    install("codex", { home, token: "ab".repeat(32) });
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.equal((toml.match(/\[mcp_servers\.cortex-agent\]/g) || []).length, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("dry-run returns the snippet without writing any file", () => {
  const home = makeHome();
  try {
    const result = install("cursor", { home, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.wrote, false);
    assert.equal(result.snippet.command, "cortex-agent");
    assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("unknown agent id fails with UNKNOWN_AGENT", () => {
  const home = makeHome();
  try {
    const result = install("not-an-agent", { home });
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNKNOWN_AGENT");
    assert.match(result.message, /not-an-agent/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("agents without a known config path fail with UNKNOWN_CONFIG_PATH + warning", () => {
  const home = makeHome();
  try {
    const result = install("pi", { home, token: "ab".repeat(32) });
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNKNOWN_CONFIG_PATH");
    assert.match(result.warning, /pi/);
    // nothing written anywhere under home
    assert.equal(fs.readdirSync(home).length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("invalid token is rejected with INVALID_TOKEN", () => {
  assert.equal(validateToken("not-hex").code, "INVALID_TOKEN");
  assert.throws(() => install("claude", { token: "xyz" }), (err) => err.code === "INVALID_TOKEN");
  assert.equal(validateToken("ab".repeat(32)), null);
  assert.equal(validateToken(undefined), null);
});

test("auto-generated token is 64 lowercase hex chars", () => {
  const token = generateToken();
  assert.equal(token.length, 64);
  assert.match(token, TOKEN_RE);
  assert.equal(validateToken(token), null);
});

test("serverEntry includes project root and token in env", () => {
  const entry = serverEntry({ cwd: "/x/y", token: "ab".repeat(32) });
  assert.equal(entry.command, "cortex-agent");
  assert.deepEqual(entry.args, ["mcp", "serve"]);
  assert.equal(entry.env.CORTEX_AGENT_PROJECT_ROOT, "/x/y");
  assert.equal(entry.env.CORTEX_AGENT_MCP_TOKEN, "ab".repeat(32));
});

test("uninstall removes the cortex-agent entry and reports removed", () => {
  const home = makeHome();
  try {
    install("claude", { home, token: "ab".repeat(32) });
    const result = uninstall("claude", { home });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    const cfg = readJson(path.join(home, ".claude", "mcp_servers.json"));
    assert.equal(cfg.mcpServers["cortex-agent"], undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("uninstall reports removed:false when nothing is configured", () => {
  const home = makeHome();
  try {
    const result = uninstall("cursor", { home });
    assert.equal(result.ok, true);
    assert.equal(result.removed, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("listInstalled reports configured state across agents", () => {
  const home = makeHome();
  try {
    install("claude", { home, token: "ab".repeat(32) });
    const result = listInstalled({ home });
    assert.equal(result.ok, true);
    const claude = result.installed.find((i) => i.agent === "claude");
    const cursor = result.installed.find((i) => i.agent === "cursor");
    assert.equal(claude.configured, true);
    assert.equal(cursor.configured, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("in-memory io mock is honored (mock fs path)", () => {
  const files = new Map(); // path -> content
  const io = {
    existsSync: (p) => files.has(p),
    readFileSync: (p, enc) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); },
    writeFileSync: (p, content) => files.set(p, String(content)),
    mkdirSync: () => {},
    chmodSync: () => {},
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  };
  const home = "/fake/home";
  const result = install("cursor", { home, token: "ab".repeat(32), io });
  assert.equal(result.ok, true);
  const cfgPath = path.join(home, ".cursor", "mcp.json");
  assert.equal(io.existsSync(cfgPath), true);
  const cfg = JSON.parse(io.readFileSync(cfgPath, "utf8"));
  assert.ok(cfg.mcpServers["cortex-agent"]);
});

test("listAgents covers the P-002 install matrix", () => {
  const agents = listAgents();
  for (const expected of ["claude", "claude-desktop", "codex", "cursor", "copilot", "dsh", "opencode", "cline", "openclaw"]) {
    assert.ok(agents.includes(expected), `missing ${expected}`);
  }
});
