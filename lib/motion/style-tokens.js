"use strict";

// ─── style-tokens — DESIGN.md → motion style tokens 编译 (P-005 MS-005) ──────
//
// The 5th-plane brand gate: every motion composition must be traceable to the
// effective DESIGN.md (4-level cascade, T-OD-001). This module reads the
// effective DESIGN.md (+ optional sibling tokens.css), extracts the palette /
// typography / motion rules / anti-patterns, and compiles a versioned
// `od-motion-tokens/v1` JSON artifact (HARD-GATE input).
//
// Source priority (P-005 §4.2):
//   1. explicit `<design-system-path>` (a DESIGN.md file) — highest
//   2. explicit design-system id → .agent/design-systems/<id>/DESIGN.md
//   3. effective cascade DESIGN.md (lib/design/resolve.effectiveDesign)
//
// Zero npm deps: node:fs / node:path / node:crypto only.
//
// Output shape (P-005 §4.2 + task spec):
//   {
//     "version": "od-motion-tokens/v1",
//     "derived_from": "<sha256-of-DESIGN.md>",
//     "source": { ... designSystemId, designMdPath, cascadeLayer ... },
//     "palette": { primary, secondary, accent, bg },
//     "typography": { heading: {family, weight, size_scale}, body: {...} },
//     "motion": { easing, durations: {fast, base, slow}, patterns },
//     "anti_patterns": [...],
//     "compiled_at": "<iso>"
//   }

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { effectiveDesign, resolveCascade } = require("../design/resolve");

const FORMAT_VERSION = "od-motion-tokens/v1";

// GSAP defaults — used only when DESIGN.md carries no explicit motion block
// (P-005: "动效规则(DESIGN.md frontmatter motion: 块,如果不存在,GSAP defaults)").
const GSAP_DEFAULTS = Object.freeze({
  easing: "power2.out",
  durations: { fast: 200, base: 400, slow: 800 },
  patterns: ["fade-up", "scale-in", "slide-from-right", "kinetic-type", "stat-counter"],
});

const DEFAULT_TYPOGRAPHY = Object.freeze({
  heading: { family: "Inter", weight: 700, size_scale: [12, 16, 24, 36, 56] },
  body: { family: "Inter", weight: 400, size_scale: [12, 14, 16] },
});

// ─── small helpers ───────────────────────────────────────────────────────────

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

// First #hex in a string (e.g. "`#0b0b0f`" or "#ffb76b — accent").
function hexFromValue(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/#[0-9a-fA-F]{3,8}\b/);
  return m ? m[0].toLowerCase() : null;
}

// ─── frontmatter parsing (YAML-lite) ─────────────────────────────────────────

// Parse `---\n...\n---` frontmatter into { data, body }. Supports flat
// `key: value` lines and one-level `motion:` / `palette:` / `font:` blocks.
function parseFrontmatter(content) {
  if (typeof content !== "string") return { data: {}, body: "" };
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) return { data: {}, body: content };
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: content };
  const fm = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\n+/, "");
  const data = {};
  let blockKey = null;
  for (const rawLine of fm.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (indent === 0) blockKey = null;
    if (value === "" || value === "|" || value === ">") {
      blockKey = key;
      if (!data[key]) data[key] = {};
      continue;
    }
    if (blockKey && typeof data[blockKey] === "object" && data[blockKey] !== null) {
      data[blockKey][key] = parseScalar(value);
    } else {
      data[key] = parseScalar(value);
    }
  }
  return { data, body };
}

function parseScalar(value) {
  if (/^\[.*\]$/.test(value)) {
    return value
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  if (/^["'].*["']$/.test(value)) return value.slice(1, -1);
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return value;
}

// ─── section extraction ──────────────────────────────────────────────────────

// Return the body of an H2 section (from its heading to the next H2 / EOF).
function sectionOf(md, headingRe) {
  const lines = md.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

// Parse a markdown table into rows of cells.
function parseTable(md) {
  const rows = [];
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    const cells = t
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

// ─── palette ─────────────────────────────────────────────────────────────────

const ROLE_TO_KEY = {
  primary: "primary",
  secondary: "secondary",
  accent: "accent",
  surface: "bg",
  background: "bg",
  bg: "bg",
  canvas: "bg",
};

// tokens.css: `--color-primary: #hex;` / `--color-accent: ...` / `--color-bg`.
function paletteFromTokensCss(css) {
  const palette = {};
  const hexMap = {};
  for (const m of css.matchAll(/--(?:color|brand)-?([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const name = m[1].toLowerCase();
    const hex = hexFromValue(m[2]);
    if (!hex) continue;
    hexMap[name] = hex;
    const key = ROLE_TO_KEY[name];
    if (key && !palette[key]) palette[key] = hex;
  }
  // fallback roles: neutral names that map to bg
  if (!palette.bg) {
    for (const name of ["background", "canvas", "surface", "bg"]) {
      if (hexMap[name]) {
        palette.bg = hexMap[name];
        break;
      }
    }
  }
  if (!palette.primary && hexMap["primary"]) palette.primary = hexMap["primary"];
  if (!palette.secondary && hexMap["secondary"]) palette.secondary = hexMap["secondary"];
  if (!palette.accent && hexMap["accent"]) palette.accent = hexMap["accent"];
  return palette;
}

// DESIGN.md "## Color roles" table → { primary, secondary, accent, bg }.
function paletteFromDesignMd(md) {
  const section = sectionOf(md, /^##\s+Color roles?\s*$/i);
  const palette = {};
  for (const row of parseTable(section)) {
    if (row.length < 2) continue;
    const role = row[0].toLowerCase();
    const key = ROLE_TO_KEY[role];
    if (!key) continue;
    const hex = hexFromValue(row[1]);
    if (hex && !palette[key]) palette[key] = hex;
  }
  // "## Visual theme" prose can carry a single hex fallback.
  if (!palette.bg) {
    const theme = sectionOf(md, /^##\s+Visual theme\s*$/i);
    const hex = hexFromValue(theme);
    if (hex) palette.bg = hex;
  }
  return palette;
}

// ─── typography ──────────────────────────────────────────────────────────────

const WEIGHT_HINT = {
  heading: /weight\s*(?:[:=]\s*)?(\d{3})/i,
  body: /weight\s*(?:[:=]\s*)?(\d{3})/i,
};

function familyFrom(frontmatterFont, section, role) {
  if (frontmatterFont) return frontmatterFont;
  const m = section.match(
    new RegExp(`\\*\\*${role === "heading" ? "Heading" : "Body"}\\*\\*:?\\s*([^,]+)`, "i"),
  );
  if (m) return m[1].trim();
  // `- **Display**: Inter Display` / `- **Body**: Inter` style bullets
  const b = section.match(new RegExp(`-\\s*\\*\\*${role === "heading" ? "(Display|Heading)" : "Body"}\\*\\*[^:]*:\\s*([^\\n]+)`, "i"));
  if (b) return b[2].trim().replace(/[`*]/g, "");
  return null;
}

function typographyFrom(md, frontmatter) {
  const section = sectionOf(md, /^##\s+Typography\s*$/i);
  const heading = { ...DEFAULT_TYPOGRAPHY.heading };
  const body = { ...DEFAULT_TYPOGRAPHY.body };
  const fmFont =
    frontmatter["font-family"] || (frontmatter.typography && frontmatter.typography["font-family"]) || null;
  const headingFamily = familyFrom(fmFont, section, "heading");
  if (headingFamily) heading.family = headingFamily;
  const bodyFamily = familyFrom(fmFont, section, "body");
  if (bodyFamily) body.family = bodyFamily;
  const headingWeight = section.match(/Heading[^\n]*weight\s*(\d{3})/i);
  if (headingWeight) heading.weight = Number(headingWeight[1]);
  const bodyWeight = section.match(/Body[^\n]*weight\s*(\d{3})/i);
  if (bodyWeight) body.weight = Number(bodyWeight[1]);
  const scale = section.match(/type\s*scale[^\n]*?([0-9]+\s*px(?:\s*\/\s*[0-9]+\s*px)*)/i);
  if (scale) {
    const sizes = scale[1].match(/\d+/g).map(Number);
    if (sizes.length >= 2) {
      heading.size_scale = sizes;
      body.size_scale = sizes.filter((s) => s <= 18);
      if (body.size_scale.length < 2) body.size_scale = [12, 14, 16];
    }
  }
  return { heading, body };
}

// ─── motion rules ────────────────────────────────────────────────────────────

function motionFrom(md, frontmatter) {
  // 1. frontmatter `motion:` block wins (task spec).
  if (frontmatter.motion && typeof frontmatter.motion === "object") {
    const fm = frontmatter.motion;
    const motion = {};
    motion.easing = fm.easing || GSAP_DEFAULTS.easing;
    const durations = { ...GSAP_DEFAULTS.durations };
    if (typeof fm.durations === "object" && fm.durations !== null) {
      for (const k of ["fast", "base", "slow"]) {
        if (Number.isFinite(Number(fm.durations[k]))) durations[k] = Number(fm.durations[k]);
      }
    } else if (Number.isFinite(Number(fm.duration))) {
      const d = Number(fm.duration);
      durations.fast = Math.round(d * 0.5);
      durations.base = d;
      durations.slow = Math.round(d * 2);
    }
    motion.durations = durations;
    motion.patterns = Array.isArray(fm.patterns) && fm.patterns.length ? fm.patterns : GSAP_DEFAULTS.patterns;
    return motion;
  }

  // 2. "## Motion and interaction" prose section.
  const section = sectionOf(md, /^##\s+Motion and interaction\s*$/i);
  if (section.trim()) {
    const motion = { durations: { ...GSAP_DEFAULTS.durations }, patterns: [...GSAP_DEFAULTS.patterns] };
    const easing = section.match(/[Ee]asing[^:：\n]*[:：]\s*([^\n]+)/);
    motion.easing = easing ? easeToken(easing[1].trim()) : GSAP_DEFAULTS.easing;
    const durations = section.match(/[Dd]uration[^:：\n]*[:：]\s*([^\n]+)/);
    if (durations) {
      const ms = durations[1].match(/\d{2,4}\s*ms/g);
      if (ms && ms.length >= 3) {
        const nums = ms.map((s) => Number(s.replace(/\D/g, ""))).sort((a, b) => a - b);
        motion.durations.fast = nums[0];
        motion.durations.base = nums[1];
        motion.durations.slow = nums[nums.length - 1];
      }
    }
    if (section.match(/stagger/i)) {
      for (const p of ["fade-up", "scale-in"]) {
        if (!motion.patterns.includes(p)) motion.patterns.push(p);
      }
    }
    return motion;
  }

  // 3. GSAP defaults.
  return { ...GSAP_DEFAULTS, durations: { ...GSAP_DEFAULTS.durations }, patterns: [...GSAP_DEFAULTS.patterns] };
}

// Map common CSS easing strings to GSAP tokens (or pass through).
function easeToken(value) {
  const v = value.toLowerCase();
  if (v.includes("cubic-bezier(0.16") || v.includes("cubic-bezier(0.22")) return "power2.out";
  if (v.includes("cubic-bezier(0.7")) return "power2.in";
  if (v.includes("linear")) return "none";
  if (/^(power\d+\.(in|out|inout))$/.test(v)) return v;
  if (v.includes("ease-out") || v.includes("easeout")) return "power2.out";
  if (v.includes("ease-in") || v.includes("easein")) return "power2.in";
  return value;
}

// ─── anti-patterns ───────────────────────────────────────────────────────────

// Normalize a bullet into a stable id: strip ❌ / "- ", trim, and guarantee a
// "no " prefix (P-005 VC-1: antiPatterns 含 "no default #333" — 保留原文,加 no 前缀)。
// Raw text kept in anti_pattern_details.
function slugifyAntiPattern(raw) {
  let s = String(raw)
    .replace(/^[-•*]\s*/, "")
    .replace(/^[❌🚫✗✘]+/, "")
    .replace(/[`*_]/g, "")
    .trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (/^no[\s-]/.test(lower)) return s;
  return `no ${s}`;
}

function antiPatternsFrom(md, frontmatter) {
  const ids = [];
  const details = {};
  const fmList = frontmatter["anti-patterns"] || frontmatter.anti_patterns;
  if (Array.isArray(fmList)) {
    for (const item of fmList) {
      const id = slugifyAntiPattern(item);
      if (id && !ids.includes(id)) {
        ids.push(id);
        details[id] = String(item).trim();
      }
    }
  }
  const section = sectionOf(md, /^##\s+Anti-?patterns?\s*$/i);
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t || !/^[-•❌]/.test(t)) continue;
    const id = slugifyAntiPattern(t);
    if (id && !ids.includes(id)) {
      ids.push(id);
      details[id] = t.replace(/^[-•❌\s]+/, "");
    }
  }
  if (ids.length === 0) ids.push("no-unbranded-defaults");
  return { anti_patterns: ids, anti_pattern_details: details };
}

// ─── compile ─────────────────────────────────────────────────────────────────

/**
 * Resolve the DESIGN.md source for tokens compilation.
 * options:
 *   designSystemPath  — explicit DESIGN.md file (highest priority)
 *   designSystemId    — `.agent/design-systems/<id>/DESIGN.md`
 *   cwd               — project root (default process.cwd())
 *   templateDir       — templates dir for cascade layer 4 (optional)
 *
 * Returns { designMdPath, cascadeLayer, kind } or throws a user-facing error.
 */
function resolveDesignSource(options) {
  const cwd = options.cwd || process.cwd();
  if (options.designSystemPath) {
    if (!exists(options.designSystemPath)) {
      throw new Error(`DESIGN.md not found at ${options.designSystemPath}`);
    }
    return {
      designMdPath: options.designSystemPath,
      cascadeLayer: options.designSystemId ? 3 : 0,
      kind: options.designSystemId ? "design-system" : "explicit",
      designSystemId: options.designSystemId || null,
    };
  }
  if (options.designSystemId) {
    const p = path.join(cwd, ".agent", "design-systems", options.designSystemId, "DESIGN.md");
    if (!exists(p)) {
      throw new Error(
        `design system "${options.designSystemId}" not installed — run \`cortex-agent design install ${options.designSystemId}\` first`,
      );
    }
    return { designMdPath: p, cascadeLayer: 3, kind: "design-system", designSystemId: options.designSystemId };
  }
  const effective = effectiveDesign({ cwd, templateDir: options.templateDir });
  if (!effective) {
    throw new Error("no DESIGN.md resolvable — install a design system or add a project DESIGN.md");
  }
  return {
    designMdPath: effective.source,
    cascadeLayer: effective.layer,
    kind: effective.kind,
    designSystemId: effective.layer === 3 ? path.basename(path.dirname(effective.source)) : null,
  };
}

/**
 * Compile motion style tokens from the resolved DESIGN.md.
 * Returns the tokens object (does not write).
 */
function compileMotionTokens(options) {
  const cwd = options.cwd || process.cwd();
  const source = resolveDesignSource(options);
  const content = readFileSafe(source.designMdPath);
  if (content === null) {
    throw new Error(`cannot read DESIGN.md at ${source.designMdPath}`);
  }
  const { data: frontmatter } = parseFrontmatter(content);

  // Palette: tokens.css sibling wins, then DESIGN.md color table, then theme prose.
  let palette = {};
  const tokensCssPath = path.join(path.dirname(source.designMdPath), "tokens.css");
  const tokensCss = readFileSafe(tokensCssPath);
  if (tokensCss !== null) palette = paletteFromTokensCss(tokensCss);
  if (Object.keys(palette).length === 0) palette = paletteFromDesignMd(content);
  if (Object.keys(palette).length === 0) {
    // minimal safe default (HyperFrames OD default canvas) — traceable via source
    palette = { primary: "#ffb76b", secondary: "#7da4ff", accent: "#7da4ff", bg: "#0b0b0f" };
  }
  const normalizedPalette = {
    primary: palette.primary || palette.secondary || "#ffb76b",
    secondary: palette.secondary || palette.accent || "#7da4ff",
    accent: palette.accent || palette.primary || "#7da4ff",
    bg: palette.bg || "#0b0b0f",
  };

  const typography = typographyFrom(content, frontmatter);
  const motion = motionFrom(content, frontmatter);
  const anti = antiPatternsFrom(content, frontmatter);

  const tokens = {
    version: FORMAT_VERSION,
    derived_from: sha256Hex(content),
    source: {
      designSystemId: source.designSystemId || null,
      cascadeLayer: source.cascadeLayer,
      kind: source.kind,
      designMdPath: source.designMdPath,
    },
    palette: normalizedPalette,
    typography,
    motion,
    anti_patterns: anti.anti_patterns,
    anti_pattern_details: anti.anti_pattern_details,
    compiled_at: new Date().toISOString(),
  };
  return tokens;
}

/**
 * Compile + write `<motionDir>/style-tokens/<id>.json`.
 * options:
 *   motionId          — motion id (used for the output filename when no design-system id)
 *   designSystemId    — optional; output filename becomes `<design-system-id>.json`
 *   designSystemPath  — optional explicit DESIGN.md
 *   cwd / templateDir — cascade context
 *   motionDir         — override `.agent/motion` root (default <cwd>/.agent/motion)
 * Returns { path, tokens }.
 */
function writeMotionTokens(options) {
  const cwd = options.cwd || process.cwd();
  const motionDir = options.motionDir || path.join(cwd, ".agent", "motion");
  const tokens = compileMotionTokens(options);
  const id = options.designSystemId || options.motionId || "effective";
  const tokensDir = path.join(motionDir, "style-tokens");
  fs.mkdirSync(tokensDir, { recursive: true });
  const out = path.join(tokensDir, `${id}.json`);
  fs.writeFileSync(out, JSON.stringify(tokens, null, 2), "utf8");
  return { path: out, tokens };
}

module.exports = {
  FORMAT_VERSION,
  GSAP_DEFAULTS,
  compileMotionTokens,
  writeMotionTokens,
  resolveDesignSource,
  // helpers exposed for tests
  _internal: {
    sha256Hex,
    parseFrontmatter,
    parseScalar,
    sectionOf,
    parseTable,
    hexFromValue,
    paletteFromTokensCss,
    paletteFromDesignMd,
    typographyFrom,
    motionFrom,
    antiPatternsFrom,
    slugifyAntiPattern,
    easeToken,
    ROLE_TO_KEY,
    DEFAULT_TYPOGRAPHY,
  },
};
