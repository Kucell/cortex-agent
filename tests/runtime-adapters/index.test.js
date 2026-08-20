"use strict";

// tests/runtime-adapters/index.test.js — 26-agent runtime-adapter docs
// validation (P-004 MS-003). No agent-specific logic: validates the registry
// contract (files exist + frontmatter + schema enums + index consistency).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ADAPTERS_DIR = path.resolve(__dirname, "..", "..", ".agent", "references", "runtime-adapters");

const STATUS_ENUM = new Set(["shipped", "reference", "pending"]);
const PROTOCOL_ENUM = new Set(["stdio-mcp", "http", "native", "byok", "private"]);
const MCP_BRIDGE_ENUM = new Set(["P-002", "P-006", "null"]);
const REQUIRED_FIELDS = [
  "agent", "cli", "displayName", "status", "protocol", "homepage",
  "installCommand", "configPath", "mcpBridge", "capabilities", "limitations",
  "pilot", "last_verified",
];

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(ADAPTERS_DIR, "_index.json"), "utf8"));
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const body = match[1];
  const out = {};
  let currentKey = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const listItem = /^-\s+(.+)$/.exec(trimmed);
    if (listItem) {
      if (currentKey) {
        if (!Array.isArray(out[currentKey])) out[currentKey] = [];
        out[currentKey].push(listItem[1].trim());
      }
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    currentKey = line.slice(0, idx).trim();
    out[currentKey] = line.slice(idx + 1).trim();
  }
  return out;
}

function agentFiles() {
  return fs.readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md");
}

// ─── registry files exist ────────────────────────────────────────────────────

test("registry directory contains README, _schema and _index.json", () => {
  assert.equal(fs.existsSync(path.join(ADAPTERS_DIR, "README.md")), true);
  assert.equal(fs.existsSync(path.join(ADAPTERS_DIR, "_schema.md")), true);
  assert.equal(fs.existsSync(path.join(ADAPTERS_DIR, "_index.json")), true);
});

test("_index.json parses with the od-runtime-adapter/v1 schema", () => {
  const index = readIndex();
  assert.equal(index.schemaVersion, "od-runtime-adapter/v1");
  assert.ok(Array.isArray(index.agents));
});

// ─── 26 agents, files match index ────────────────────────────────────────────

test("_index.json lists exactly 26 agents", () => {
  const index = readIndex();
  assert.equal(index.agents.length, 26);
});

test("every index agent id has a matching <id>.md file (and no extras)", () => {
  const index = readIndex();
  const ids = index.agents.map((a) => a.id);
  assert.equal(new Set(ids).size, 26, "agent ids must be unique");
  for (const id of ids) {
    assert.equal(fs.existsSync(path.join(ADAPTERS_DIR, `${id}.md`)), true, `missing ${id}.md`);
  }
  const files = agentFiles().map((f) => f.replace(/\.md$/, ""));
  for (const file of files) {
    assert.ok(ids.includes(file), `orphan doc ${file}.md has no index entry`);
  }
});

// ─── frontmatter schema ──────────────────────────────────────────────────────

test("every agent doc has parseable frontmatter with all required fields", () => {
  const files = agentFiles();
  assert.equal(files.length, 26);
  for (const file of files) {
    const meta = parseFrontmatter(fs.readFileSync(path.join(ADAPTERS_DIR, file), "utf8"));
    assert.ok(meta, `${file} frontmatter missing`);
    for (const field of REQUIRED_FIELDS) {
      assert.ok(meta[field] !== undefined, `${file} missing frontmatter field "${field}"`);
    }
  }
});

test("status / protocol / mcpBridge values stay within their enums", () => {
  for (const file of agentFiles()) {
    const meta = parseFrontmatter(fs.readFileSync(path.join(ADAPTERS_DIR, file), "utf8"));
    assert.ok(STATUS_ENUM.has(meta.status), `${file} bad status ${meta.status}`);
    assert.ok(PROTOCOL_ENUM.has(meta.protocol), `${file} bad protocol ${meta.protocol}`);
    assert.ok(MCP_BRIDGE_ENUM.has(meta.mcpBridge), `${file} bad mcpBridge ${meta.mcpBridge}`);
    assert.ok(Array.isArray(meta.capabilities) && meta.capabilities.length > 0, `${file} capabilities`);
    assert.ok(Array.isArray(meta.limitations) && meta.limitations.length > 0, `${file} limitations`);
    assert.ok(meta.pilot === "null" || meta.pilot.length > 0, `${file} pilot`);
  }
});

test("last_verified matches YYYY-MM-DD", () => {
  for (const file of agentFiles()) {
    const meta = parseFrontmatter(fs.readFileSync(path.join(ADAPTERS_DIR, file), "utf8"));
    assert.match(meta.last_verified, /^\d{4}-\d{2}-\d{2}$/, `${file} last_verified`);
  }
});

test("every agent doc has the 7 template sections in order", () => {
  for (const file of agentFiles()) {
    const text = fs.readFileSync(path.join(ADAPTERS_DIR, file), "utf8");
    for (let i = 1; i <= 7; i++) {
      assert.ok(new RegExp(`^## ${i}\\.`, "m").test(text), `${file} missing section ${i}`);
    }
  }
});

// ─── index ↔ frontmatter consistency ────────────────────────────────────────

test("_index.json fields agree with each agent doc's frontmatter", () => {
  const index = readIndex();
  for (const entry of index.agents) {
    const meta = parseFrontmatter(fs.readFileSync(path.join(ADAPTERS_DIR, `${entry.id}.md`), "utf8"));
    assert.equal(meta.agent, entry.id, `${entry.id} id mismatch`);
    assert.equal(meta.cli, entry.cli, `${entry.id} cli mismatch`);
    assert.equal(meta.protocol, entry.protocol, `${entry.id} protocol mismatch`);
    assert.equal(meta.status, entry.status, `${entry.id} status mismatch`);
    assert.equal(meta.pilot === "null" ? null : meta.pilot, entry.pilot, `${entry.id} pilot mismatch`);
  }
});

// ─── cross-references (P-002 / P-006) ────────────────────────────────────────

test("dsh.md references P-006 / .agent/projects/dsh-* (first-class native)", () => {
  const text = fs.readFileSync(path.join(ADAPTERS_DIR, "dsh.md"), "utf8");
  assert.match(text, /P-006/);
  assert.match(text, /\.agent\/projects\/dsh-/);
  assert.match(text, /native/);
});

test("claude / codex / cursor / copilot docs reference P-002", () => {
  for (const id of ["claude", "codex", "cursor", "copilot"]) {
    const text = fs.readFileSync(path.join(ADAPTERS_DIR, `${id}.md`), "utf8");
    assert.match(text, /P-002/, `${id}.md must reference P-002`);
  }
});

test("README matrix covers all 26 agents", () => {
  const index = readIndex();
  const readme = fs.readFileSync(path.join(ADAPTERS_DIR, "README.md"), "utf8");
  for (const entry of index.agents) {
    assert.ok(readme.includes(`./${entry.id}.md`), `README missing ${entry.id}`);
    assert.ok(readme.includes(`\`${entry.cli}\``), `README missing cli \`${entry.cli}\``);
  }
});
