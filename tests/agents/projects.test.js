"use strict";

// Coverage for P-002 project scope in lib/agents/registry.js: v1 additive
// optional fields (projects / recall), projects filter, set/list/members
// operations and fail-closed active-agent selection.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const registry = require("../../lib/agents/registry.js");

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-projects-test-"));
  fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
  return root;
}

function validEntry(overrides = {}) {
  return {
    schema_version: 1,
    agent_id: "agent-001",
    role: "implementer",
    model: "test-model",
    started_at: "2026-08-11T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

describe("agents/projects — P-002 v1 additive fields", () => {
  test("accepts valid projects and recall", () => {
    assert.doesNotThrow(() => registry.validateEntry(validEntry({
      projects: ["hai-inference", "billing-platform"],
      recall: "enabled",
    })));
  });

  test("rejects invalid project id (kebab-case rule)", () => {
    assert.throws(() => registry.validateProjects(["bad_id"]), { code: "ERR_AGENT_PROJECTS_INVALID" });
    assert.throws(() => registry.validateEntry(validEntry({ projects: ["UPPER"] })), { code: "ERR_AGENT_PROJECTS_INVALID" });
  });

  test("rejects duplicates and over-limit projects", () => {
    assert.throws(() => registry.validateProjects(["a", "a"]), { code: "ERR_AGENT_PROJECTS_INVALID" });
    assert.throws(() => registry.validateEntry(validEntry({ projects: ["a", "b", "a"] })), { code: "ERR_AGENT_PROJECTS_INVALID" });
    const many = Array.from({ length: 33 }, (_, i) => `p${i}`);
    assert.throws(() => registry.validateProjects(many), { code: "ERR_AGENT_PROJECTS_INVALID" });
  });

  test("rejects invalid recall enum", () => {
    assert.throws(() => registry.validateRecall("sometimes"), { code: "ERR_AGENT_RECALL_INVALID" });
    assert.throws(() => registry.validateEntry(validEntry({ recall: "on" })), { code: "ERR_AGENT_RECALL_INVALID" });
  });

  test("absent fields default to [] / disabled", () => {
    const entry = validEntry();
    assert.deepEqual(registry.entryProjects(entry), []);
    assert.equal(registry.entryRecall(entry), "disabled");
    assert.equal(registry.entryRecall(validEntry({ recall: "enabled" })), "enabled");
  });

  test("legacy v1 entry round-trips through write/read", () => {
    const root = makeProject();
    const entry = validEntry();
    registry.writeAgent(root, entry);
    assert.deepEqual(registry.readAgent(root, "agent-001"), entry);
  });
});

describe("agents/projects — operations", () => {
  test("findAgents filters by project", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry({ agent_id: "a1", projects: ["p1"] }));
    registry.writeAgent(root, validEntry({ agent_id: "a2", projects: ["p2"] }));
    const found = registry.findAgents(root, { project: "p1" });
    assert.deepEqual(found.map((e) => e.agent_id), ["a1"]);
  });

  test("setAgentProjects adds and removes atomically", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry({ agent_id: "a1" }));
    registry.setAgentProjects(root, "a1", "hai-inference", { add: true });
    assert.deepEqual(registry.agentProjects(root, "a1"), ["hai-inference"]);
    registry.setAgentProjects(root, "a1", "billing-platform");
    assert.deepEqual(registry.agentProjects(root, "a1"), ["hai-inference", "billing-platform"]);
    registry.setAgentProjects(root, "a1", "hai-inference", { remove: true });
    assert.deepEqual(registry.agentProjects(root, "a1"), ["billing-platform"]);
    assert.throws(() => registry.setAgentProjects(root, "a1", "missing", { remove: true }), { code: "ERR_AGENT_PROJECT_NOT_MEMBER" });
    assert.throws(() => registry.setAgentProjects(root, "ghost", "p1"), { code: "ERR_AGENT_NOT_FOUND" });
  });

  test("projectMembers lists agents in a project", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry({ agent_id: "a1", projects: ["shared"] }));
    registry.writeAgent(root, validEntry({ agent_id: "a2", projects: ["shared"] }));
    registry.writeAgent(root, validEntry({ agent_id: "a3", projects: ["other"] }));
    assert.deepEqual(registry.projectMembers(root, "shared").map((e) => e.agent_id).sort(), ["a1", "a2"]);
  });

  test("resolveActiveAgent fails closed without --agent", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry({ agent_id: "a1" }));
    assert.equal(registry.resolveActiveAgent(root, "a1").agent_id, "a1");
    assert.throws(() => registry.resolveActiveAgent(root, null), { code: "ERR_AGENT_SELECTION_REQUIRED" });
    assert.equal(registry.resolveActiveAgent(root, null, { allowMissing: true }), null);
    assert.throws(() => registry.resolveActiveAgent(root, "ghost"), { code: "ERR_AGENT_NOT_FOUND" });
  });

  test("agentProjects returns null for missing agent", () => {
    const root = makeProject();
    assert.equal(registry.agentProjects(root, "ghost"), null);
  });
});
