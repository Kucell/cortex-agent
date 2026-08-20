"use strict";

// ─── pixso-deck-adapter — Pixso DSL → /deck brief (路径 B:画稿 → 演示文稿) ──
//
// Bridges the Pixso design-to-deck chain:
//
//   Pixso 稿 (get_node_dsl compact output)
//     → pixsoDslToBrief(dsl)      [this module]
//     → deck-brief.json (cortex-agent deck <task-id> 的标准输入)
//     → lib/templates/{pptx,html-deck,md-deck}.js
//
// Input:  the compact DSL returned by Pixso desktop MCP `get_node_dsl`, i.e.
//         { stats?, roots: [node], refsIndex? } — see
//         ~/.agent/skills/pixso-read-dsl/references/compact-dsl.md
//
// Output: deck-brief.json schema consumed by lib/commands/deck.js:
//         { title, author, subject, lang, slides: [{title, subtitle?,
//           bullets?: string[], body?, notes?}] }
//
// Extraction heuristics (deterministic, order-independent):
//   - Each top-level FRAME/CANVAS/SECTION node under `roots` becomes one slide.
//   - Within a frame, TEXT nodes are collected recursively and sorted by
//     font size descending:
//       1st (largest)  → slide.title
//       2nd            → slide.subtitle
//       remainder      → bullets[] when short (≤ 80 chars) or multi-line
//                        (split on \n, one per line), else slide.body.
//   - A frame with no text still produces a slide titled by its node name.
//   - No frames at all → a single slide titled by the first root (or a fallback).
//
// Zero npm deps. Pure functions (no I/O except pixsoDslFileToBrief).

const fs = require("node:fs");

const SHORT_TEXT_CHARS = 80;
// Subtitle heuristic: a text node is a subtitle only when it is single-line,
// short, and reasonably large (≥ 20px). Multi-line lists and small body text
// fall through to bullets/body.
const SUBTITLE_MIN_FONT_SIZE = 20;

function isFrameLike(node) {
  const type = String((node && node.type) || "").toUpperCase();
  return type === "FRAME" || type === "CANVAS" || type === "SECTION";
}

function isTextLike(node) {
  const type = String((node && node.type) || "").toUpperCase();
  return type === "TEXT";
}

/**
 * Extract text content from a node's `text` field, tolerating both
 * `{ content: "..." }` (compact DSL) and a bare string.
 */
function textContent(node) {
  const t = node && node.text;
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && typeof t.content === "string") return t.content;
  return null;
}

/**
 * Collect every TEXT node (recursively) under a subtree.
 * @returns {Array<{content: string, fontSize: number, x: number, y: number, w: number, h: number}>}
 */
function collectTexts(node, out) {
  out = out || [];
  if (!node || typeof node !== "object") return out;
  if (isTextLike(node)) {
    const content = textContent(node);
    if (content && content.trim().length > 0) {
      out.push({
        content: content.trim(),
        fontSize: Number((node.text && node.text.fontSize) || 0),
        x: Number((node.box && node.box.x) || 0),
        y: Number((node.box && node.box.y) || 0),
        w: Number((node.box && node.box.w) || 0),
        h: Number((node.box && node.box.h) || 0),
      });
    }
  }
  for (const child of node.children || []) {
    collectTexts(child, out);
  }
  return out;
}

function isSubtitleCandidate(t) {
  return (
    !t.content.includes("\n") &&
    t.content.length <= SHORT_TEXT_CHARS &&
    t.fontSize >= SUBTITLE_MIN_FONT_SIZE
  );
}

/**
 * Convert one frame node into a slide object.
 * @param {object} frame
 * @param {number} index
 * @returns {object} slide ({ title, subtitle?, bullets?, body?, notes? })
 */
function frameToSlide(frame, index) {
  const slide = { title: (frame && frame.name) || `Slide ${index + 1}` };
  const texts = collectTexts(frame).sort((a, b) => b.fontSize - a.fontSize);

  let cursor = 0;
  if (texts.length > 0) {
    slide.title = texts[0].content || slide.title;
    cursor = 1;
  }
  if (cursor < texts.length && isSubtitleCandidate(texts[cursor])) {
    slide.subtitle = texts[cursor].content;
    cursor += 1;
  }

  const bullets = [];
  const bodies = [];
  for (const t of texts.slice(cursor)) {
    if (t.content.includes("\n") || t.content.length <= SHORT_TEXT_CHARS) {
      for (const line of t.content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) bullets.push(trimmed);
      }
    } else {
      bodies.push(t.content);
    }
  }
  if (bullets.length > 0) slide.bullets = bullets;
  if (bodies.length > 0) slide.body = bodies.join("\n\n");

  // Speaker notes: frame name + node id for traceability.
  if (frame && frame.id) {
    slide.notes = `Source: Pixso frame "${frame.name || ""}" (id ${frame.id})`;
  }
  return slide;
}

/**
 * Convert a compact Pixso DSL document into a deck-brief.
 * @param {object} dsl   { roots: [...], refsIndex?: {...} } (get_node_dsl output)
 * @param {object} [opts] { title?, author?, subject?, lang? }
 * @returns {object} deck-brief.json-compatible object
 */
function pixsoDslToBrief(dsl, opts) {
  opts = opts || {};
  if (!dsl || typeof dsl !== "object" || !Array.isArray(dsl.roots) || dsl.roots.length === 0) {
    throw new Error(
      "pixso-deck-adapter: dsl must be an object with a non-empty roots[] array " +
      "(get_node_dsl compact output)",
    );
  }
  const roots = dsl.roots;
  const frames = roots.filter(isFrameLike);

  let slides;
  if (frames.length > 0) {
    slides = frames.map((f, i) => frameToSlide(f, i));
  } else {
    // No frame nodes — fall back to first root (may itself be a text/section).
    const firstRoot = roots[0];
    slides = [frameToSlide(firstRoot, 0)];
  }

  const firstTitle =
    opts.title ||
    (frames[0] && frames[0].name) ||
    (roots[0] && roots[0].name) ||
    "Pixso design → deck";

  return {
    title: firstTitle,
    author: opts.author || "cortex-agent",
    subject: opts.subject || "Imported from Pixso design (get_node_dsl)",
    lang: opts.lang || "zh-CN",
    slides,
    _source: "pixso-dsl",
  };
}

/**
 * Read a JSON file holding a Pixso compact DSL and convert it to a deck-brief.
 * @param {string} filePath
 * @param {object} [opts]
 * @returns {object} deck-brief
 */
function pixsoDslFileToBrief(filePath, opts) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`pixso-deck-adapter: cannot read ${filePath}: ${err.message}`);
  }
  let dsl;
  try {
    dsl = JSON.parse(raw);
  } catch (err) {
    throw new Error(`pixso-deck-adapter: ${filePath} is not valid JSON: ${err.message}`);
  }
  return pixsoDslToBrief(dsl, opts);
}

module.exports = {
  pixsoDslToBrief,
  pixsoDslFileToBrief,
  frameToSlide,
  collectTexts,
  // exposed for tests
  _internal: { isFrameLike, isTextLike, textContent, SHORT_TEXT_CHARS, SUBTITLE_MIN_FONT_SIZE, isSubtitleCandidate },
};