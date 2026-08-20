"use strict";

// ─── open-design-deck-adapter — Open Design 产物 → /deck brief ───────────────
//
// Bridges the Open Design artifact chain:
//
//   Open Design 项目产物 (samhmi-editor.html / 任意 Open Design 渲染 HTML)
//     → openDesignHtmlToBrief(html)      [this module]
//     → deck-brief.json (cortex-agent deck <task-id> 的标准输入)
//     → lib/templates/{pptx,html-deck,md-deck}.js
//
// Input:  an Open Design rendered artifact — a self-contained HTML document
//         whose `<div class="screen">` contains `.ctl.card` control cards
//         (card-title + demo rows + notes), e.g. samhmi-editor.html produced
//         from HMI.sketch. See /tmp/samhmi-src/body.html for the reference DOM.
//
// Output: deck-brief.json schema consumed by lib/commands/deck.js:
//         { title, author, subject, lang, slides: [{title, subtitle?,
//           bullets?: string[], body?, notes?}] }
//
// Extraction rules (deterministic, no DOM library — zero npm deps):
//   - Screen overview block `.ov-head` (ov-title + ov-sub) → slide 1.
//   - Each `.ctl.card` control card → one slide: title = card-title,
//     bullets = visible text lines inside the card (demo rows, inputs, notes),
//     notes = source ctl id.
//   - Controls rendered as plain tags (button/demo/switch) contribute their
//     label text only — colors/layout stay in the original artifact.
//   - No screen/cards found → fall back to a single "text extract" slide.
//
// Zero npm deps. Pure functions (except openDesignHtmlFileToBrief).

const fs = require("node:fs");

const ENTITY_MAP = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decodeEntities(text) {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m, name) => {
    return ENTITY_MAP[`&${name};`] !== undefined ? ENTITY_MAP[`&${name};`] : m;
  });
}

/**
 * Strip a tag soup fragment into clean text lines (one per block element).
 * @param {string} fragment
 * @returns {string[]}
 */
function linesFromHtml(fragment) {
  return decodeEntities(
    fragment
      .replace(/<div[^>]*>/g, "\n")
      .replace(/<\/div>/g, "\n")
      .replace(/<span[^>]*>/g, " ")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Extract the screen overview heading (ov-title / ov-sub) from raw HTML.
 * @returns {{ title: string, sub: string } | null}
 */
function extractOverview(html) {
  const head = html.match(
    /<div class="ov-head"[^>]*>[\s\S]*?<div class="ov-title">([\s\S]*?)<\/div>[\s\S]*?<div class="ov-sub">([\s\S]*?)<\/div>/,
  );
  if (!head) return null;
  const title = linesFromHtml(head[1]).join(" ") || null;
  const sub = linesFromHtml(head[2]).join(" ") || null;
  return { title, sub };
}

/**
 * Split raw HTML into control-card records.
 * Each card body is truncated at the first structural boundary that follows a
 * card (overlay note / detail page / inspector / output / statusbar / app end),
 * so trailing chrome (output rows, statusbar) never leaks into a card.
 * @returns {Array<{ctl: string, html: string}>}
 */
function extractCards(html) {
  const noScript = html.replace(/<script[\s\S]*?<\/script>/g, "");
  const parts = noScript.split(/<div class="ctl card" data-ctl="([^"]+)"[^>]*>/);
  const CARDS_END = [
    '<div class="overlay-note',
    '<div class="detail-page',
    '<div class="inspector',
    '<div class="output',
    '<div class="statusbar',
  ];
  const cards = [];
  // parts[0] = leading html; then alternating [ctlId, cardBody]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    let body = parts[i + 1];
    let cut = -1;
    for (const marker of CARDS_END) {
      const idx = body.indexOf(marker);
      if (idx !== -1 && (cut === -1 || idx < cut)) cut = idx;
    }
    if (cut !== -1) body = body.slice(0, cut);
    cards.push({ ctl: parts[i], html: body });
  }
  return cards;
}

/**
 * Convert one control card fragment into a slide.
 */
function cardToSlide(card, index) {
  const titleLine = card.html.match(/<div class="card-title">([\s\S]*?)<\/div>/);
  const title = titleLine ? linesFromHtml(titleLine[1]).join(" ") : `控件 ${index + 1}`;
  const lines = linesFromHtml(card.html);
  // Drop the title line itself (already used as slide title).
  const bullets = lines.filter((l) => l !== title);
  const slide = { title };
  if (bullets.length > 0) slide.bullets = bullets;
  slide.notes = `Source: Open Design control card "${card.ctl}"`;
  return slide;
}

/**
 * Convert an Open Design rendered HTML artifact into a deck-brief.
 * @param {string} html   raw HTML document (e.g. samhmi-editor.html)
 * @param {object} [opts] { title?, author?, subject?, lang? }
 * @returns {object} deck-brief.json-compatible object
 */
function openDesignHtmlToBrief(html, opts) {
  opts = opts || {};
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error("open-design-deck-adapter: html must be a non-empty string");
  }

  const slides = [];
  const overview = extractOverview(html);
  if (overview && (overview.title || overview.sub)) {
    const s = { title: overview.title || "Open Design 设计总览" };
    if (overview.sub) s.subtitle = overview.sub;
    slides.push(s);
  }

  const cards = extractCards(html);
  cards.forEach((card, i) => slides.push(cardToSlide(card, i)));

  if (slides.length === 0) {
    // Fallback: whole-document text extract (works for any rendered HTML).
    const lines = linesFromHtml(html.replace(/<style[\s\S]*?<\/style>/g, ""));
    if (lines.length === 0) {
      throw new Error(
        "open-design-deck-adapter: no slides could be extracted from the HTML",
      );
    }
    slides.push({ title: "Open Design 产物文本摘要", bullets: lines.slice(0, 12) });
  }

  const docTitle =
    opts.title ||
    (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ||
    "Open Design artifact → deck";

  return {
    title: String(docTitle).trim(),
    author: opts.author || "cortex-agent",
    subject: opts.subject || "Imported from Open Design rendered artifact (HTML)",
    lang: opts.lang || "zh-CN",
    slides,
    _source: "open-design-html",
  };
}

/**
 * Read an Open Design HTML artifact file and convert it to a deck-brief.
 * @param {string} filePath
 * @param {object} [opts]
 * @returns {object} deck-brief
 */
function openDesignHtmlFileToBrief(filePath, opts) {
  let html;
  try {
    html = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `open-design-deck-adapter: cannot read ${filePath}: ${err.message}`,
    );
  }
  return openDesignHtmlToBrief(html, opts);
}

module.exports = {
  openDesignHtmlToBrief,
  openDesignHtmlFileToBrief,
  extractOverview,
  extractCards,
  cardToSlide,
  // exposed for tests
  _internal: { linesFromHtml, decodeEntities },
};