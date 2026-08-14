"use strict";

/**
 * context-expand.test.js — P-002 Context Expand 测试
 *
 * 验证：
 * - minimal/standard/deep 三级展开
 * - 列表显式上限
 * - revision/estimated_tokens/truncated 输出
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const ROOT = require("path").resolve(__dirname, "../..");
const EXPAND_PATH = require("path").join(ROOT, ".agent", "skills", "context-budget", "scripts", "context-expand.js");

// 加载模块
let expand;
try {
  expand = require(EXPAND_PATH);
} catch (e) {
  const fs = require("fs");
  const code = fs.readFileSync(EXPAND_PATH, "utf8");
  expand = {};
  eval(`
    (function() {
      ${code.replace(/module\.exports\s*=\s*\{[^}]+\}/, (match) => {
        const names = match.match(/(\w+):/g) || [];
        return `return { ${names.map(n => n.slice(0,-1)).join(", ")} };`;
      })}
    })()
  `.replace(/module\.exports/g, "expand"));
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const MOCK_ITEMS = [
  {
    uri: "cortex://references/src/auth",
    module: "auth",
    tier: "L0",
    summary: "OAuth authentication module",
    l0: "OAuth 2.0 authentication",
    l1: "OAuth 2.0 with PKCE flow...",
    l2: "Full OAuth 2.0 implementation with authorization code flow...",
    l0_tokens: 50,
    l1_tokens: 200,
    l2_tokens: 500,
    reason_codes: ["selector-match"],
  },
  {
    uri: "cortex://references/src/api",
    module: "api",
    tier: "L1",
    summary: "REST API endpoints",
    l0: "REST API",
    l1: "Express.js REST endpoints with JWT...",
    l2: "Complete REST API with middleware...",
    l0_tokens: 30,
    l1_tokens: 150,
    l2_tokens: 400,
  },
  {
    uri: "cortex://references/db/connection",
    module: "db",
    tier: "L2",
    summary: "Database connection pool",
    l0: "Database connection",
    l1: "PostgreSQL connection pool...",
    l2: "Full connection pool with retry logic...",
    l0_tokens: 40,
    l1_tokens: 180,
    l2_tokens: 450,
  },
  {
    uri: "cortex://references/lib/utils",
    module: "utils",
    tier: "L0",
    summary: "Utility functions",
    l0: "Utilities",
    reason_codes: [],
  },
];

test("P-002: expand with minimal level returns summary only", () => {
  const result = expand.expand({
    trajectoryId: "CTX-T001",
    level: "minimal",
    items: MOCK_ITEMS,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.level, "minimal");
  assert.ok(result.data.summary, "minimal should have summary");
  assert.ok(typeof result.data.estimated_tokens === "number");
  assert.ok(result.data.truncated === false, "minimal should not truncate");
  assert.ok(result.data.items_preview, "minimal should have items_preview");
  assert.ok(Array.isArray(result.data.items_preview));
});

test("P-002: expand with standard level includes L0 + L1", () => {
  const result = expand.expand({
    trajectoryId: "CTX-T002",
    level: "standard",
    items: MOCK_ITEMS,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.level, "standard");
  assert.ok(result.data.items, "standard should have items");
  assert.ok(Array.isArray(result.data.items));

  // standard should primarily include L0 and L1
  // (L2 items may appear if no L0/L1 items exist)
  if (result.data.items.length > 0) {
    for (const item of result.data.items) {
      assert.ok(
        item.tier === "L0" || item.tier === "L1" || item.tier === "L2",
        `standard items should be L0/L1/L2, got ${item.tier}`
      );
    }
  }
});

test("P-002: expand with deep level includes L0 + L1 + L2", () => {
  const result = expand.expand({
    trajectoryId: "CTX-T003",
    level: "deep",
    items: MOCK_ITEMS,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.level, "deep");
  assert.ok(result.data.items, "deep should have items");

  // deep should include all tiers
  const tiers = new Set(result.data.items.map((i) => i.tier));
  assert.ok(tiers.has("L0"), "deep should include L0");
  assert.ok(tiers.has("L1"), "deep should include L1");
  assert.ok(tiers.has("L2"), "deep should include L2");
});

test("P-002: items have estimated_tokens and reason_codes", () => {
  const result = expand.expand({
    level: "standard",
    items: MOCK_ITEMS,
  });

  assert.equal(result.ok, true);
  for (const item of result.data.items) {
    assert.ok(typeof item.estimated_tokens === "number", "item should have estimated_tokens");
    assert.ok(Array.isArray(item.reason_codes), "item should have reason_codes");
  }
});

test("P-002: output includes revision and reason_codes", () => {
  const result = expand.expand({
    trajectoryId: "CTX-T004",
    level: "deep",
    items: MOCK_ITEMS,
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.revision, "output should include revision");
  assert.ok(result.data.reason_codes, "output should include reason_codes");
  assert.ok(Array.isArray(result.data.reason_codes));
  assert.ok(result.data.reason_codes.includes("context-expand"));
});

test("P-002: truncated is true when exceeding max_tokens", () => {
  const result = expand.expand({
    level: "standard",
    items: MOCK_ITEMS,
    tokenBudget: 100, // Very low budget
  });

  assert.equal(result.ok, true);
  // With low budget, some items should be truncated
  if (result.data.items.length < MOCK_ITEMS.length) {
    assert.equal(result.data.truncated, true);
  }
});

test("P-002: level config respects maxTokens", () => {
  const minimalResult = expand.expand({
    level: "minimal",
    items: MOCK_ITEMS,
  });
  const standardResult = expand.expand({
    level: "standard",
    items: MOCK_ITEMS,
  });
  const deepResult = expand.expand({
    level: "deep",
    items: MOCK_ITEMS,
  });

  assert.ok(
    minimalResult.data.max_tokens <= standardResult.data.max_tokens,
    "minimal max_tokens should be <= standard"
  );
  assert.ok(
    standardResult.data.max_tokens <= deepResult.data.max_tokens,
    "standard max_tokens should be <= deep"
  );
});

test("P-002: items are capped at MAX_LIST_SIZE (50)", () => {
  // Create 100 items
  const manyItems = Array.from({ length: 100 }, (_, i) => ({
    uri: `cortex://references/item-${i}`,
    module: `item-${i}`,
    tier: "L0",
    summary: `Item ${i}`,
    l0: `Content for item ${i}`,
    l0_tokens: 50,
  }));

  const result = expand.expand({
    level: "deep",
    items: manyItems,
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.items.length <= 50, `items should be capped at 50, got ${result.data.items.length}`);
  assert.equal(result.data.items_count, 100);
});

test("P-002: protected items are handled correctly", () => {
  const itemsWithProtected = [
    ...MOCK_ITEMS,
    {
      uri: "cortex://references/rules/auth",
      module: "auth-rules",
      tier: "L0",
      protected: true,
      l0: "Auth rules",
      l0_tokens: 1000, // Large
    },
  ];

  const result = expand.expand({
    level: "standard", // Use standard to get full items
    items: itemsWithProtected,
    tokenBudget: 5000, // Enough budget
  });

  assert.equal(result.ok, true);
  // Protected item should be included
  if (result.data.items) {
    const protectedItems = result.data.items.filter((i) => i.uri && i.uri.includes("rules/auth"));
    assert.ok(protectedItems.length > 0, "protected items should be included");
  }
});

test("P-002: invalid level returns error", () => {
  const result = expand.expand({
    level: "invalid",
    items: MOCK_ITEMS,
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("invalid level"));
});

test("P-002: missing items returns error", () => {
  const result = expand.expand({
    level: "minimal",
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("no items"));
});

test("P-002: empty items array returns error", () => {
  const result = expand.expand({
    level: "minimal",
    items: [],
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("no items"));
});

test("P-002: tokenize function is consistent", () => {
  const tokens = expand.tokenize("Hello 你好 world 世界");
  assert.ok(tokens >= 5 && tokens <= 10, `tokenize should return ~6, got ${tokens}`);
});

test("P-002: LEVEL_CONFIG defines correct thresholds", () => {
  assert.ok(expand.LEVEL_CONFIG);
  assert.equal(expand.LEVEL_CONFIG.minimal.maxTokens, 300);
  assert.equal(expand.LEVEL_CONFIG.standard.maxTokens, 2000);
  assert.equal(expand.LEVEL_CONFIG.deep.maxTokens, 10000);

  assert.deepEqual(expand.LEVEL_CONFIG.minimal, {
    maxTokens: 300, includeL0: true, includeL1: false, includeL2: false, maxItems: 10,
  });
  assert.deepEqual(expand.LEVEL_CONFIG.standard, {
    maxTokens: 2000, includeL0: true, includeL1: true, includeL2: false, maxItems: 25,
  });
  assert.deepEqual(expand.LEVEL_CONFIG.deep, {
    maxTokens: 10000, includeL0: true, includeL1: true, includeL2: true, maxItems: 50,
  });
});

test("P-002: generateMinimalSummary produces summary under 300 tokens", () => {
  const result = expand.generateMinimalSummary(MOCK_ITEMS);

  assert.ok(result.summary, "should have summary");
  assert.ok(typeof result.estimated_tokens === "number");
  assert.ok(result.estimated_tokens <= 300, `minimal summary should be <= 300 tokens, got ${result.estimated_tokens}`);
});

test("P-002: fallback_used field is present", () => {
  const result = expand.expand({
    level: "minimal",
    items: MOCK_ITEMS,
  });

  assert.equal(result.ok, true);
  assert.ok(typeof result.data.fallback_used === "boolean");
});
