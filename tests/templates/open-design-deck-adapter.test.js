"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  openDesignHtmlToBrief,
  openDesignHtmlFileToBrief,
  extractOverview,
  extractCards,
  cardToSlide,
  _internal,
} = require("../../lib/templates/open-design-deck-adapter");

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MINIMAL_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><title>SamHMI 画面编辑器</title></head><body>
<div class="app">
  <div class="screen">
    <div class="ov-head">
      <div class="ov-title">五个试点控件设计总览 v0.1</div>
      <div class="ov-sub">统一视觉语言、状态语义与右侧工作台结构</div>
    </div>
    <div class="ctl card" data-ctl="rectangle" style="left:42px;top:96px">
      <div class="card-title">矩形 / Rectangle</div>
      <div class="card-row" style="left:24px;top:68px">
        <button class="demo-btn primary">填充</button>
        <button class="demo-btn ghost">描边</button>
      </div>
      <div class="card-note" style="top:134px">默认 / 描边 / 编辑器选中态</div>
    </div>
    <div class="ctl card" data-ctl="text" style="left:447px;top:96px">
      <div class="card-title">文本 / Text</div>
      <div class="card-label" style="top:60px">内容与排版</div>
      <div class="card-input" style="top:84px">运行状态 · Noto Sans SC 14</div>
    </div>
  </div>
</div>
<script>const x = 1;</script>
</body></html>`;

// ─── _internal.linesFromHtml ─────────────────────────────────────────────────

test("linesFromHtml: strips tags, one line per block, decodes entities", () => {
  const lines = _internal.linesFromHtml(
    '<div class="card-title">矩形 / Rectangle</div><div class="card-note">默认 / 描边 &amp; 选中态</div>',
  );
  assert.deepEqual(lines, ["矩形 / Rectangle", "默认 / 描边 & 选中态"]);
});

test("linesFromHtml: collapses whitespace and drops empties", () => {
  const lines = _internal.linesFromHtml(
    '<div class="a">  a   b </div><div></div><span>c</span>',
  );
  assert.deepEqual(lines, ["a b", "c"]);
});

test("linesFromHtml: handles <br> as line break", () => {
  const lines = _internal.linesFromHtml("<div>x<br>y</div>");
  assert.deepEqual(lines, ["x", "y"]);
});

test("decodeEntities: maps common entities", () => {
  assert.equal(_internal.decodeEntities("a&amp;b&lt;c&gt;d&quot;e&nbsp;f&#39;g"), "a&b<c>d\"e f'g");
});

// ─── extractOverview ─────────────────────────────────────────────────────────

test("extractOverview: returns title + sub", () => {
  const ov = extractOverview(MINIMAL_HTML);
  assert.equal(ov.title, "五个试点控件设计总览 v0.1");
  assert.equal(ov.sub, "统一视觉语言、状态语义与右侧工作台结构");
});

test("extractOverview: returns null when absent", () => {
  assert.equal(extractOverview("<html><body>no overview</body></html>"), null);
});

// ─── extractCards ────────────────────────────────────────────────────────────

test("extractCards: finds all .ctl.card with data-ctl", () => {
  const cards = extractCards(MINIMAL_HTML);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].ctl, "rectangle");
  assert.equal(cards[1].ctl, "text");
  assert.match(cards[0].html, /矩形/);
});

test("extractCards: strips <script> blocks first", () => {
  const cards = extractCards(MINIMAL_HTML);
  assert.equal(cards.some((c) => c.html.includes("const x")), false);
});

test("extractCards: empty when no cards", () => {
  assert.equal(extractCards("<html>nothing</html>").length, 0);
});

// ─── cardToSlide ─────────────────────────────────────────────────────────────

test("cardToSlide: title from card-title, bullets from visible lines", () => {
  const cards = extractCards(MINIMAL_HTML);
  const slide = cardToSlide(cards[0], 0);
  assert.equal(slide.title, "矩形 / Rectangle");
  assert.deepEqual(slide.bullets, ["填充", "描边", "默认 / 描边 / 编辑器选中态"]);
  assert.match(slide.notes, /rectangle/);
});

test("cardToSlide: no card-title → fallback title", () => {
  const slide = cardToSlide({ ctl: "x", html: "<div class='card-note'>hi</div>" }, 2);
  assert.equal(slide.title, "控件 3");
  assert.deepEqual(slide.bullets, ["hi"]);
});

test("cardToSlide: no text lines → no bullets", () => {
  const slide = cardToSlide({ ctl: "x", html: '<div class="card-title">Only</div>' }, 0);
  assert.equal(slide.title, "Only");
  assert.equal(slide.bullets, undefined);
});

// ─── openDesignHtmlToBrief ───────────────────────────────────────────────────

test("openDesignHtmlToBrief: overview slide + one slide per card", () => {
  const brief = openDesignHtmlToBrief(MINIMAL_HTML);
  assert.equal(brief.slides.length, 3); // overview + 2 cards
  assert.equal(brief.slides[0].title, "五个试点控件设计总览 v0.1");
  assert.equal(brief.slides[0].subtitle, "统一视觉语言、状态语义与右侧工作台结构");
  assert.equal(brief.slides[1].title, "矩形 / Rectangle");
  assert.equal(brief.slides[2].title, "文本 / Text");
  assert.equal(brief.title, "SamHMI 画面编辑器");
  assert.equal(brief.author, "cortex-agent");
  assert.equal(brief.lang, "zh-CN");
  assert.equal(brief._source, "open-design-html");
});

test("openDesignHtmlToBrief: respects opts overrides", () => {
  const brief = openDesignHtmlToBrief(MINIMAL_HTML, {
    title: "My Deck",
    author: "eric",
    lang: "en",
  });
  assert.equal(brief.title, "My Deck");
  assert.equal(brief.author, "eric");
  assert.equal(brief.lang, "en");
});

test("openDesignHtmlToBrief: no overview → slides start with cards", () => {
  const html = `<html><body><div class="ctl card" data-ctl="a"><div class="card-title">A</div></div></body></html>`;
  const brief = openDesignHtmlToBrief(html);
  assert.equal(brief.slides.length, 1);
  assert.equal(brief.slides[0].title, "A");
});

test("openDesignHtmlToBrief: no cards and no overview → text-extract fallback", () => {
  const html = `<html><head><title>T</title></head><body><div>hello world</div></body></html>`;
  const brief = openDesignHtmlToBrief(html);
  assert.equal(brief.slides.length, 1);
  assert.equal(brief.slides[0].title, "Open Design 产物文本摘要");
  assert.ok(brief.slides[0].bullets.includes("hello world"));
});

test("openDesignHtmlToBrief: empty html throws", () => {
  assert.throws(() => openDesignHtmlToBrief(""), /non-empty string/);
  assert.throws(() => openDesignHtmlToBrief("   "), /non-empty string/);
  assert.throws(() => openDesignHtmlToBrief(null), /non-empty string/);
});

test("openDesignHtmlToBrief: style block excluded from fallback text", () => {
  const html = `<html><body><style>body{color:red}</style><div>visible</div></body></html>`;
  const brief = openDesignHtmlToBrief(html);
  assert.ok(!brief.slides[0].bullets.join(" ").includes("color:red"));
  assert.ok(brief.slides[0].bullets.includes("visible"));
});

// ─── openDesignHtmlFileToBrief ───────────────────────────────────────────────

test("openDesignHtmlFileToBrief: reads file and converts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-adapter-"));
  try {
    const file = path.join(dir, "artifact.html");
    fs.writeFileSync(file, MINIMAL_HTML, "utf8");
    const brief = openDesignHtmlFileToBrief(file);
    assert.equal(brief.slides.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openDesignHtmlFileToBrief: missing file throws", () => {
  assert.throws(
    () => openDesignHtmlFileToBrief("/nonexistent/x.html"),
    /cannot read/,
  );
});

// ─── E2E: adapter output feeds buildPptx ─────────────────────────────────────

test("E2E: brief → buildPptx produces valid PPTX", () => {
  const { buildPptx } = require("../../lib/templates/pptx");
  const brief = openDesignHtmlToBrief(MINIMAL_HTML);
  const buffer = buildPptx({
    slides: brief.slides,
    meta: { title: brief.title, author: brief.author, subject: brief.subject },
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  assert.equal(buffer[2], 0x03);
  assert.equal(buffer[3], 0x04);
});