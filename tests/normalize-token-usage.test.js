"use strict";

// Coverage for normalize-token-usage helper. Targets:
//   - canonical numeric / string / boolean / null inputs per
//     `.agent/rules/normalize-input-value.md` §强制规则 3 (must be testable).
//   - thousand-separation parsing ("1,234").
//   - dirty-string defense ("7,29000000" — concatenated fields, the
//     shape that took out LineChart/PieChart in incident 2026-07-07).
//   - array / object containers with canonical keys / nested numeric children.
//   - samples always=1 regardless of input shape.

const assert = require("node:assert/strict");
const test = require("node:test");

const helperPath = require.resolve("../.agent/skills/management-api/scripts/normalize-token-usage.js");
const { normalizeTokenUsage, coerceToNonNegativeInt, parseNumericString } = require(helperPath);

// ─── canonical numeric / boolean / null inputs ────────────────────────────────

test("numeric input passes through unchanged", () => {
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 42, output_tokens: 7 }), {
    input_tokens: 42,
    output_tokens: 7,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    samples: 1,
  });
});

test("zero is preserved as a legitimate measurement (not collapsed)", () => {
  const out = normalizeTokenUsage({ input_tokens: 0, output_tokens: 0 });
  assert.equal(out.input_tokens, 0);
  assert.equal(out.output_tokens, 0);
});

test("NaN / Infinity fall back to 0", () => {
  const out = normalizeTokenUsage({
    input_tokens: Number.NaN,
    output_tokens: Number.POSITIVE_INFINITY,
    cache_creation_input_tokens: Number.NEGATIVE_INFINITY,
  });
  assert.equal(out.input_tokens, 0);
  assert.equal(out.output_tokens, 0);
  assert.equal(out.cache_creation_input_tokens, 0);
});

test("negative numbers snap to 0 (nonsensical for token counts)", () => {
  const out = normalizeTokenUsage({ input_tokens: -5 });
  assert.equal(out.input_tokens, 0);
});

test("boolean true/false map to 1/0", () => {
  const a = normalizeTokenUsage({ input_tokens: true, output_tokens: false });
  assert.equal(a.input_tokens, 1);
  assert.equal(a.output_tokens, 0);
});

test("null/undefined fields default to 0", () => {
  const out = normalizeTokenUsage({ input_tokens: null, output_tokens: undefined });
  assert.equal(out.input_tokens, 0);
  assert.equal(out.output_tokens, 0);
});

test("missing fields default to 0", () => {
  const out = normalizeTokenUsage({});
  assert.deepEqual(out, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    samples: 1,
  });
});

test("non-object input (null / undefined / array / scalar) returns all-zero shape", () => {
  assert.deepEqual(normalizeTokenUsage(null), normalizeTokenUsage({}));
  assert.deepEqual(normalizeTokenUsage(undefined), normalizeTokenUsage({}));
  assert.deepEqual(normalizeTokenUsage(42), normalizeTokenUsage({}));
  assert.deepEqual(normalizeTokenUsage("garbage"), normalizeTokenUsage({}));
});

// ─── string parsing ───────────────────────────────────────────────────────────

test("string number parses to number", () => {
  const out = normalizeTokenUsage({ input_tokens: "1234" });
  assert.equal(out.input_tokens, 1234);
});

test("thousand-separated string parses correctly", () => {
  assert.equal(coerceToNonNegativeInt("1,234"), 1234);
  assert.equal(coerceToNonNegativeInt("1,234,567"), 1234567);
  assert.equal(coerceToNonNegativeInt("-1,234"), 0);  // negative snaps to 0
  assert.equal(coerceToNonNegativeInt("1,234.5"), 1234);  // decimals truncated
});

test("dirty concatenated string is rejected (not parsed as thousands)", () => {
  // Defense against the array.toString() / object.toString() pattern
  // ("true,false" / "7,29000000") — the root-cause shape from incident 2026-07-07.
  assert.equal(coerceToNonNegativeInt("7,29000000"), 0);
  assert.equal(coerceToNonNegativeInt("true,false"), 0);
  assert.equal(coerceToNonNegativeInt("1,2,3,4"), 0);  // irregular grouping
  assert.equal(coerceToNonNegativeInt(",123"), 0);  // leading comma
});

test("empty / whitespace strings → 0", () => {
  assert.equal(coerceToNonNegativeInt(""), 0);
  assert.equal(coerceToNonNegativeInt("   "), 0);
});

test("non-numeric string → 0", () => {
  assert.equal(coerceToNonNegativeInt("abc"), 0);
  assert.equal(coerceToNonNegativeInt("12abc"), 0);
});

test("parseNumericString unit cases", () => {
  assert.equal(parseNumericString("42"), 42);
  assert.equal(parseNumericString("1,234"), 1234);
  assert.equal(parseNumericString("not a number"), null);
});

// ─── array / object containers ────────────────────────────────────────────────

test("array input → first non-zero coerced element wins", () => {
  assert.equal(coerceToNonNegativeInt([7, 8, 9]), 7);
  assert.equal(coerceToNonNegativeInt([0, "100", 200]), 100);  // 0 skipped
  assert.equal(coerceToNonNegativeInt([null, undefined, "garbage"]), 0);
});

test("object input → canonical keys preferred, otherwise first numeric child", () => {
  assert.equal(coerceToNonNegativeInt({ input_tokens: 11, output_tokens: 22 }), 11);
  assert.equal(coerceToNonNegativeInt({ x: 99, y: 88 }), 99);
  assert.equal(coerceToNonNegativeInt({}), 0);
});

test("nested object with canonical keys at depth is found", () => {
  const out = coerceToNonNegativeInt({ wrapper: { input_tokens: 555 } });
  assert.equal(out, 555);
});

// ─── full-shape integration ───────────────────────────────────────────────────

test("full Claude Code transcript-style payload normalizes correctly", () => {
  // Shape mirrors the real `message.usage` field observed in
  // ~/.claude/projects/<slug>/<uuid>.jsonl — all four canonical fields present.
  const out = normalizeTokenUsage({
    input_tokens: 3,
    cache_creation_input_tokens: 20099,
    cache_read_input_tokens: 10659,
    output_tokens: 573,
  });
  assert.deepEqual(out, {
    input_tokens: 3,
    output_tokens: 573,
    cache_creation_input_tokens: 20099,
    cache_read_input_tokens: 10659,
    samples: 1,
  });
});

test("string-encoded payload normalizes to same shape as numeric", () => {
  const numeric = normalizeTokenUsage({ input_tokens: 100, output_tokens: 50 });
  const string = normalizeTokenUsage({ input_tokens: "100", output_tokens: "50" });
  assert.deepEqual(string, numeric);
});

test("thousand-separated payload normalizes correctly", () => {
  const out = normalizeTokenUsage({ input_tokens: "1,234,567", output_tokens: "12,345" });
  assert.equal(out.input_tokens, 1234567);
  assert.equal(out.output_tokens, 12345);
});

test("samples is always 1 — aggregator sums across calls, not within one", () => {
  assert.equal(normalizeTokenUsage({ input_tokens: 100 }).samples, 1);
  assert.equal(normalizeTokenUsage({ input_tokens: 100, samples: 999 }).samples, 1);
});

test("extra unknown fields are ignored, not surfaced", () => {
  const out = normalizeTokenUsage({ input_tokens: 10, magic: "foo", cost: 99 });
  assert.equal(out.input_tokens, 10);
  assert.equal(out.magic, undefined);
  assert.equal(out.cost, undefined);
});
