"use strict";

// ─── DSH shadow adapter tests (M-025/MS-003 Phase B host expansion) ─────────
// Validates the DSH (DeepSeek Harness) shadow adapter against the same
// security and contract guarantees used for Codex and Pi:
//   1. Host identity (hostId + measurementSource)
//   2. Capability discovery (always "available" for DSH by default)
//   3. Alias mapping: inputTokens / outputTokens / cacheReadTokens /
//      cacheWriteTokens → canonical MS-001 fields
//   4. Blocked fields (prompt, response, paths) raise ShadowUsageError
//   5. Receipt schema conformance (host_reported, samples=1)
//   6. cache_creation_input_tokens is "unknown" if cacheWriteTokens absent
//      (per MS-001 unknown-stays-unknown contract)
//   7. Adapter registry contains DSH

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  HOST_ID,
  SOURCE_ID,
  ALLOWED_USAGE_FIELDS,
  DshShadowAdapter,
  createDshShadowAdapter,
} = require("../../../lib/host-adapter/shadow-usage/dsh-shadow.js");

const {
  listAdapters,
  ShadowUsageError,
  TOKEN_FIELDS,
} = require("../../../lib/host-adapter/shadow-usage/index.js");

// ─── TC-DSH-001: Host identity ───────────────────────────────────────────────
test("TC-DSH-001: adapter advertises DSH host + source", () => {
  const adapter = createDshShadowAdapter();
  assert.equal(adapter.getHostId(), "dsh");
  assert.equal(adapter.getSourceId(), "dsh");
  assert.equal(HOST_ID, "dsh");
  assert.equal(SOURCE_ID, "dsh");
});

// ─── TC-DSH-002: Adapter is registered ───────────────────────────────────────
test("TC-DSH-002: dsh appears in adapter registry", () => {
  const ids = listAdapters();
  assert.ok(ids.includes("dsh"), `expected 'dsh' in [${ids.join(",")}]`);
});

// ─── TC-DSH-003: Capability detection (default = available) ──────────────────
test("TC-DSH-003: capability is available by default", () => {
  const adapter = createDshShadowAdapter();
  const cap = adapter.detectUsage();
  assert.equal(cap.ok, true);
  assert.equal(cap.host, "dsh");
  assert.equal(cap.source, "dsh");
  assert.equal(cap.status, "available");
});

// ─── TC-DSH-004: Capability can be forced unavailable ────────────────────────
test("TC-DSH-004: capability reflects explicit override", () => {
  const adapter = createDshShadowAdapter({ usageCapability: "unavailable" });
  const cap = adapter.detectUsage();
  assert.equal(cap.status, "unavailable");
  assert.equal(cap.reason, "usage_capability_unavailable");
});

// ─── TC-DSH-005: Alias mapping (DSH names → canonical MS-001) ────────────────
test("TC-DSH-005: inputTokens / outputTokens / cacheReadTokens map to canonical", () => {
  const adapter = createDshShadowAdapter();
  const result = adapter.normalizeUsage({
    usage: { inputTokens: 12266, outputTokens: 100, cacheReadTokens: 128 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.host, "dsh");
  assert.equal(result.source, "dsh");
  assert.equal(result.usage.input_tokens, 12266);
  assert.equal(result.usage.output_tokens, 100);
  assert.equal(result.usage.cache_read_input_tokens, 128);
  // cacheWriteTokens absent → canonical = 0 + reported = "unknown"
  assert.equal(result.usage.cache_creation_input_tokens, 0);
  assert.equal(result.reported.cache_creation_input_tokens, "unknown");
});

// ─── TC-DSH-006: cacheWriteTokens surfaces cache_creation_input_tokens ───────
test("TC-DSH-006: cacheWriteTokens maps to cache_creation_input_tokens", () => {
  const adapter = createDshShadowAdapter();
  const result = adapter.normalizeUsage({
    usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 8000, cacheWriteTokens: 500 },
  });
  assert.equal(result.usage.cache_creation_input_tokens, 500);
  assert.equal(result.reported.cache_creation_input_tokens, 500);
});

// ─── TC-DSH-007: Snake-case canonical names also accepted ────────────────────
test("TC-DSH-007: snake_case aliases accepted alongside camelCase", () => {
  const adapter = createDshShadowAdapter();
  const result = adapter.normalizeUsage({
    usage: { prompt_tokens: 100, completion_tokens: 5, cache_read_tokens: 50 },
  });
  assert.equal(result.usage.input_tokens, 100);
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(result.usage.cache_read_input_tokens, 50);
});

// ─── TC-DSH-008: Blocked fields rejected before mapping ──────────────────────
test("TC-DSH-008: prompt / response / paths are blocked", () => {
  const adapter = createDshShadowAdapter();
  assert.throws(
    () => adapter.normalizeUsage({ prompt: "secret", usage: { inputTokens: 1 } }),
    (err) => err instanceof ShadowUsageError && err.code === "shadow_input_rejected",
  );
  assert.throws(
    () => adapter.normalizeUsage({ response: "leak", usage: { inputTokens: 1 } }),
    (err) => err instanceof ShadowUsageError,
  );
  assert.throws(
    () => adapter.normalizeUsage({
      usage: { inputTokens: 1 },
      absolute_path: "/Users/xueyq/private",
    }),
    (err) => err instanceof ShadowUsageError,
  );
});

// ─── TC-DSH-009: Receipt schema conformance ─────────────────────────────────
test("TC-DSH-009: shadow receipt conforms to MS-001 schema", () => {
  const adapter = createDshShadowAdapter();
  const receipt = adapter.createShadowReceipt({
    attempt_id: "dsh-session-test-1",
    raw_usage: { input_tokens: 12266, output_tokens: 100, cache_read_input_tokens: 128 },
    recorded_at: "2026-08-19T03:00:00.000Z",
    run_id: "session-test",
  });
  assert.equal(receipt.schema_version, "1.0");
  assert.equal(receipt.attempt_id, "dsh-session-test-1");
  assert.equal(receipt.host, "dsh");
  assert.equal(receipt.measurement_source, "dsh");
  assert.equal(receipt.status, "host_reported");
  assert.equal(receipt.usage.samples, 1);
  assert.equal(receipt.usage.input_tokens, 12266);
  assert.equal(receipt.usage.host_reported_input_tokens, 12266);
  assert.equal(receipt.run_id, "session-test");
  assert.match(receipt.receipt_id, /^TR-[0-9a-f]{24}$/);
});

// ─── TC-DSH-010: unknown stays unknown (no zero-masquerading) ────────────────
test("TC-DSH-010: missing cache_creation_input_tokens surfaces as 'unknown' not 0", () => {
  const adapter = createDshShadowAdapter();
  const receipt = adapter.createShadowReceipt({
    attempt_id: "dsh-partial-001",
    raw_usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 },
    recorded_at: "2026-08-19T03:00:00.000Z",
  });
  assert.equal(receipt.usage.cache_creation_input_tokens, 0);
  assert.equal(receipt.usage.host_reported_cache_creation_input_tokens, "unknown");
  assert.equal(receipt.usage.host_reported_cache_tokens, "unknown");
});

// ─── TC-DSH-011: ALLOWED_USAGE_FIELDS contains all expected DSH names ────────
test("TC-DSH-011: ALLOWED_USAGE_FIELDS includes DSH alias names", () => {
  const expected = [
    "inputTokens", "outputTokens",
    "cacheReadTokens", "cacheWriteTokens",
    "cache_read_tokens", "cache_write_tokens",
    "prompt_tokens", "completion_tokens",
    "total_tokens", "reasoning_output_tokens",
  ];
  for (const name of expected) {
    assert.ok(ALLOWED_USAGE_FIELDS.has(name), `missing allowed field: ${name}`);
  }
  // Token fields are always allowed
  for (const field of TOKEN_FIELDS) {
    assert.ok(ALLOWED_USAGE_FIELDS.has(field), `missing canonical field: ${field}`);
  }
});

// ─── TC-DSH-012: Idempotent receipt id across restarts ──────────────────────
test("TC-DSH-012: same (attempt_id, host) → same receipt_id", () => {
  const adapter = createDshShadowAdapter();
  const r1 = adapter.createShadowReceipt({
    attempt_id: "dsh-idem-001",
    raw_usage: { input_tokens: 1, output_tokens: 1 },
    recorded_at: "2026-08-19T03:00:00.000Z",
  });
  const r2 = adapter.createShadowReceipt({
    attempt_id: "dsh-idem-001",
    raw_usage: { input_tokens: 1, output_tokens: 1 },
    recorded_at: "2026-08-19T03:00:00.000Z",
  });
  assert.equal(r1.receipt_id, r2.receipt_id);
});

// ─── TC-DSH-013: Adapter class can be instantiated directly ─────────────────
test("TC-DSH-013: DshShadowAdapter class exposes class API", () => {
  const inst = new DshShadowAdapter();
  assert.equal(inst.getHostId(), "dsh");
  assert.ok(typeof inst.normalizeUsage === "function");
  assert.ok(typeof inst.createShadowReceipt === "function");
});