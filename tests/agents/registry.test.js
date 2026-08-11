"use strict";

// Coverage for lib/agents/registry.js — agent entry validation + file IO.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const registry = require("../../lib/agents/registry.js");

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agents-test-"));
}

function validEntry(overrides = {}) {
  return {
    schema_version: 1,
    agent_id: "agent-001",
    role: "implementer",
    model: "test-model",
    started_at: "2026-08-11T00:00:00.000Z",
    status: "running",
    capabilities: ["coding"],
    ...overrides,
  };
}

describe("agents/registry — validation", () => {
  test("validateEntry accepts a complete valid entry", () => {
    assert.doesNotThrow(() => registry.validateEntry(validEntry()));
  });

  test("validateEntry rejects non-object entry", () => {
    assert.throws(() => registry.validateEntry(null), { code: "ERR_AGENT_ENTRY_INVALID" });
  });

  test("validateEntry rejects wrong schema_version", () => {
    assert.throws(() => registry.validateEntry(validEntry({ schema_version: 2 })), {
      code: "ERR_INVALID_SCHEMA_VERSION",
    });
  });

  test("validateEntry rejects missing agent_id", () => {
    assert.throws(() => registry.validateEntry(validEntry({ agent_id: "" })), {
      code: "ERR_AGENT_ID_REQUIRED",
    });
  });

  test("validateRole rejects unknown role with error code", () => {
    assert.throws(() => registry.validateRole("overlord"), { code: "ERR_INVALID_ROLE" });
  });

  test("validateRole accepts every declared VALID_ROLES member", () => {
    for (const role of registry.VALID_ROLES) {
      assert.doesNotThrow(() => registry.validateRole(role));
    }
  });

  test("validateStatus rejects unknown status", () => {
    assert.throws(() => registry.validateStatus("frozen"), { code: "ERR_INVALID_STATUS" });
  });

  test("validateAdapterType rejects unknown adapter type", () => {
    assert.throws(() => registry.validateAdapterType("vim-mode"), {
      code: "ERR_INVALID_ADAPTER_TYPE",
    });
  });

  test("validateEntry validates external.adapter_type when present", () => {
    const bad = validEntry({ external: { adapter_type: "bogus" } });
    assert.throws(() => registry.validateEntry(bad), { code: "ERR_INVALID_ADAPTER_TYPE" });
    const good = validEntry({ external: { adapter_type: "claude-code" } });
    assert.doesNotThrow(() => registry.validateEntry(good));
  });

  test("validateEntry rejects non-array capabilities", () => {
    assert.throws(() => registry.validateEntry(validEntry({ capabilities: "coding" })), {
      code: "ERR_AGENT_CAPABILITIES_INVALID",
    });
  });
});

describe("agents/registry — file IO", () => {
  test("writeAgent then readAgent round-trips the entry", () => {
    const root = makeProject();
    const entry = validEntry();
    const file = registry.writeAgent(root, entry);
    assert.ok(file.endsWith("agent-001.json"));
    assert.deepEqual(registry.readAgent(root, "agent-001"), entry);
  });

  test("readAgent returns null for a missing agent", () => {
    const root = makeProject();
    assert.equal(registry.readAgent(root, "ghost"), null);
  });

  test("agentFilePath requires a string agent_id", () => {
    assert.throws(() => registry.agentFilePath("/tmp/x", null), { code: "ERR_AGENT_ID_REQUIRED" });
  });

  test("readAgent raises ERR_AGENT_PARSE for a corrupt file", () => {
    const root = makeProject();
    const dir = registry.agentsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
    assert.throws(() => registry.readAgent(root, "broken"), { code: "ERR_AGENT_PARSE" });
  });

  test("deleteAgent removes the file and reports true; second call returns false", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry());
    assert.equal(registry.deleteAgent(root, "agent-001"), true);
    assert.equal(registry.deleteAgent(root, "agent-001"), false);
  });

  test("listAgentIds ignores non-json and tmp files", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry());
    registry.writeAgent(root, validEntry({ agent_id: "agent-002" }));
    const dir = registry.agentsDir(root);
    fs.writeFileSync(path.join(dir, "agent.schema.json"), "{}"); // not an entry
    fs.writeFileSync(path.join(dir, "stale.json.tmp-1"), "{}");
    const ids = registry.listAgentIds(root);
    // agent.schema.json is listed because it ends with .json; listAgents skips it on parse.
    assert.ok(ids.includes("agent-001"));
    assert.ok(ids.includes("agent-002"));
    assert.ok(!ids.some((id) => id.includes("tmp")));
  });

  test("listAgents skips invalid entries without throwing", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry());
    const dir = registry.agentsDir(root);
    fs.writeFileSync(path.join(dir, "schema-sample.json"), JSON.stringify({ schema_version: 99 }));
    const agents = registry.listAgents(root);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].agent_id, "agent-001");
  });

  test("writeAgent is atomic: no stray .tmp files remain", () => {
    const root = makeProject();
    registry.writeAgent(root, validEntry());
    const dir = registry.agentsDir(root);
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
  });
});

describe("agents/registry — findAgents filters", () => {
  function seed(root) {
    registry.writeAgent(root, validEntry({ agent_id: "impl-a", role: "implementer", status: "running", capabilities: ["coding"] }));
    registry.writeAgent(root, validEntry({ agent_id: "rev-b", role: "reviewer", status: "completed", capabilities: ["review", "coding"] }));
    registry.writeAgent(root, validEntry({ agent_id: "ext-c", role: "external", status: "running", external: { adapter_type: "codex" }, capabilities: ["dispatch"] }));
  }

  test("filters by role", () => {
    const root = makeProject();
    seed(root);
    const res = registry.findAgents(root, { role: "reviewer" });
    assert.deepEqual(res.map((e) => e.agent_id), ["rev-b"]);
  });

  test("filters by status", () => {
    const root = makeProject();
    seed(root);
    const res = registry.findAgents(root, { status: "running" });
    assert.equal(res.length, 2);
  });

  test("filters by capability", () => {
    const root = makeProject();
    seed(root);
    const res = registry.findAgents(root, { capability: "review" });
    assert.deepEqual(res.map((e) => e.agent_id), ["rev-b"]);
  });

  test("filters by adapterType", () => {
    const root = makeProject();
    seed(root);
    const res = registry.findAgents(root, { adapterType: "codex" });
    assert.deepEqual(res.map((e) => e.agent_id), ["ext-c"]);
  });

  test("query substring matches across id/role/model/capabilities", () => {
    const root = makeProject();
    seed(root);
    const res = registry.findAgents(root, { query: "coding" });
    assert.equal(res.length, 2);
  });

  test("no filter returns everything", () => {
    const root = makeProject();
    seed(root);
    assert.equal(registry.findAgents(root, {}).length, 3);
  });
});
