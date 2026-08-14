"use strict";

/**
 * capability-detect.test.js — P-003 Capability Detect 测试
 *
 * 验证：
 * - P-003 §1 capability contract 输出
 * - 不支持标记 unknown/unavailable
 * - supports_compaction/prompt_cache 枚举验证
 * - 环境检测、host 推断
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const ROOT = require("path").resolve(__dirname, "../..");
const CAP_PATH = require("path").join(ROOT, ".agent", "skills", "context-budget", "scripts", "capability-detect.js");

// 加载模块
let cap;
try {
  cap = require(CAP_PATH);
} catch (e) {
  const fs = require("fs");
  const code = fs.readFileSync(CAP_PATH, "utf8");
  cap = {};
  eval(`
    (function() {
      ${code.replace(/module\.exports\s*=\s*\{[^}]+\}/, (match) => {
        const names = match.match(/(\w+):/g) || [];
        return `return { ${names.map(n => n.slice(0,-1)).join(", ")} };`;
      })}
    })()
  `.replace(/module\.exports/g, "cap"));
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

test("P-003: DEFAULT_CAPABILITIES matches contract fields", () => {
  const fields = [
    "supports_compaction",
    "supports_prompt_cache",
    "supports_render_receipt",
    "supports_usage_receipt",
    "supports_shared_prefix",
    "supports_stateless_compaction_fallback",
  ];

  for (const field of fields) {
    assert.ok(field in cap.DEFAULT_CAPABILITIES, `DEFAULT_CAPABILITIES should have ${field}`);
  }
});

test("P-003: detectFromEnv extracts capability from env vars", () => {
  const cases = [
    {
      env: { CORTEX_PROMPT_CACHE: "implicit.cache" },
      expected: { supports_prompt_cache: "implicit" },
    },
    {
      env: { CORTEX_PROMPT_CACHE: "explicit.cache" },
      expected: { supports_prompt_cache: "explicit" },
    },
    {
      env: { CORTEX_PROMPT_CACHE: "no.cache" },
      expected: { supports_prompt_cache: "none" },
    },
    {
      env: { CORTEX_COMPACTION: "server.side" },
      expected: { supports_compaction: "server" },
    },
    {
      env: { CORTEX_COMPACTION: "client.side" },
      expected: { supports_compaction: "client" },
    },
    {
      env: { CORTEX_SHARED_PREFIX: "true" },
      expected: { supports_shared_prefix: true },
    },
  ];

  for (const { env, expected } of cases) {
    const detected = cap.detectFromEnv(env);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(detected[key], value, `env ${JSON.stringify(env)} should detect ${key}=${value}`);
    }
  }
});

test("P-003: detectFromHost infers capabilities from host name", () => {
  const cases = [
    {
      host: "claude-code",
      expected: {
        supports_compaction: "none",
        supports_prompt_cache: "implicit",
        supports_render_receipt: false,
        supports_usage_receipt: false,
      },
    },
    {
      host: "anthropic/claude",
      expected: {
        supports_compaction: "none",
        supports_prompt_cache: "implicit",
      },
    },
    {
      host: "codex",
      expected: {
        supports_compaction: "client",
        supports_prompt_cache: "explicit",
        supports_render_receipt: true,
        supports_usage_receipt: true,
        supports_shared_prefix: true,
      },
    },
    {
      host: "openai/codex",
      expected: {
        supports_compaction: "client",
        supports_prompt_cache: "explicit",
      },
    },
    {
      host: "gemini",
      expected: {
        supports_compaction: "server",
        supports_prompt_cache: "implicit",
        supports_render_receipt: true,
        supports_usage_receipt: true,
        supports_shared_prefix: false,
      },
    },
    {
      host: "google/gemini",
      expected: {
        supports_compaction: "server",
        supports_prompt_cache: "implicit",
      },
    },
    {
      host: "pi-cortex",
      expected: {
        supports_compaction: "none",
        supports_prompt_cache: "none",
        supports_render_receipt: false,
        supports_usage_receipt: false,
      },
    },
  ];

  for (const { host, expected } of cases) {
    const detected = cap.detectFromHost(host);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(detected[key], value, `host ${host} should infer ${key}=${value}`);
    }
  }
});

test("P-003: validateCapabilities returns ok for valid caps", () => {
  const validCaps = {
    supports_compaction: "server",
    supports_prompt_cache: "implicit",
    supports_render_receipt: true,
    supports_usage_receipt: true,
    supports_shared_prefix: false,
    supports_stateless_compaction_fallback: false,
  };

  const result = cap.validateCapabilities(validCaps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("P-003: validateCapabilities rejects invalid supports_compaction", () => {
  const cases = ["unknown", "Unavailable", "yes", "no", 123, null];

  for (const value of cases) {
    const caps = {
      supports_compaction: value,
      supports_prompt_cache: "none",
      supports_render_receipt: false,
      supports_usage_receipt: false,
      supports_shared_prefix: false,
      supports_stateless_compaction_fallback: false,
    };
    const result = cap.validateCapabilities(caps);
    assert.equal(result.ok, false, `supports_compaction=${JSON.stringify(value)} should fail validation`);
    assert.ok(result.errors.some((e) => e.includes("supports_compaction")));
  }
});

test("P-003: validateCapabilities rejects invalid supports_prompt_cache", () => {
  const cases = ["unknown", "yes", "no", "both", 123];

  for (const value of cases) {
    const caps = {
      supports_compaction: "none",
      supports_prompt_cache: value,
      supports_render_receipt: false,
      supports_usage_receipt: false,
      supports_shared_prefix: false,
      supports_stateless_compaction_fallback: false,
    };
    const result = cap.validateCapabilities(caps);
    assert.equal(result.ok, false, `supports_prompt_cache=${JSON.stringify(value)} should fail`);
    assert.ok(result.errors.some((e) => e.includes("supports_prompt_cache")));
  }
});

test("P-003: validateCapabilities rejects non-boolean boolean fields", () => {
  const booleanFields = [
    "supports_render_receipt",
    "supports_usage_receipt",
    "supports_shared_prefix",
    "supports_stateless_compaction_fallback",
  ];

  for (const field of booleanFields) {
    const caps = {
      supports_compaction: "none",
      supports_prompt_cache: "none",
      supports_render_receipt: false,
      supports_usage_receipt: false,
      supports_shared_prefix: false,
      supports_stateless_compaction_fallback: false,
      [field]: "true", // Invalid string instead of boolean
    };
    const result = cap.validateCapabilities(caps);
    assert.equal(result.ok, false, `${field}="true" (string) should fail`);
    assert.ok(result.errors.some((e) => e.includes(field)));
  }
});

test("P-003: mergeCapabilities respects priority order", () => {
  const sources = [
    { supports_compaction: "server" },
    { supports_prompt_cache: "explicit" },
    { supports_render_receipt: true },
  ];

  const merged = cap.mergeCapabilities(sources);

  assert.equal(merged.supports_compaction, "server");
  assert.equal(merged.supports_prompt_cache, "explicit");
  assert.equal(merged.supports_render_receipt, true);
});

test("P-003: mergeCapabilities applies DEFAULT_CAPABILITIES for missing fields", () => {
  const sources = [
    { supports_compaction: "server" },
  ];

  const merged = cap.mergeCapabilities(sources);

  assert.equal(merged.supports_compaction, "server");
  assert.equal(merged.supports_prompt_cache, "none"); // default
  assert.equal(merged.supports_render_receipt, false); // default
});

test("P-003: mergeCapabilities skips falsy sources", () => {
  const sources = [
    null,
    undefined,
    {},
    { supports_compaction: "client" },
  ];

  const merged = cap.mergeCapabilities(sources);
  assert.equal(merged.supports_compaction, "client");
});

test("P-003: detect returns full capability object", async () => {
  const result = await cap.detect({
    host: "claude-code",
  });

  assert.equal(result.ok, true);
  assert.ok(result.data);
  assert.ok(result.data.schema_version, "1.0");
  assert.ok(result.data.host);
  assert.ok(result.data.detected_at);
  assert.ok(result.data.detection_method);

  // All contract fields present
  const fields = [
    "supports_compaction",
    "supports_prompt_cache",
    "supports_render_receipt",
    "supports_usage_receipt",
    "supports_shared_prefix",
    "supports_stateless_compaction_fallback",
  ];
  for (const field of fields) {
    assert.ok(field in result.data, `${field} should be in output`);
  }
});

test("P-003: detect without host uses env detection only", async () => {
  const result = await cap.detect({});

  assert.equal(result.ok, true);
  assert.ok(result.data.detection_method);
  // 检测方法不应包含 "probe"
  assert.ok(!result.data.detection_method.includes("probe"));
});

test("P-003: detect with probe adds probe method", async () => {
  const result = await cap.detect({
    host: "codex",
    probe: true,
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.detection_method.includes("probe"));
});

test("P-003: probeHost returns host-specific capabilities", async () => {
  const hosts = ["claude-code", "codex", "gemini", "pi-agent"];

  for (const host of hosts) {
    const result = await cap.probeHost(host);
    assert.ok(result);
    assert.ok(typeof result.supports_compaction === "string");
    assert.ok(typeof result.supports_prompt_cache === "string");
    assert.ok(typeof result.supports_render_receipt === "boolean");
    assert.ok(typeof result.supports_usage_receipt === "boolean");
    assert.ok(typeof result.supports_shared_prefix === "boolean");
  }
});

test("P-003: probeHost timeout handling", async () => {
  // probeHost 内部有超时处理，返回降级结果而不是抛出
  const result = await cap.probeHost("slow-host", 1); // 1ms timeout
  // 应该返回默认能力而不是抛出
  assert.ok(result);
  assert.ok(typeof result.supports_compaction === "string");
});

test("P-003: capability values are never unknown/unavailable", async () => {
  const hosts = ["claude-code", "codex", "gemini", "pi-agent", "unknown-host"];

  for (const host of hosts) {
    const result = await cap.detect({ host, probe: false });
    assert.equal(result.ok, true);

    const { data } = result;
    // P-003 §1: 不支持标记 unknown/unavailable
    assert.notEqual(data.supports_compaction, "unknown");
    assert.notEqual(data.supports_compaction, "unavailable");
    assert.notEqual(data.supports_prompt_cache, "unknown");
    assert.notEqual(data.supports_prompt_cache, "unavailable");

    // 必须输出有效枚举
    const validCompaction = ["server", "client", "none"];
    const validPromptCache = ["implicit", "explicit", "none"];
    assert.ok(validCompaction.includes(data.supports_compaction), `${host}: supports_compaction=${data.supports_compaction} invalid`);
    assert.ok(validPromptCache.includes(data.supports_prompt_cache), `${host}: supports_prompt_cache=${data.supports_prompt_cache} invalid`);
  }
});

test("P-003: all boolean fields are properly typed", async () => {
  const result = await cap.detect({ host: "claude-code" });

  assert.equal(result.ok, true);
  const { data } = result;
  const boolFields = [
    "supports_render_receipt",
    "supports_usage_receipt",
    "supports_shared_prefix",
    "supports_stateless_compaction_fallback",
  ];

  for (const field of boolFields) {
    assert.strictEqual(typeof data[field], "boolean", `${field} should be boolean, got ${typeof data[field]}`);
  }
});
