"use strict";

// Coverage for lib/agents/discover.js — scoring, filters, limit clamping.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const registry = require("../../lib/agents/registry.js");
const { discover, _tokenize, _scoreEntry, _recencyBonus } = require("../../lib/agents/discover.js");

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-discover-test-"));
}

function entry(id, overrides = {}) {
  return {
    schema_version: 1,
    agent_id: id,
    role: "implementer",
    model: "test-model",
    started_at: "2026-08-11T00:00:00.000Z",
    status: "running",
    capabilities: [],
    ...overrides,
  };
}

describe("agents/discover — tokenize", () => {
  test("tokenize lowercases and splits on non-alphanumerics", () => {
    assert.deepEqual(_tokenize("Cross-Project Bridge"), ["cross", "project", "bridge"]);
  });

  test("tokenize returns [] for null/empty", () => {
    assert.deepEqual(_tokenize(null), []);
    assert.deepEqual(_tokenize(""), []);
  });

  test("tokenize keeps digits and underscores", () => {
    assert.deepEqual(_tokenize("p_002 phase2"), ["p_002", "phase2"]);
  });
});

describe("agents/discover — recency bonus", () => {
  const now = Date.parse("2026-08-11T00:00:00.000Z");

  test("fresh heartbeat (today) gives max bonus 0.1", () => {
    const bonus = _recencyBonus(entry("a", { last_heartbeat: "2026-08-11T00:00:00.000Z" }), now);
    assert.ok(Math.abs(bonus - 0.1) < 1e-9);
  });

  test("30+ day old heartbeat gives zero bonus", () => {
    const bonus = _recencyBonus(entry("a", { last_heartbeat: "2026-07-01T00:00:00.000Z" }), now);
    assert.equal(bonus, 0);
  });

  test("missing heartbeat gives zero bonus", () => {
    assert.equal(_recencyBonus(entry("a"), now), 0);
  });

  test("future heartbeat gives zero bonus (no negative age)", () => {
    const bonus = _recencyBonus(entry("a", { last_heartbeat: "2026-09-01T00:00:00.000Z" }), now);
    assert.equal(bonus, 0);
  });
});

describe("agents/discover — scoring", () => {
  test("scoreEntry awards hits on id/capabilities", () => {
    const e = entry("agent-coding-expert", { capabilities: ["code-review"] });
    const score = _scoreEntry(e, ["coding", "expert", "review"]);
    assert.ok(score > 0);
  });

  test("scoreEntry returns 0 for unrelated tokens", () => {
    const e = entry("agent-a", { capabilities: ["docs"] });
    assert.equal(_scoreEntry(e, ["zzz", "qqq"]), 0);
  });
});

describe("agents/discover — discover()", () => {
  test("requires projectRoot", () => {
    assert.throws(() => discover({}), { code: "ERR_PROJECT_ROOT_REQUIRED" });
  });

  test("returns structured envelope with counters", () => {
    const root = makeProject();
    registry.writeAgent(root, entry("a1"));
    const res = discover({ projectRoot: root });
    assert.equal(res.query, "");
    assert.equal(res.scanned, 1);
    assert.equal(res.returned, 1);
    assert.ok(Array.isArray(res.agents));
  });

  test("query ranks matching agent first", () => {
    const root = makeProject();
    registry.writeAgent(root, entry("docs-writer", { capabilities: ["docs"] }));
    registry.writeAgent(root, entry("code-fixer", { capabilities: ["coding"] }));
    // findAgents filters by substring, so the query must match literally.
    const res = discover({ projectRoot: root, query: "fixer" });
    assert.equal(res.agents[0].agent_id, "code-fixer");
  });

  test("hard filter by role narrows candidates", () => {
    const root = makeProject();
    registry.writeAgent(root, entry("impl", { role: "implementer" }));
    registry.writeAgent(root, entry("rev", { role: "reviewer" }));
    const res = discover({ projectRoot: root, role: "reviewer" });
    assert.equal(res.scanned, 1);
    assert.equal(res.agents[0].agent_id, "rev");
  });

  test("limit is clamped to [1, 100] with default fallback", () => {
    const root = makeProject();
    registry.writeAgent(root, entry("a"));
    // limit:0 is falsy, so Number(limit) || DEFAULT_LIMIT falls back to 10.
    assert.equal(discover({ projectRoot: root, limit: 0 }).limit, 10);
    // Negative limits are clamped up to the minimum of 1.
    assert.equal(discover({ projectRoot: root, limit: -5 }).limit, 1);
    assert.equal(discover({ projectRoot: root, limit: 9999 }).limit, 100);
  });

  test("agents are projected to a stable subset of fields", () => {
    const root = makeProject();
    registry.writeAgent(root, entry("a", { owned_files: ["lib/x.js"], last_heartbeat: "2026-08-11T00:00:00.000Z" }));
    const res = discover({ projectRoot: root });
    const a = res.agents[0];
    assert.deepEqual(Object.keys(a).sort(), [
      "agent_id", "capabilities", "external", "last_heartbeat", "model", "role", "score", "status",
    ]);
  });
});
