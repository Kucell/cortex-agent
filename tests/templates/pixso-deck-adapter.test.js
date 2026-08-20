"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  pixsoDslToBrief,
  pixsoDslFileToBrief,
  frameToSlide,
  collectTexts,
  _internal,
} = require("../../lib/templates/pixso-deck-adapter");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function textNode(id, name, content, fontSize, box) {
  return {
    id,
    type: "TEXT",
    name,
    text: { content, fontSize },
    box: box || { x: 0, y: 0, w: 100, h: 20 },
  };
}

function frameNode(id, name, children) {
  return {
    id,
    type: "FRAME",
    name,
    box: { x: 0, y: 0, w: 1440, h: 810 },
    children: children || [],
  };
}

function makeDsl(...roots) {
  return { stats: { nodes: roots.length }, roots, refsIndex: {} };
}

// ─── textContent tolerance ───────────────────────────────────────────────────

test("textContent: object form {content}", () => {
  assert.equal(_internal.textContent({ text: { content: "hi" } }), "hi");
});

test("textContent: bare string form", () => {
  assert.equal(_internal.textContent({ text: "hi" }), "hi");
});

test("textContent: missing text returns null", () => {
  assert.equal(_internal.textContent({}), null);
  assert.equal(_internal.textContent({ text: { fontSize: 12 } }), null);
});

test("isFrameLike: FRAME / CANVAS / SECTION yes; TEXT no", () => {
  assert.equal(_internal.isFrameLike({ type: "FRAME" }), true);
  assert.equal(_internal.isFrameLike({ type: "CANVAS" }), true);
  assert.equal(_internal.isFrameLike({ type: "SECTION" }), true);
  assert.equal(_internal.isFrameLike({ type: "TEXT" }), false);
  assert.equal(_internal.isFrameLike({}), false);
});

// ─── collectTexts ────────────────────────────────────────────────────────────

test("collectTexts: recursive over children, skips empty", () => {
  const frame = frameNode("1", "F", [
    textNode("2", "T1", "Hello", 40),
    textNode("3", "T2", "World", 20),
    frameNode("4", "Nested", [textNode("5", "T3", "Deep", 16)]),
    textNode("6", "Empty", "   ", 10),
  ]);
  const texts = collectTexts(frame);
  assert.equal(texts.length, 3);
  assert.deepEqual(
    texts.map((t) => t.content),
    ["Hello", "World", "Deep"],
  );
  assert.equal(texts[0].fontSize, 40);
});

// ─── frameToSlide ────────────────────────────────────────────────────────────

test("frameToSlide: title from largest text, subtitle from 2nd", () => {
  const frame = frameNode("f1", "Landing", [
    textNode("t1", "Title", "Product Name", 48),
    textNode("t2", "Sub", "One-line subtitle", 24),
  ]);
  const slide = frameToSlide(frame, 0);
  assert.equal(slide.title, "Product Name");
  assert.equal(slide.subtitle, "One-line subtitle");
});

test("frameToSlide: bullets from short texts, split on newline", () => {
  const frame = frameNode("f1", "Features", [
    textNode("t1", "Title", "Features", 40),
    textNode("t2", "B", "Fast\nSecure\nSimple", 16),
  ]);
  const slide = frameToSlide(frame, 0);
  assert.deepEqual(slide.bullets, ["Fast", "Secure", "Simple"]);
});

test("frameToSlide: body from long text (>80 chars)", () => {
  const long = "x".repeat(120);
  const frame = frameNode("f1", "About", [
    textNode("t1", "Title", "About", 40),
    textNode("t2", "P", long, 14),
  ]);
  const slide = frameToSlide(frame, 0);
  assert.equal(slide.body, long);
  assert.equal(slide.bullets, undefined);
});

test("frameToSlide: mixed bullets + body", () => {
  const long = "y".repeat(100);
  const frame = frameNode("f1", "Mixed", [
    textNode("t1", "Title", "Mixed", 40),
    textNode("t2", "B1", "short bullet", 14),
    textNode("t3", "P", long, 12),
  ]);
  const slide = frameToSlide(frame, 0);
  assert.deepEqual(slide.bullets, ["short bullet"]);
  assert.equal(slide.body, long);
});

test("frameToSlide: no text → title falls back to frame name", () => {
  const frame = frameNode("f1", "Untitled Slide", []);
  const slide = frameToSlide(frame, 3);
  assert.equal(slide.title, "Untitled Slide");
  assert.equal(slide.subtitle, undefined);
});

test("frameToSlide: notes carry source frame id", () => {
  const frame = frameNode("f9", "Debug", [textNode("t1", "T", "Hi", 40)]);
  const slide = frameToSlide(frame, 0);
  assert.match(slide.notes, /Pixso frame "Debug" \(id f9\)/);
});

// ─── pixsoDslToBrief ─────────────────────────────────────────────────────────

test("pixsoDslToBrief: one slide per top-level frame", () => {
  const dsl = makeDsl(
    frameNode("f1", "Landing", [textNode("t1", "T", "Landing", 48)]),
    frameNode("f2", "Pricing", [textNode("t2", "T", "Pricing", 48)]),
  );
  const brief = pixsoDslToBrief(dsl);
  assert.equal(brief.slides.length, 2);
  assert.equal(brief.slides[0].title, "Landing");
  assert.equal(brief.slides[1].title, "Pricing");
  assert.equal(brief.title, "Landing");
  assert.equal(brief.author, "cortex-agent");
  assert.equal(brief.lang, "zh-CN");
  assert.equal(brief._source, "pixso-dsl");
});

test("pixsoDslToBrief: respects opts overrides", () => {
  const dsl = makeDsl(frameNode("f1", "A", [textNode("t1", "T", "A", 48)]));
  const brief = pixsoDslToBrief(dsl, {
    title: "My Deck",
    author: "eric",
    subject: "Q3 review",
    lang: "en",
  });
  assert.equal(brief.title, "My Deck");
  assert.equal(brief.author, "eric");
  assert.equal(brief.subject, "Q3 review");
  assert.equal(brief.lang, "en");
});

test("pixsoDslToBrief: no frames → single slide from first root", () => {
  const dsl = makeDsl(textNode("t1", "Solo", "Just a text node", 24));
  const brief = pixsoDslToBrief(dsl);
  assert.equal(brief.slides.length, 1);
  assert.equal(brief.slides[0].title, "Just a text node");
});

test("pixsoDslToBrief: empty roots throws", () => {
  assert.throws(() => pixsoDslToBrief({ roots: [] }), /non-empty roots\[\]/);
});

test("pixsoDslToBrief: non-object dsl throws", () => {
  assert.throws(() => pixsoDslToBrief(null), /dsl must be an object/);
  assert.throws(() => pixsoDslToBrief({}), /non-empty roots\[\]/);
  assert.throws(() => pixsoDslToBrief({ roots: "nope" }), /non-empty roots\[\]/);
});

// ─── pixsoDslFileToBrief ─────────────────────────────────────────────────────

test("pixsoDslFileToBrief: reads JSON file and converts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-adapter-"));
  try {
    const file = path.join(dir, "dsl.json");
    fs.writeFileSync(
      file,
      JSON.stringify(
        makeDsl(frameNode("f1", "Hero", [textNode("t1", "T", "Hello", 48)])),
      ),
      "utf8",
    );
    const brief = pixsoDslFileToBrief(file);
    assert.equal(brief.slides.length, 1);
    assert.equal(brief.slides[0].title, "Hello");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pixsoDslFileToBrief: missing file throws", () => {
  assert.throws(
    () => pixsoDslFileToBrief("/nonexistent/dsl.json"),
    /cannot read/,
  );
});

test("pixsoDslFileToBrief: malformed JSON throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixso-adapter-"));
  try {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{ not json", "utf8");
    assert.throws(() => pixsoDslFileToBrief(file), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── End-to-end: adapter output feeds lib/templates/pptx.js ─────────────────

test("E2E: adapter brief → buildPptx produces a valid PPTX buffer", () => {
  const { buildPptx } = require("../../lib/templates/pptx");
  const dsl = makeDsl(
    frameNode("f1", "Landing", [
      textNode("t1", "T", "Acme Product", 48),
      textNode("t2", "S", "Launching Q3", 24),
    ]),
    frameNode("f2", "Features", [
      textNode("t3", "T", "Features", 40),
      textNode("t4", "B", "Fast\nReliable\nOpen-source", 16),
    ]),
  );
  const brief = pixsoDslToBrief(dsl);
  const buffer = buildPptx({
    slides: brief.slides,
    meta: { title: brief.title, author: brief.author, subject: brief.subject },
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
  // PPTX magic bytes: PK\x03\x04
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  assert.equal(buffer[2], 0x03);
  assert.equal(buffer[3], 0x04);
});