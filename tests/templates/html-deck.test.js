"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHtmlDeck, _internal } = require("../../lib/templates/html-deck");

// ─── buildHtmlDeck ──────────────────────────────────────────────────────────

test("buildHtmlDeck: requires at least one slide", () => {
  assert.throws(() => buildHtmlDeck({ slides: [] }), /at least one slide/);
});

test("buildHtmlDeck: produces a complete HTML document", () => {
  const html = buildHtmlDeck({
    slides: [{ title: "Hello" }],
    meta: { title: "Test", author: "alice" },
  });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>$/);
  assert.match(html, /<title>Test<\/title>/);
  assert.match(html, /<h1 class="title">Hello<\/h1>/);
});

test("buildHtmlDeck: page-num reflects index / total", () => {
  const html = buildHtmlDeck({
    slides: [
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ],
  });
  assert.match(html, /<div class="page-num">1 \/ 3<\/div>/);
  assert.match(html, /<div class="page-num">3 \/ 3<\/div>/);
});

test("buildHtmlDeck: bullets render as <li>", () => {
  const html = buildHtmlDeck({
    slides: [{ title: "T", bullets: ["one", "two", "three"] }],
  });
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<li>two<\/li>/);
  assert.match(html, /<li>three<\/li>/);
});

test("buildHtmlDeck: body renders when no bullets", () => {
  const html = buildHtmlDeck({
    slides: [{ title: "T", body: "Free text body" }],
  });
  assert.match(html, /<div class="body">Free text body<\/div>/);
  assert.doesNotMatch(html, /<ul class="bullets">/);
});

test("buildHtmlDeck: speaker notes appear in <aside class=\"notes\">", () => {
  const html = buildHtmlDeck({
    slides: [{ title: "T", notes: "Remember to pause here" }],
  });
  assert.match(html, /<aside class="notes">/);
  assert.match(html, /Remember to pause here/);
});

test("buildHtmlDeck: escapes HTML special chars", () => {
  const html = buildHtmlDeck({
    slides: [{ title: "<script>&\"'</script>", bullets: ["<bad>"] }],
  });
  assert.doesNotMatch(html, /<script>&/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;bad&gt;/);
});

test("buildHtmlDeck: handles CJK titles", () => {
  const html = buildHtmlDeck({
    slides: [{ title: "中文标题", bullets: ["中文要点"] }],
  });
  assert.match(html, /中文标题/);
  assert.match(html, /中文要点/);
});

test("buildHtmlDeck: all 3 themes compile without throwing", () => {
  for (const theme of ["default", "swiss", "magazine"]) {
    const html = buildHtmlDeck({
      slides: [{ title: "T" }],
      options: { theme },
    });
    assert.ok(html.length > 500, `${theme} theme should produce HTML`);
  }
});

test("buildHtmlDeck: page-break CSS present for print", () => {
  const html = buildHtmlDeck({ slides: [{ title: "T" }] });
  assert.match(html, /page-break-after: always/);
  assert.match(html, /@media print/);
});

test("buildHtmlDeck: footer only present when author is set", () => {
  const withAuthor = buildHtmlDeck({
    slides: [{ title: "T" }],
    meta: { author: "alice", title: "X" },
  });
  const noAuthor = buildHtmlDeck({ slides: [{ title: "T" }] });
  assert.match(withAuthor, /<div class="footer">/);
  assert.doesNotMatch(noAuthor, /<div class="footer">/);
});

// ─── internal helpers ───────────────────────────────────────────────────────

test("_internal: escapeHtml handles all 5 entities", () => {
  const e = _internal.escapeHtml;
  assert.equal(e("<"), "&lt;");
  assert.equal(e(">"), "&gt;");
  assert.equal(e("&"), "&amp;");
  assert.equal(e('"'), "&quot;");
  assert.equal(e("'"), "&#39;");
  assert.equal(e(null), "");
});

test("_internal: 3 themes registered", () => {
  assert.equal(Object.keys(_internal.DEFAULT_THEMES).length, 3);
  assert.ok(_internal.DEFAULT_THEMES.default);
  assert.ok(_internal.DEFAULT_THEMES.swiss);
  assert.ok(_internal.DEFAULT_THEMES.magazine);
});