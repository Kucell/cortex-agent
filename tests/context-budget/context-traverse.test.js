"use strict";

/**
 * context-traverse.test.js — P-002 Context Traverse 测试
 *
 * 验证：
 * - BFS/DFS 遍历模式
 * - token_budget 有界遍历
 * - truncated/omitted/next_query 输出
 * - 复用 select.js 的 scoreModule/extractTaskTokens
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const ROOT = require("path").resolve(__dirname, "../..");
const TRAVERSE_PATH = require("path").join(ROOT, ".agent", "skills", "context-budget", "scripts", "context-traverse.js");

// 加载模块
let traverse;
try {
  traverse = require(TRAVERSE_PATH);
} catch (e) {
  const fs = require("fs");
  const code = fs.readFileSync(TRAVERSE_PATH, "utf8");
  traverse = {};
  eval(`
    (function() {
      ${code.replace(/module\.exports\s*=\s*\{[^}]+\}/, (match) => {
        const names = match.match(/(\w+):/g) || [];
        return `return { ${names.map(n => n.slice(0,-1)).join(", ")} };`;
      })}
    })()
  `.replace(/module\.exports/g, "traverse"));
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const MOCK_CANDIDATES = [
  {
    module: "auth",
    module_path: "src/auth",
    summary: "OAuth authentication module",
    l0: "OAuth 2.0 authentication",
    l0_tokens: 50,
    l1_tokens: 200,
    l2_tokens: 500,
    keywords: ["oauth", "auth", "login"],
  },
  {
    module: "api",
    module_path: "src/api",
    summary: "REST API endpoints",
    l0: "REST API",
    l0_tokens: 30,
    l1_tokens: 150,
    l2_tokens: 400,
    keywords: ["api", "rest", "endpoint"],
  },
  {
    module: "db",
    module_path: "db/connection",
    summary: "Database connection pool",
    l0: "Database connection",
    l0_tokens: 40,
    l1_tokens: 180,
    l2_tokens: 450,
    keywords: ["database", "db", "pool"],
  },
  {
    module: "utils",
    module_path: "lib/utils",
    summary: "Utility functions",
    l0: "Utilities",
    l0_tokens: 20,
    l1_tokens: 100,
    l2_tokens: 200,
    keywords: ["utils", "helper"],
  },
  {
    module: "rules-auth",
    module_path: "rules/auth-rules",
    summary: "Authentication rules and decisions",
    l0: "Auth rules",
    l0_tokens: 60,
    l1_tokens: 250,
    l2_tokens: 600,
    keywords: ["auth", "rules", "security"],
    // protected 条目
    protected: true,
  },
];

test("P-002: traverse with BFS mode returns visited items within budget", () => {
  const result = traverse.traverse({
    query: "implement oauth login authentication",
    mode: "bfs",
    depth: 3,
    tokenBudget: 300,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.mode, "bfs");
  assert.ok(result.data.token_budget, 300);
  assert.ok(Array.isArray(result.data.items));
  assert.ok(typeof result.data.truncated === "boolean");
  assert.ok(typeof result.data.omitted_count === "number");
  assert.ok(typeof result.data.budget_used === "number");
  assert.ok(typeof result.data.budget_remaining === "number");
});

test("P-002: traverse with DFS mode returns visited items within budget", () => {
  const result = traverse.traverse({
    query: "implement oauth login authentication",
    mode: "dfs",
    depth: 3,
    tokenBudget: 400,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.mode, "dfs");
  assert.ok(Array.isArray(result.data.items));
});

test("P-002: protected items (rules/decisions) are always included", () => {
  const result = traverse.traverse({
    query: "some unrelated query",
    mode: "bfs",
    depth: 2,
    tokenBudget: 10, // Very low budget
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  // Protected items should be included even with low budget
  const protectedItems = result.data.items.filter((i) => i.protected);
  assert.ok(protectedItems.length > 0, "protected items should be included");
});

test("P-002: truncated field is present when budget exhausted", () => {
  const result = traverse.traverse({
    query: "implement oauth login",
    mode: "bfs",
    depth: 2,
    tokenBudget: 100, // Low budget
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  assert.equal(typeof result.data.truncated, "boolean", "truncated should be boolean");
  assert.equal(typeof result.data.omitted_count, "number", "omitted_count should be number");
  // With very low budget, truncated should be true or omitted_count > 0
  assert.ok(
    result.data.truncated === true || result.data.omitted_count > 0,
    `truncated=${result.data.truncated} or omitted=${result.data.omitted_count}`
  );
});

test("P-002: next_query is provided when truncated", () => {
  const result = traverse.traverse({
    query: "implement oauth login",
    mode: "bfs",
    depth: 2,
    tokenBudget: 50, // Very low budget
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  if (result.data.truncated) {
    assert.ok(result.data.next_query !== null, "next_query should be provided when truncated");
    assert.ok(typeof result.data.next_query === "string");
  }
});

test("P-002: items include uri, module, estimated_tokens, tier, reason_codes", () => {
  const result = traverse.traverse({
    query: "oauth authentication",
    mode: "bfs",
    depth: 2,
    tokenBudget: 1000,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  for (const item of result.data.items) {
    assert.ok(item.uri, "item should have uri");
    assert.ok(item.module || item.path, "item should have module or path");
    assert.ok(typeof item.estimated_tokens === "number", "item should have estimated_tokens");
    assert.ok(item.tier, "item should have tier (L0/L1/L2)");
    assert.ok(Array.isArray(item.reason_codes), "item should have reason_codes array");
  }
});

test("P-002: output includes revision and reason_codes", () => {
  const result = traverse.traverse({
    query: "authentication",
    mode: "bfs",
    depth: 2,
    tokenBudget: 500,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.revision, "output should include revision");
  assert.ok(result.data.reason_codes, "output should include reason_codes");
  assert.ok(Array.isArray(result.data.reason_codes));
  assert.ok(result.data.reason_codes.includes("graph-traverse"), "should include graph-traverse reason code");
});

test("P-002: fallback_used indicates whether select.js was available", () => {
  const result = traverse.traverse({
    query: "test query",
    mode: "bfs",
    depth: 2,
    tokenBudget: 500,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  assert.ok(typeof result.data.fallback_used === "boolean", "fallback_used should be boolean");
});

test("P-002: depth is capped at MAX_DEPTH (6)", () => {
  const result = traverse.traverse({
    query: "test",
    mode: "bfs",
    depth: 10, // Exceeds MAX_DEPTH
    tokenBudget: 1000,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.depth_requested, 6, "requested depth should be capped at 6");
  assert.ok(result.data.depth_reached <= 6);
});

test("P-002: invalid mode returns error", () => {
  const result = traverse.traverse({
    query: "test",
    mode: "invalid",
    depth: 2,
    tokenBudget: 500,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("invalid mode"));
});

test("P-002: missing query returns error", () => {
  const result = traverse.traverse({
    mode: "bfs",
    tokenBudget: 500,
    candidates: MOCK_CANDIDATES,
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("query"));
});

test("P-002: invalid token_budget returns error", () => {
  const cases = [
    { tokenBudget: 0, error: "positive" },
    { tokenBudget: -100, error: "positive" },
    { tokenBudget: 600000, error: "maximum" },
  ];

  for (const { tokenBudget, error: expectedError } of cases) {
    const result = traverse.traverse({
      query: "test",
      mode: "bfs",
      tokenBudget,
      candidates: MOCK_CANDIDATES,
    });
    assert.equal(result.ok, false, `tokenBudget=${tokenBudget} should fail`);
    assert.ok(result.error.includes(expectedError), `error should contain "${expectedError}"`);
  }
});

test("P-002: bfsTraverse prioritizes by score (impact-first)", () => {
  const result = traverse.bfsTraverse(MOCK_CANDIDATES, {
    taskTokens: ["oauth", "auth"],
    taskPathHints: [],
    tokenBudget: 200,
    maxDepth: 3,
  });

  assert.equal(result.mode, "bfs");
  // Higher score items should appear first
  if (result.visited.length > 1) {
    for (let i = 1; i < result.visited.length; i++) {
      assert.ok(
        result.visited[i - 1].score >= result.visited[i].score,
        "items should be sorted by score descending"
      );
    }
  }
});

test("P-002: dfsTraverse follows dependency chains", () => {
  // Add dependencies to mock candidates
  const withDeps = MOCK_CANDIDATES.map((c) => ({
    ...c,
    dependencies: c.module === "auth" ? ["src/api", "db/connection"] : [],
  }));

  const result = traverse.dfsTraverse(withDeps, {
    taskTokens: ["oauth"],
    taskPathHints: [],
    tokenBudget: 1000,
    maxDepth: 3,
  });

  assert.equal(result.mode, "dfs");
  assert.ok(Array.isArray(result.visited));
  // DFS should mark items with dfs-path reason code
  for (const item of result.visited) {
    if (item.parent) {
      assert.ok(item.reason_codes.includes("dfs-path") || item.reason_codes.includes("selector-match"));
    }
  }
});

test("P-002: tokenize function is consistent with select.js", () => {
  const tokens = traverse.tokenize("Hello 你好 world 世界");
  // CJK: 4 chars / 1.5 = ~3 tokens
  // Latin: 11 chars / 4 = ~3 tokens
  // Total: ~6 tokens
  assert.ok(tokens >= 5 && tokens <= 10, `tokenize should return ~6, got ${tokens}`);
});

test("P-002: empty candidates returns empty result without error", () => {
  const result = traverse.traverse({
    query: "test",
    mode: "bfs",
    tokenBudget: 500,
    candidates: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 0);
  assert.equal(result.data.truncated, false);
});
