"use strict";

// ─── html-deck — zero-dep single-file HTML deck builder ──────────────────────
//
// P-003 /deck: produces a self-contained HTML page that renders as a slide
// deck in any browser. CSS controls one slide per page-break; print-to-PDF
// is a single keystroke away. No external fonts, no external images, no
// inline JS — the file is safe to email.
//
// Public surface:
//   buildHtmlDeck({ slides, meta, options? }) → string
//
// options:
//   theme  — 'default' | 'swiss' | 'magazine' (default: 'default')
//   cssInline — boolean (default true; if false, returns { html, css })

const DEFAULT_THEMES = {
  default: {
    bg: "#ffffff",
    fg: "#1d1d1f",
    accent: "#5b9bd5",
    muted: "#5b5b66",
    font: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
    serif: false,
  },
  swiss: {
    bg: "#f4f4f4",
    fg: "#111111",
    accent: "#d92626",
    muted: "#666666",
    font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    serif: false,
  },
  magazine: {
    bg: "#fbf7f1",
    fg: "#2a1f14",
    accent: "#7a3b1e",
    muted: "#6b5848",
    font: '"Georgia", "Times New Roman", "PingFang SC", serif',
    serif: true,
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSlide(slide, index, total, theme, meta) {
  const bullets = Array.isArray(slide.bullets)
    ? `<ul class="bullets">${slide.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
    : "";
  const body = slide.body ? `<div class="body">${escapeHtml(slide.body)}</div>` : "";
  const subtitle = slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : "";
  const page = `<div class="page-num">${index + 1} / ${total}</div>`;
  const footer = meta && meta.author ? `<div class="footer">${escapeHtml(meta.author)} · ${escapeHtml(meta.title || "")}</div>` : "";
  const notes = slide.notes ? `<aside class="notes"><strong>Speaker:</strong> ${escapeHtml(slide.notes)}</aside>` : "";

  return `<section class="slide" data-index="${index + 1}">
  <header class="slide-header">
    <h1 class="title">${escapeHtml(slide.title || "Untitled")}</h1>
    ${subtitle}
  </header>
  <div class="content">
    ${bullets}
    ${body}
  </div>
  ${notes}
  ${footer}
  ${page}
</section>`;
}

function renderCss(theme) {
  const t = DEFAULT_THEMES[theme] || DEFAULT_THEMES.default;
  const titleFamily = t.serif ? t.font : t.font;
  return `
:root {
  --bg: ${t.bg};
  --fg: ${t.fg};
  --accent: ${t.accent};
  --muted: ${t.muted};
  --font: ${t.font};
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--font); }
body { line-height: 1.5; }
.slide {
  width: 1280px;
  height: 720px;
  padding: 80px 96px;
  page-break-after: always;
  break-after: page;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: var(--bg);
  border-bottom: 1px solid rgba(0,0,0,0.08);
  overflow: hidden;
}
.slide:last-child { border-bottom: none; }
.slide-header { margin-bottom: 32px; }
.title {
  font-size: 56px;
  font-weight: 700;
  margin: 0 0 16px;
  letter-spacing: -0.01em;
  line-height: 1.1;
  color: var(--fg);
}
.subtitle {
  font-size: 28px;
  font-weight: 400;
  margin: 0;
  color: var(--muted);
}
.content { font-size: 24px; }
.bullets {
  list-style: none;
  padding: 0;
  margin: 0;
}
.bullets li {
  position: relative;
  padding: 12px 0 12px 36px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.bullets li:last-child { border-bottom: none; }
.bullets li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 22px;
  width: 12px;
  height: 12px;
  background: var(--accent);
  border-radius: 2px;
}
.body { font-size: 22px; color: var(--fg); }
.notes {
  position: absolute;
  bottom: 96px;
  left: 96px;
  right: 96px;
  padding: 16px 20px;
  background: rgba(0,0,0,0.04);
  border-left: 4px solid var(--accent);
  font-size: 14px;
  color: var(--muted);
  border-radius: 4px;
}
.footer {
  position: absolute;
  bottom: 32px;
  left: 96px;
  font-size: 12px;
  color: var(--muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.page-num {
  position: absolute;
  bottom: 32px;
  right: 96px;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
@media print {
  body { background: white; }
  .slide { border-bottom: none; }
}
@media (max-width: 720px) {
  .slide { width: 100vw; height: 100vh; padding: 32px 24px; }
  .title { font-size: 36px; }
  .subtitle { font-size: 18px; }
  .content, .body { font-size: 18px; }
  .footer, .page-num { font-size: 10px; left: 24px; right: 24px; bottom: 16px; }
  .notes { left: 24px; right: 24px; bottom: 56px; }
}
`.trim();
}

/**
 * Build a self-contained HTML page rendering all slides.
 * @param {{ slides: Array<object>, meta?: object, options?: object }} opts
 * @returns {string}
 */
function buildHtmlDeck(opts) {
  const slides = Array.isArray(opts && opts.slides) ? opts.slides : [];
  if (slides.length === 0) {
    throw new Error("buildHtmlDeck: at least one slide is required");
  }
  const meta = (opts && opts.meta) || {};
  const options = (opts && opts.options) || {};
  const theme = options.theme || "default";

  const css = renderCss(theme);
  const slidesHtml = slides
    .map((slide, i) => renderSlide(slide, i, slides.length, theme, meta))
    .join("\n");

  return `<!doctype html>
<html lang="${escapeHtml(meta.lang || "zh-CN")}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(meta.title || "Deck")}</title>
<meta name="author" content="${escapeHtml(meta.author || "")}"/>
<meta name="subject" content="${escapeHtml(meta.subject || "")}"/>
<meta name="generator" content="cortex-agent / P-003 /deck"/>
<style>${css}</style>
</head>
<body>
${slidesHtml}
</body>
</html>`;
}

module.exports = {
  buildHtmlDeck,
  // exposed for tests
  _internal: {
    renderSlide,
    renderCss,
    DEFAULT_THEMES,
    escapeHtml,
  },
};