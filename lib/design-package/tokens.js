"use strict";

// ─── tokens — derive brand tokens + brand-spec.md from design-scene.v1 ──────
//
// MS-2: all renderer-facing helpers now consume the neutral scene schema
// (`design-scene.v1`) instead of the Pixso DSL directly. Pixso DSL stays
// supported through `pixsoToScene()` from the adapter layer, so legacy
// callers can keep passing raw DSL objects — they will be auto-converted.
//
// Deterministic, order-independent extraction:
//   - Walk every scene node recursively.
//   - Collect solid fill colors (rgba(...) → #rrggbb).
//   - Collect font families + sizes.
//   - Collect the root canvas dimensions for the brand spec.
//
// The result feeds both the SamHMI HTML renderer and brand-spec.md.
// No npm deps, no I/O.

const COLOR_ALIASES = Object.freeze({
  "#2F6DEB": "accent",
  "#2E9DFF": "brand",
  "#3070FF": "tabline",
  "#396CEC": "selbg",
  "#22A06B": "ok",
  "#D98B00": "warn",
  "#D94F4F": "alert",
  "#B1BBC8": "off",
  "#DCE2EA": "track",
  "#1F2D41": "fg",
  "#5A6675": "muted",
  "#CAD7E7": "canvas",
  "#F4F7FA": "ruler",
  "#E1E8F1": "ruler-edge",
  "#E2E7EF": "screen-bg",
  "#FAFAFA": "bg",
  "#FFFFFF": "surface",
  "#F8FAFC": "card",
  "#FAFBFC": "outbar",
  "#F5F7F9": "statbar",
  "#9AA6B8": "input-border",
});

function clampByte(value) {
  const n = Math.round(Number(value));
  return Math.max(0, Math.min(255, n));
}

// Convert "rgba(r,g,b,a)" / "rgb(r,g,b)" to "#rrggbb" (alpha dropped).
function rgbaToHex(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!match) return null;
  const r = clampByte(match[1]);
  const g = clampByte(match[2]);
  const b = clampByte(match[3]);
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return hex;
}

// Detect whether an input is a design-scene.v1 scene or a raw DSL root.
// A scene has `schemaVersion`; a DSL root has `roots[]` and is fed through
// the Pixso adapter.
function ensureScene(input) {
  if (!input || typeof input !== "object") return input;
  if (input.schemaVersion === "design-scene.v1") return input;
  if (Array.isArray(input.roots)) {
    // Lazy require to avoid a hard module load-order dependency.
    const { pixsoToScene } = require("./adapter/pixso");
    return pixsoToScene(input);
  }
  return input;
}

function isFillNode(node) {
  // design-scene.v1 stores fills as `style.fill` (string).
  if (node && typeof node.style === "object" && typeof node.style.fill === "string") {
    return node.style.fill !== "transparent";
  }
  return node && Array.isArray(node.fills) && node.fills.length > 0;
}

function fillValue(node) {
  if (node && typeof node.style === "object" && typeof node.style.fill === "string") {
    return node.style.fill;
  }
  return null;
}

function nodeFont(node) {
  // Prefer design-scene.v1 content block.
  if (node && node.content && typeof node.content === "object") {
    const family = typeof node.content.fontFamily === "string" ? node.content.fontFamily : null;
    const size = typeof node.content.fontSize === "number" ? node.content.fontSize : null;
    if (!family && size === null) return null;
    return { family, size, style: null, weight: null };
  }
  const t = node && node.text;
  if (!t || typeof t !== "object") return null;
  const family = typeof t.fontFamily === "string" ? t.fontFamily : null;
  const size = typeof t.fontSize === "number" ? t.fontSize : null;
  const style = typeof t.fontStyle === "string" ? t.fontStyle : null;
  const weight = typeof t.fontWeight === "number" ? t.fontWeight : null;
  if (!family && size === null) return null;
  return { family, size, style, weight };
}

function nodeTextContent(sceneNode) {
  if (!sceneNode || typeof sceneNode !== "object") return null;
  if (sceneNode.content && typeof sceneNode.content.text === "string") return sceneNode.content.text;
  const t = sceneNode.text;
  if (!t || typeof t !== "object") return null;
  if (typeof t.content === "string") return t.content;
  return null;
}

// ─── public extraction ────────────────────────────────────────────────────────

// Collect all hex colors + font families/sizes in the scene (deduped, stable order).
// Accepts either design-scene.v1 or a raw Pixso DSL (auto-converted).
function extractTokens(input) {
  const scene = ensureScene(input);
  const colors = new Set();
  const fontFamilies = new Set();
  const fontSizes = new Set();

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (isFillNode(node)) {
      const rawFill = fillValue(node);
      if (rawFill) {
        const hex = rgbaToHex(rawFill);
        if (hex) colors.add(hex);
      } else if (Array.isArray(node.fills)) {
        for (const fill of node.fills) {
          if (fill && fill.type === "solid" && fill.value) {
            const hex = rgbaToHex(fill.value);
            if (hex) colors.add(hex);
          }
        }
      }
    }
    const font = nodeFont(node);
    if (font) {
      if (font.family) fontFamilies.add(font.family);
      if (font.size !== null) fontSizes.add(font.size);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }
  if (scene && Array.isArray(scene.nodes)) {
    for (const node of scene.nodes) walk(node);
  }
  return {
    colors: [...colors],
    fontFamilies: [...fontFamilies],
    fontSizes: [...fontSizes].sort((a, b) => a - b),
  };
}

// Root canvas dims: from scene.canvas (design-scene.v1) or first DSL root box, fallback 1920×1080.
function rootCanvas(input) {
  const scene = ensureScene(input);
  if (scene && scene.canvas && scene.canvas.width && scene.canvas.height) {
    return { w: Number(scene.canvas.width), h: Number(scene.canvas.height) };
  }
  const root = input && input.roots && input.roots[0];
  if (root && root.box && root.box.w && root.box.h) {
    return { w: Number(root.box.w), h: Number(root.box.h) };
  }
  return { w: 1920, h: 1080 };
}

// Collect all top-level named children of roots (for the project-tree).
function rootChildren(input) {
  const scene = ensureScene(input);
  const out = [];
  if (scene && Array.isArray(scene.nodes)) {
    const roots = scene.nodes.filter((n) => n.depth === 0);
    for (const root of roots) {
      for (const node of scene.nodes) {
        if (node.parentId === root.id && typeof node.name === "string") {
          out.push({ id: node.id, name: node.name, type: node.type });
        }
      }
    }
    return out;
  }
  for (const root of input && input.roots || []) {
    for (const child of root.children || []) {
      if (child && typeof child.name === "string") {
        out.push({ id: child.id || "", name: child.name, type: child.type || "" });
      }
    }
  }
  return out;
}

// Collect short text labels for the SamHMI HTML demo content.
function textLabels(input) {
  const scene = ensureScene(input);
  const labels = [];
  function walk(node, depth) {
    if (!node || typeof node !== "object") return;
    const content = nodeTextContent(node);
    if (content && content.trim()) labels.push({ text: content.trim(), depth });
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  }
  if (scene && Array.isArray(scene.nodes)) {
    // Scene nodes already carry global geometry and may not include children.
    // We can still pick up text content via `content.text`.
    for (const node of scene.nodes) {
      const text = node.content && typeof node.content.text === "string" ? node.content.text : null;
      if (text && text.trim()) labels.push({ text: text.trim(), depth: node.depth });
    }
  } else {
    for (const root of input && input.roots || []) walk(root, 0);
  }
  // Dedup, cap at 200 for safety, stable order.
  const seen = new Set();
  const out = [];
  for (const item of labels) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    out.push(item);
    if (out.length >= 200) break;
  }
  return out;
}

// Build a flat brand-token object consumed by the HTML renderer.
function buildBrandTokens(input, opts) {
  opts = opts || {};
  const tokens = extractTokens(input);
  const canvas = rootCanvas(input);
  const colors = tokens.colors.length > 0 ? tokens.colors : ["#CAD7E7", "#FFFFFF"];
  const font = tokens.fontFamilies[0] || "Noto Sans SC";
  return {
    canvas,
    colors,
    fontFamily: font,
    fontSize: tokens.fontSizes[0] || 14,
    fontSizes: tokens.fontSizes,
    // Stable semantic aliases — present even when the DSL omits them.
    semantic: {
      accent: "#2F6DEB",
      ok: "#22A06B",
      warn: "#D98B00",
      alert: "#D94F4F",
      surface: "#FFFFFF",
      bg: "#FAFAFA",
      fg: "#1F2D41",
      muted: "#5A6675",
      border: "#DADEE4",
      canvas: "#CAD7E7",
      screenBg: "#E2E7EF",
    },
    lang: opts.lang || "zh",
  };
}

// Map a hex color to a semantic alias when known.
function colorAlias(hex) {
  return COLOR_ALIASES[hex] || null;
}

// brand-spec.md content, deterministic and self-contained.
function buildBrandSpec(brief, tokens, opts) {
  opts = opts || {};
  const isZh = opts.lang !== "en";
  const lines = [];
  const rule = isZh ? "---" : "---";
  lines.push(rule);
  lines.push(isZh ? "title: SamHMI 设计规范" : "title: SamHMI Design Spec");
  lines.push(isZh ? "来源: Pixso compact DSL (get_node_dsl)" : "source: Pixso compact DSL (get_node_dsl)");
  lines.push(`id: ${brief.taskId || "samhmi"}`);
  lines.push(rule);
  lines.push("");
  lines.push(isZh ? `# ${brief.taskId || "SamHMI"} · 设计规范` : `# ${brief.taskId || "SamHMI"} · Design Spec`);
  lines.push("");
  lines.push(isZh ? "## 画布" : "## Canvas");
  lines.push("");
  lines.push(`${isZh ? "尺寸" : "Size"}: ${tokens.canvas.w} × ${tokens.canvas.h}px`);
  lines.push("");
  lines.push(isZh ? "## 色板(从 design-scene.v1 提取)" : "## Colors (extracted from design-scene.v1)");
  lines.push("");
  const colorLines = tokens.colors.map((hex) => {
    const alias = colorAlias(hex);
    return `- \`${hex}\`${alias ? ` · ${alias}` : ""}`;
  });
  if (colorLines.length === 0) colorLines.push("- (none)");
  lines.push(...colorLines);
  lines.push("");
  lines.push(isZh ? "## 语义色" : "## Semantic colors");
  lines.push("");
  const sem = tokens.semantic;
  lines.push(`- ${isZh ? "操作" : "accent"}: \`${sem.accent}\``);
  lines.push(`- ${isZh ? "正常" : "ok"}: \`${sem.ok}\``);
  lines.push(`- ${isZh ? "警告" : "warn"}: \`${sem.warn}\``);
  lines.push(`- ${isZh ? "报警" : "alert"}: \`${sem.alert}\``);
  lines.push("");
  lines.push(isZh ? "## 字体" : "## Typography");
  lines.push("");
  lines.push(`- ${isZh ? "主字体" : "Primary"}: \`${tokens.fontFamily || "Noto Sans SC"}\``);
  if (tokens.fontSizes.length > 0) {
    lines.push(`- ${isZh ? "字号" : "Sizes"}: ${tokens.fontSizes.join(", ")}px`);
  }
  lines.push("");
  lines.push(isZh ? "## 状态语义" : "## State semantics");
  lines.push("");
  lines.push(isZh ? "- 绿:正常 · 橙:警告 · 红:报警" : "- green: normal · orange: warn · red: alert");
  lines.push("");
  lines.push(isZh ? "## 来源" : "## Source");
  lines.push("");
  lines.push(`- ${isZh ? "节点" : "Node"}: ${brief.sourceGuid || "73:464"}`);
  lines.push(`- ${isZh ? "模板" : "Template"}: ${opts.template || "samhmi-editor"}`);
  lines.push(`- ${isZh ? "生成器" : "Generator"}: cortex-agent design-package`);
  lines.push("");
  return lines.join("\n");
}

module.exports = {
  rgbaToHex,
  extractTokens,
  rootCanvas,
  rootChildren,
  textLabels,
  buildBrandTokens,
  buildBrandSpec,
  colorAlias,
};
