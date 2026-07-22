"use strict";

// Coverage for the subagent-fanout-trace Phase 1 helper: matchFanoutTrigger.
// Validates the keyword table (zh + en) and the matching algorithm.

const assert = require("node:assert/strict");
const test = require("node:test");

const { matchFanoutTrigger, listKeywords, normalize } = require(
  "/Users/xueyq/myworks/cortex-agent/templates/_shared/.agent/skills/subagent-trace/scripts/match-trigger.js",
);

// ─── zh first ────────────────────────────────────────────────────────────

test("zh: '分发子任务' matches", () => {
  const r = matchFanoutTrigger("帮我分发子任务去查 normalize-token-usage");
  assert.equal(r.matched, true);
  assert.equal(r.language, "zh");
  assert.equal(r.matchedKeyword, "分发子任务");
});

test("zh: '并行 3 个 agent 调查' matches (subagent-fanout phrase)", () => {
  const r = matchFanoutTrigger("请并行 3 个 agent 调查这个");
  assert.equal(r.matched, true);
  assert.equal(r.language, "zh");
  assert.equal(r.matchedKeyword, "并行 3 个");
});

test("zh: 'fan out 中文' matches (mixed Chinese-English phrase)", () => {
  const r = matchFanoutTrigger("fan out 中文一下研究");
  assert.equal(r.matched, true);
  assert.equal(r.language, "zh");
  assert.equal(r.matchedKeyword, "fan out 中文");
});

test("zh: '派 3 个 agent' matches", () => {
  const r = matchFanoutTrigger("派 3 个 agent 去做 sanity check");
  assert.equal(r.matched, true);
  assert.equal(r.language, "zh");
  assert.equal(r.matchedKeyword, "派 3 个 agent");
});

test("zh: 'fàn chū' matches (pinyin form)", () => {
  const r = matchFanoutTrigger("fàn chū 一下");
  assert.equal(r.matched, true);
  assert.equal(r.language, "zh");
  assert.equal(r.matchedKeyword, "fàn chū");
});

// ─── en first ────────────────────────────────────────────────────────────

test("en: 'fan out' matches", () => {
  const r = matchFanoutTrigger("please fan out 3 agents to investigate this");
  assert.equal(r.matched, true);
  assert.equal(r.language, "en");
  assert.equal(r.matchedKeyword, "fan out");
});

test("en: 'fan-out' (hyphen) matches", () => {
  const r = matchFanoutTrigger("fan-out 3 subagents to check the docs");
  assert.equal(r.matched, true);
  assert.equal(r.language, "en");
  assert.equal(r.matchedKeyword, "fan-out");
});

test("en: 'subagent' matches even as substring", () => {
  const r = matchFanoutTrigger("let me spawn a subagent to do this");
  assert.equal(r.matched, true);
  assert.equal(r.language, "en");
});

test("en: 'parallel agents' matches", () => {
  const r = matchFanoutTrigger("run parallel agents on the security review");
  assert.equal(r.matched, true);
  assert.equal(r.language, "en");
});

// ─── case / whitespace robustness ─────────────────────────────────────────

test("en: case-insensitive (FAN OUT) matches", () => {
  const r = matchFanoutTrigger("FAN OUT 3 agents to look at this");
  assert.equal(r.matched, true);
  assert.equal(r.language, "en");
});

test("zh: case + whitespace + punctuation do not break match (smoke)", () => {
  // Verify a noisy Chinese phrase still matches; we don't try to span
  // artificial whitespace inside multi-char keywords (normalization
  // collapses *between* tokens but cannot join an inserted space *inside*
  // a 4-character keyword like 分发子任务).
  const r = matchFanoutTrigger("请 分发子任务!请尽快");
  assert.equal(r.matched, true);
  assert.equal(r.language, "zh");
});

// ─── negative cases ──────────────────────────────────────────────────────

test("non-trigger text: returns matched:false", () => {
  const r = matchFanoutTrigger("please fix the typo in doc/index.md");
  assert.equal(r.matched, false);
  assert.equal(r.language, null);
  assert.equal(r.matchedKeyword, null);
});

test("empty / null input: no throw, returns matched:false", () => {
  for (const v of ["", "   ", null, undefined]) {
    const r = matchFanoutTrigger(v);
    assert.equal(r.matched, false);
  }
});

// ─── helpers ────────────────────────────────────────────────────────────

test("listKeywords: en returns 6 keywords", () => {
  const r = listKeywords("en");
  assert.ok(Array.isArray(r.en));
  assert.equal(r.en.length, 6);
});

test("listKeywords: zh returns 10 keywords", () => {
  const r = listKeywords("zh");
  assert.ok(Array.isArray(r.zh));
  assert.equal(r.zh.length, 10);
});

test("listKeywords: no arg returns both", () => {
  const r = listKeywords();
  assert.ok(Array.isArray(r.en));
  assert.ok(Array.isArray(r.zh));
});

test("normalize collapses whitespace + trims", () => {
  assert.equal(normalize("  a   b  c  "), "a b c");
  assert.equal(normalize(""), "");
  assert.equal(normalize(null), "");
});
