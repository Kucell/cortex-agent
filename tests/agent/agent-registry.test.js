"use strict";

// ─── Agent Registry Tests (M-002 MS-003) ──────────────────────────────────────
//
// Coverage: lib/agents/registry.js — file IO + validation + filter.
// Schema: templates/_base/.agent/agents/agent.schema.json (M-001 publish).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  VALID_ROLES,
  VALID_STATUSES,
  VALID_ADAPTER_TYPES,
  agentsDir,
  agentFilePath,
  readAgent,
  writeAgent,
  deleteAgent,
  listAgentIds,
  listAgents,
  findAgents,
  validateEntry,
  validateRole,
  validateStatus,
  validateAdapterType,
} = require("../../lib/agents/registry");

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m002-ms003-reg-"));
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function makeEntry(overrides = {}) {
  return {
    schema_version: 1,
    agent_id: "Worker-A-test",
    role: "implementer",
    model: "MiniMax-M3",
    started_at: "2026-08-03T10:00:00.000Z",
    last_heartbeat: "2026-08-03T11:00:00.000Z",
    status: "running",
    capabilities: ["schema_design", "json_schema"],
    external: null,
    ...overrides,
  };
}

test("agent-registry: agentsDir returns .agent/agents", () => {
  assert.equal(agentsDir("/tmp/proj"), path.join("/tmp/proj", ".agent", "agents"));
});

test("agent-registry: agentFilePath requires agent_id", () => {
  assert.throws(
    () => agentFilePath("/tmp", ""),
    (err) => err.code === "ERR_AGENT_ID_REQUIRED",
  );
});

test("agent-registry: writeAgent + readAgent round-trip", () => {
  const root = mkProject();
  try {
    const entry = makeEntry();
    const file = writeAgent(root, entry);
    assert.ok(fs.existsSync(file));
    const back = readAgent(root, "Worker-A-test");
    assert.deepEqual(back, entry);
  } finally { rmProject(root); }
});

test("agent-registry: writeAgent creates .agent/agents dir if missing", () => {
  const root = mkProject();
  try {
    const dir = agentsDir(root);
    assert.equal(fs.existsSync(dir), false);
    writeAgent(root, makeEntry());
    assert.equal(fs.existsSync(dir), true);
  } finally { rmProject(root); }
});

test("agent-registry: writeAgent validates role", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => writeAgent(root, makeEntry({ role: "wizard" })),
      (err) => err.code === "ERR_INVALID_ROLE",
    );
  } finally { rmProject(root); }
});

test("agent-registry: writeAgent validates status", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => writeAgent(root, makeEntry({ status: "dancing" })),
      (err) => err.code === "ERR_INVALID_STATUS",
    );
  } finally { rmProject(root); }
});

test("agent-registry: writeAgent validates external.adapter_type", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => writeAgent(root, makeEntry({ external: { adapter_type: "bogus", config_ref: "x", credential_ref: "y" } })),
      (err) => err.code === "ERR_INVALID_ADAPTER_TYPE",
    );
  } finally { rmProject(root); }
});

test("agent-registry: writeAgent validates schema_version", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => writeAgent(root, makeEntry({ schema_version: 99 })),
      (err) => err.code === "ERR_INVALID_SCHEMA_VERSION",
    );
  } finally { rmProject(root); }
});

test("agent-registry: writeAgent requires model", () => {
  const root = mkProject();
  try {
    const e = makeEntry();
    delete e.model;
    assert.throws(
      () => writeAgent(root, e),
      (err) => err.code === "ERR_AGENT_MODEL_REQUIRED",
    );
  } finally { rmProject(root); }
});

test("agent-registry: writeAgent requires started_at", () => {
  const root = mkProject();
  try {
    const e = makeEntry();
    delete e.started_at;
    assert.throws(
      () => writeAgent(root, e),
      (err) => err.code === "ERR_AGENT_STARTED_AT_REQUIRED",
    );
  } finally { rmProject(root); }
});

test("agent-registry: readAgent returns null for missing file", () => {
  const root = mkProject();
  try {
    assert.equal(readAgent(root, "Ghost"), null);
  } finally { rmProject(root); }
});

test("agent-registry: readAgent throws on malformed JSON", () => {
  const root = mkProject();
  try {
    const dir = agentsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "{ not json");
    assert.throws(
      () => readAgent(root, "bad"),
      (err) => err.code === "ERR_AGENT_PARSE",
    );
  } finally { rmProject(root); }
});

test("agent-registry: deleteAgent returns true on hit, false on miss", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry());
    assert.equal(deleteAgent(root, "Worker-A-test"), true);
    assert.equal(deleteAgent(root, "Worker-A-test"), false);
  } finally { rmProject(root); }
});

test("agent-registry: listAgentIds returns sorted ids", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry({ agent_id: "Z-bee" }));
    writeAgent(root, makeEntry({ agent_id: "A-bee" }));
    assert.deepEqual(listAgentIds(root), ["A-bee", "Z-bee"]);
  } finally { rmProject(root); }
});

test("agent-registry: listAgentIds on empty/missing dir returns []", () => {
  const root = mkProject();
  try {
    assert.deepEqual(listAgentIds(root), []);
  } finally { rmProject(root); }
});

test("agent-registry: listAgents returns all entries", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry({ agent_id: "a-1" }));
    writeAgent(root, makeEntry({ agent_id: "a-2" }));
    const all = listAgents(root);
    assert.equal(all.length, 2);
  } finally { rmProject(root); }
});

test("agent-registry: findAgents filters by role", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry({ agent_id: "i1", role: "implementer" }));
    writeAgent(root, makeEntry({ agent_id: "r1", role: "reviewer" }));
    const impls = findAgents(root, { role: "implementer" });
    assert.equal(impls.length, 1);
    assert.equal(impls[0].agent_id, "i1");
  } finally { rmProject(root); }
});

test("agent-registry: findAgents filters by capability", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry({ agent_id: "s1", capabilities: ["schema_design", "json_schema"] }));
    writeAgent(root, makeEntry({ agent_id: "t1", capabilities: ["testing"] }));
    const filtered = findAgents(root, { capability: "schema_design" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].agent_id, "s1");
  } finally { rmProject(root); }
});

test("agent-registry: findAgents filters by status", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry({ agent_id: "r1", status: "running" }));
    writeAgent(root, makeEntry({ agent_id: "c1", status: "completed" }));
    const filtered = findAgents(root, { status: "completed" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].agent_id, "c1");
  } finally { rmProject(root); }
});

test("agent-registry: findAgents filters by adapter_type", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry({
      agent_id: "ext-1",
      external: { adapter_type: "claude-code", config_ref: "c", credential_ref: "k" },
    }));
    writeAgent(root, makeEntry({ agent_id: "local-1", external: null }));
    const filtered = findAgents(root, { adapterType: "claude-code" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].agent_id, "ext-1");
  } finally { rmProject(root); }
});

test("agent-registry: findAgents filters by query substring", () => {
  const root = mkProject();
  try {
    writeAgent(root, makeEntry({ agent_id: "Worker-A-M001" }));
    writeAgent(root, makeEntry({ agent_id: "Worker-B-M002" }));
    const filtered = findAgents(root, { query: "M001" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].agent_id, "Worker-A-M001");
  } finally { rmProject(root); }
});

test("agent-registry: VALID_ROLES contains 9 entries per M-001 schema", () => {
  assert.equal(VALID_ROLES.length, 9);
  assert.ok(VALID_ROLES.includes("implementer"));
  assert.ok(VALID_ROLES.includes("external"));
});

test("agent-registry: VALID_STATUSES contains 7 entries per M-001 schema", () => {
  assert.equal(VALID_STATUSES.length, 7);
  assert.ok(VALID_STATUSES.includes("running"));
  assert.ok(VALID_STATUSES.includes("stale"));
});

test("agent-registry: VALID_ADAPTER_TYPES contains 6 entries (v1.11 includes pi)", () => {
  assert.equal(VALID_ADAPTER_TYPES.length, 6);
  assert.ok(VALID_ADAPTER_TYPES.includes("claude-code"));
  assert.ok(VALID_ADAPTER_TYPES.includes("codex"));
  assert.ok(VALID_ADAPTER_TYPES.includes("codey"));
  assert.ok(VALID_ADAPTER_TYPES.includes("pi"));
  assert.ok(VALID_ADAPTER_TYPES.includes("cortex"));
  assert.ok(VALID_ADAPTER_TYPES.includes("custom"));
});

test("agent-registry: validateRole/Status/AdapterType throw on bad input", () => {
  assert.throws(() => validateRole("wizard"), (err) => err.code === "ERR_INVALID_ROLE");
  assert.throws(() => validateStatus("dancing"), (err) => err.code === "ERR_INVALID_STATUS");
  assert.throws(() => validateAdapterType("bogus"), (err) => err.code === "ERR_INVALID_ADAPTER_TYPE");
  // Valid inputs should not throw
  validateRole("implementer");
  validateStatus("running");
  validateAdapterType("claude-code");
});
