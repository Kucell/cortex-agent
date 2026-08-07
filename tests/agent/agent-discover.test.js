"use strict";

// ─── Agent Discover Tests (M-002 MS-003) ──────────────────────────────────────

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeAgent } = require("../../lib/agents/registry");
const { discover, _tokenize, _scoreEntry, _recencyBonus } = require("../../lib/agents/discover");

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m002-ms003-disc-"));
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seed(root, agent_id, overrides = {}) {
  writeAgent(root, {
    schema_version: 1,
    agent_id,
    role: overrides.role || "implementer",
    model: overrides.model || "MiniMax-M3",
    started_at: overrides.startedAt || "2026-08-03T10:00:00.000Z",
    last_heartbeat: overrides.lastHeartbeat || "2026-08-03T11:00:00.000Z",
    status: overrides.status || "running",
    capabilities: overrides.capabilities || ["schema_design"],
    external: overrides.external || null,
  });
}

test("agent-discover: tokenize splits on non-alphanumeric and lowercases", () => {
  assert.deepEqual(_tokenize("Worker-A M-001"), ["worker", "a", "m", "001"]);
  assert.deepEqual(_tokenize(""), []);
  assert.deepEqual(_tokenize(null), []);
});

test("agent-discover: returns empty when no agents exist", () => {
  const root = mkProject();
  try {
    const result = discover({ projectRoot: root });
    assert.equal(result.scanned, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.returned, 0);
    assert.deepEqual(result.agents, []);
  } finally { rmProject(root); }
});

test("agent-discover: filter by capability", () => {
  const root = mkProject();
  try {
    seed(root, "schema-agent", { capabilities: ["schema_design", "json_schema"] });
    seed(root, "test-agent", { capabilities: ["testing"] });
    const result = discover({ projectRoot: root, capability: "schema_design" });
    assert.equal(result.returned, 1);
    assert.equal(result.agents[0].agent_id, "schema-agent");
  } finally { rmProject(root); }
});

test("agent-discover: filter by role", () => {
  const root = mkProject();
  try {
    seed(root, "impl-1", { role: "implementer" });
    seed(root, "rev-1", { role: "reviewer" });
    const result = discover({ projectRoot: root, role: "reviewer" });
    assert.equal(result.returned, 1);
    assert.equal(result.agents[0].role, "reviewer");
  } finally { rmProject(root); }
});

test("agent-discover: filter by status", () => {
  const root = mkProject();
  try {
    seed(root, "running-1", { status: "running" });
    seed(root, "done-1", { status: "completed" });
    const result = discover({ projectRoot: root, status: "completed" });
    assert.equal(result.returned, 1);
    assert.equal(result.agents[0].status, "completed");
  } finally { rmProject(root); }
});

test("agent-discover: filter by adapter_type", () => {
  const root = mkProject();
  try {
    seed(root, "claude-1", {
      external: { adapter_type: "claude-code", config_ref: "c", credential_ref: "k" },
    });
    seed(root, "local-1");
    const result = discover({ projectRoot: root, adapterType: "claude-code" });
    assert.equal(result.returned, 1);
    assert.equal(result.agents[0].agent_id, "claude-1");
    assert.equal(result.agents[0].external.adapter_type, "claude-code");
  } finally { rmProject(root); }
});

test("agent-discover: query substring match across multiple fields", () => {
  const root = mkProject();
  try {
    seed(root, "Worker-A-M001", { capabilities: ["schema_design"] });
    seed(root, "Worker-B-M002", { capabilities: ["testing"] });
    const result = discover({ projectRoot: root, query: "M001" });
    assert.equal(result.returned, 1);
    assert.equal(result.agents[0].agent_id, "Worker-A-M001");
  } finally { rmProject(root); }
});

test("agent-discover: limit clamps top-K", () => {
  const root = mkProject();
  try {
    for (let i = 0; i < 5; i++) seed(root, `agent-${i}`);
    const r1 = discover({ projectRoot: root, limit: 100 });
    assert.equal(r1.returned, 5);
    const r2 = discover({ projectRoot: root, limit: 2 });
    assert.equal(r2.returned, 2);
  } finally { rmProject(root); }
});

test("agent-discover: scoreEntry returns 0 for no query/no capability match", () => {
  const entry = { agent_id: "x", role: "implementer", model: "y", capabilities: [] };
  assert.equal(_scoreEntry(entry, [], new Set()), 0);
});

test("agent-discover: scoreEntry rewards capability match", () => {
  const entry = {
    agent_id: "x",
    role: "implementer",
    model: "y",
    capabilities: ["schema_design"],
    last_heartbeat: "2026-08-03T11:00:00.000Z",
  };
  const score = _scoreEntry(entry, ["schema_design"], new Set());
  assert.ok(score > 0);
});

test("agent-discover: recency bonus is 0 for stale (>30d) entries", () => {
  const stale = {
    last_heartbeat: "2025-01-01T00:00:00.000Z",
  };
  assert.equal(_recencyBonus(stale, Date.parse("2026-08-03T00:00:00.000Z")), 0);
});

test("agent-discover: recency bonus is positive for recent entries", () => {
  const recent = {
    last_heartbeat: new Date().toISOString(),
  };
  assert.ok(_recencyBonus(recent, Date.now()) > 0);
});

test("agent-discover: throws on missing projectRoot", () => {
  assert.throws(
    () => discover({}),
    (err) => err.code === "ERR_PROJECT_ROOT_REQUIRED",
  );
});

test("agent-discover: stable sort — same score, alphabetical by agent_id", () => {
  const root = mkProject();
  try {
    seed(root, "Z-agent");
    seed(root, "A-agent");
    seed(root, "M-agent");
    const result = discover({ projectRoot: root });
    assert.equal(result.returned, 3);
    assert.equal(result.agents[0].agent_id, "A-agent");
    assert.equal(result.agents[1].agent_id, "M-agent");
    assert.equal(result.agents[2].agent_id, "Z-agent");
  } finally { rmProject(root); }
});

test("agent-discover: combined filter (capability + role + status)", () => {
  const root = mkProject();
  try {
    seed(root, "match", {
      role: "implementer",
      status: "running",
      capabilities: ["schema_design", "code_review"],
    });
    seed(root, "no-role-match", { role: "reviewer", status: "running", capabilities: ["schema_design"] });
    seed(root, "no-status-match", { role: "implementer", status: "completed", capabilities: ["schema_design"] });
    seed(root, "no-cap-match", { role: "implementer", status: "running", capabilities: ["testing"] });
    const result = discover({
      projectRoot: root,
      capability: "schema_design",
      role: "implementer",
      status: "running",
    });
    assert.equal(result.returned, 1);
    assert.equal(result.agents[0].agent_id, "match");
  } finally { rmProject(root); }
});
