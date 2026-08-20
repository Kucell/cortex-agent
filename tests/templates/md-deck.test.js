"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMdDeck } = require("../../lib/templates/md-deck");

test("buildMdDeck: requires at least one slide", () => {
  assert.throws(() => buildMdDeck({ slides: [] }), /at least one slide/);
});

test("buildMdDeck: produces a top-level H1 title", () => {
  const md = buildMdDeck({
    slides: [{ title: "A" }],
    meta: { title: "Demo", author: "alice" },
  });
  assert.match(md, /^# Demo$/m);
  assert.match(md, /> Author: alice/);
});

test("buildMdDeck: each slide becomes an H2 section", () => {
  const md = buildMdDeck({
    slides: [{ title: "First" }, { title: "Second" }, { title: "Third" }],
  });
  assert.match(md, /^## 1\. First$/m);
  assert.match(md, /^## 2\. Second$/m);
  assert.match(md, /^## 3\. Third$/m);
});

test("buildMdDeck: bullets render with leading hyphen", () => {
  const md = buildMdDeck({
    slides: [{ title: "T", bullets: ["a", "b"] }],
  });
  assert.match(md, /^- a$/m);
  assert.match(md, /^- b$/m);
});

test("buildMdDeck: body renders as plain paragraph", () => {
  const md = buildMdDeck({
    slides: [{ title: "T", body: "Free text here" }],
  });
  assert.match(md, /^Free text here$/m);
});

test("buildMdDeck: speaker notes rendered as blockquote", () => {
  const md = buildMdDeck({
    slides: [{ title: "T", notes: "Pause for 5s" }],
  });
  assert.match(md, /> \*\*Speaker notes:\*\* Pause for 5s/);
});

test("buildMdDeck: subtitle renders as italic", () => {
  const md = buildMdDeck({
    slides: [{ title: "T", subtitle: "Sub" }],
  });
  assert.match(md, /^\*Sub\*$/m);
});

test("buildMdDeck: includes slide count summary", () => {
  const md = buildMdDeck({
    slides: [{ title: "A" }, { title: "B" }],
  });
  assert.match(md, /Total slides: 2/);
});

test("buildMdDeck: handles CJK + special chars", () => {
  const md = buildMdDeck({
    slides: [{ title: "中文标题", bullets: ["中|文", "<ok>"] }],
    meta: { title: "Cortex | design chain" },
  });
  // pipes are escaped for tables
  assert.match(md, /Cortex \\| design chain/);
  assert.match(md, /中\\|文/);
});

test("buildMdDeck: speaker notes blockquote works with CJK", () => {
  const md = buildMdDeck({
    slides: [{ title: "T", notes: "中文备注 | 测试" }],
  });
  assert.match(md, /> \*\*Speaker notes:\*\* 中文备注 \\| 测试/);
});