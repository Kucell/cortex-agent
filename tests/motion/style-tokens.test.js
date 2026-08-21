"use strict";

// tests/motion/style-tokens.test.js — DESIGN.md → motion style tokens 编译
// (P-005 MS-005)。纯单元测试,无外部依赖;外部缺失时无需 skip(纯函数)。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const tokens = require("../../lib/motion/style-tokens");
const { _internal } = tokens;

function makeFixtureDesignSystem() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-tokens-"));
  const ds = path.join(dir, ".agent", "design-systems", "acme");
  fs.mkdirSync(ds, { recursive: true });
  const md = [
    "# Acme Design System",
    "",
    "> fixture for style-tokens tests",
    "",
    "## Visual theme",
    "",
    "warm-editorial: 暖橙 + 深炭黑",
    "",
    "## Color roles",
    "",
    "| Role | Hex | Usage |",
    "| --- | --- | --- |",
    "| Primary | `#ff6a00` | 主交互 / 标题 |",
    "| Secondary | `#2b2b33` | 次要交互 |",
    "| Accent | `#7da4ff` | 关键 CTA |",
    "| Surface | `#0b0b0f` | 背景 |",
    "",
    "## Typography",
    "",
    "- **Heading**: Inter Display, weight 700, line-height 1.1",
    "- **Body**: Inter, weight 400, line-height 1.6",
    "- **Type scale**: heading-1 56px / heading-2 36px / heading-3 24px / body 16px / caption 14px",
    "",
    "## Motion and interaction",
    "",
    "- **Easing**: `cubic-bezier(0.22, 1, 0.36, 1)` (进入)",
    "- **Duration**: 150ms(微交互)/ 300ms(常规)/ 600ms(强调)",
    "- **Stagger**: list 项间隔 30ms",
    "",
    "## Anti-patterns",
    "",
    "- ❌ 纯黑底 + 纯白字",
    "- ❌ no default #333 / #3b82f6 / Roboto",
    "- ❌ 动画时长 > 600ms",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(ds, "DESIGN.md"), md, "utf8");
  return dir;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── parseFrontmatter ───────────────────────────────────────────────────────

test("parseFrontmatter: flat keys + motion block", () => {
  const { data } = _internal.parseFrontmatter(
    "---\nfont-family: Inter\nmotion:\n  easing: power2.out\n  duration: 400\n---\n# Body",
  );
  assert.equal(data["font-family"], "Inter");
  assert.equal(data.motion.easing, "power2.out");
  assert.equal(data.motion.duration, 400);
});

test("parseFrontmatter: no frontmatter → empty data + full body", () => {
  const { data, body } = _internal.parseFrontmatter("# Just a heading");
  assert.deepEqual(data, {});
  assert.match(body, /^# Just a heading/);
});

test("parseFrontmatter: array scalar", () => {
  const { data } = _internal.parseFrontmatter("---\npatterns: [fade-up, scale-in]\n---\nx");
  assert.deepEqual(data.patterns, ["fade-up", "scale-in"]);
});

// ─── sectionOf / hexFromValue ───────────────────────────────────────────────

test("sectionOf: extracts body until next H2", () => {
  const section = _internal.sectionOf("## Color roles\nrow1\n## Typography\nrow2", /^##\s+Color roles\s*$/i);
  assert.match(section, /row1/);
  assert.doesNotMatch(section, /row2/);
});

test("hexFromValue: first #hex in string", () => {
  assert.equal(_internal.hexFromValue("`#ff6a00` — 主色"), "#ff6a00");
  assert.equal(_internal.hexFromValue("no hex"), null);
});

// ─── palette ────────────────────────────────────────────────────────────────

test("paletteFromDesignMd: color roles table → primary/secondary/accent/bg", () => {
  const md = fs.readFileSync(
    path.join(makeFixtureDesignSystem(), ".agent", "design-systems", "acme", "DESIGN.md"),
    "utf8",
  );
  const palette = _internal.paletteFromDesignMd(md);
  assert.equal(palette.primary, "#ff6a00");
  assert.equal(palette.secondary, "#2b2b33");
  assert.equal(palette.accent, "#7da4ff");
  assert.equal(palette.bg, "#0b0b0f");
});

test("paletteFromTokensCss: --color-* variables win over prose", () => {
  const css = ":root { --color-primary: #111111; --color-accent: #222222; --color-bg: #000000; }";
  const palette = _internal.paletteFromTokensCss(css);
  assert.equal(palette.primary, "#111111");
  assert.equal(palette.accent, "#222222");
  assert.equal(palette.bg, "#000000");
});

// ─── typography ─────────────────────────────────────────────────────────────

test("typographyFrom: prose heading/body family + weight", () => {
  const md = [
    "## Typography",
    "",
    "- **Heading**: Inter Display, weight 700, line-height 1.1",
    "- **Body**: Inter, weight 400, line-height 1.6",
    "",
  ].join("\n");
  const t = _internal.typographyFrom(md, {});
  assert.equal(t.heading.family, "Inter Display");
  assert.equal(t.heading.weight, 700);
  assert.equal(t.body.family, "Inter");
  assert.equal(t.body.weight, 400);
});

test("typographyFrom: frontmatter font-family overrides prose", () => {
  const t = _internal.typographyFrom("# no typography section", { "font-family": "Space Grotesk" });
  assert.equal(t.heading.family, "Space Grotesk");
  assert.equal(t.body.family, "Space Grotesk");
});

test("typographyFrom: defaults when nothing present", () => {
  const t = _internal.typographyFrom("# nothing", {});
  assert.equal(t.heading.family, "Inter");
  assert.equal(t.heading.weight, 700);
  assert.equal(t.body.family, "Inter");
  assert.deepEqual(t.body.size_scale, [12, 14, 16]);
});

// ─── motion rules ───────────────────────────────────────────────────────────

test("motionFrom: prose easing + durations parsed", () => {
  const md = [
    "## Motion and interaction",
    "",
    "- **Easing**: `cubic-bezier(0.22, 1, 0.36, 1)` (进入)",
    "- **Duration**: 150ms(微交互)/ 300ms(常规)/ 600ms(强调)",
    "- **Stagger**: list 项间隔 30ms",
    "",
  ].join("\n");
  const m = _internal.motionFrom(md, {});
  assert.equal(m.easing, "power2.out");
  assert.deepEqual(m.durations, { fast: 150, base: 300, slow: 600 });
  assert.ok(m.patterns.includes("fade-up"));
});

test("motionFrom: frontmatter motion block wins over prose", () => {
  const md = "## Motion and interaction\n- **Easing**: linear\n";
  const m = _internal.motionFrom(md, {
    motion: { easing: "power2.in", durations: { fast: 100, base: 200, slow: 400 } },
  });
  assert.equal(m.easing, "power2.in");
  assert.deepEqual(m.durations, { fast: 100, base: 200, slow: 400 });
});

test("motionFrom: GSAP defaults when no motion info", () => {
  const m = _internal.motionFrom("# nothing", {});
  assert.equal(m.easing, "power2.out");
  assert.deepEqual(m.durations, { fast: 200, base: 400, slow: 800 });
  assert.ok(Array.isArray(m.patterns));
  assert.ok(m.patterns.includes("stat-counter"));
});

// ─── anti-patterns ──────────────────────────────────────────────────────────

test("antiPatternsFrom: bullets normalized with 'no ' prefix + details", () => {
  const md = ["## Anti-patterns", "", "- ❌ 纯黑底 + 纯白字", "- ❌ no default #333 / #3b82f6 / Roboto", ""].join("\n");
  const r = _internal.antiPatternsFrom(md, {});
  assert.ok(r.anti_patterns.includes("no 纯黑底 + 纯白字"));
  assert.ok(r.anti_patterns.includes("no default #333 / #3b82f6 / Roboto"));
  assert.ok(r.anti_pattern_details["no default #333 / #3b82f6 / Roboto"]);
});

test("slugifyAntiPattern: strips markers and adds no- prefix", () => {
  assert.equal(_internal.slugifyAntiPattern("- ❌ emoji-only header"), "no emoji-only header");
  assert.equal(_internal.slugifyAntiPattern("no default #333"), "no default #333");
  assert.equal(_internal.slugifyAntiPattern("   "), null);
});

// ─── compileMotionTokens end-to-end ─────────────────────────────────────────

test("compileMotionTokens: fixture design-system → palette/typography/motion reverse-check", () => {
  const dir = makeFixtureDesignSystem();
  const result = tokens.compileMotionTokens({ cwd: dir, designSystemId: "acme" });
  assert.equal(result.version, "od-motion-tokens/v1");
  // 调色板反向校验
  assert.equal(result.palette.primary, "#ff6a00");
  assert.equal(result.palette.bg, "#0b0b0f");
  // 字体反向校验
  assert.equal(result.typography.heading.family, "Inter Display");
  assert.equal(result.typography.body.family, "Inter");
  // 动效规则反向校验
  assert.equal(result.motion.easing, "power2.out");
  assert.deepEqual(result.motion.durations, { fast: 150, base: 300, slow: 600 });
  assert.ok(result.anti_patterns.some((a) => a.includes("no default #333")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("compileMotionTokens: derived_from = sha256 of DESIGN.md content", () => {
  const dir = makeFixtureDesignSystem();
  const md = fs.readFileSync(path.join(dir, ".agent", "design-systems", "acme", "DESIGN.md"), "utf8");
  const result = tokens.compileMotionTokens({ cwd: dir, designSystemId: "acme" });
  assert.equal(result.derived_from, sha256(md));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("compileMotionTokens: explicit designSystemPath beats cascade", () => {
  const dir = makeFixtureDesignSystem();
  const p = path.join(dir, ".agent", "design-systems", "acme", "DESIGN.md");
  const result = tokens.compileMotionTokens({ designSystemPath: p });
  assert.equal(result.palette.primary, "#ff6a00");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("compileMotionTokens: missing design system → user-facing error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-tokens-"));
  assert.throws(() => tokens.compileMotionTokens({ cwd: dir, designSystemId: "nope" }), /design system "nope" not installed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── writeMotionTokens ──────────────────────────────────────────────────────

test("writeMotionTokens: writes <motionDir>/style-tokens/<id>.json (od-motion-tokens/v1)", () => {
  const dir = makeFixtureDesignSystem();
  const out = tokens.writeMotionTokens({ cwd: dir, motionId: "m-001", designSystemId: "acme" });
  assert.equal(path.basename(out.path), "acme.json");
  assert.match(out.path, /style-tokens[/\\]acme\.json$/);
  const written = JSON.parse(fs.readFileSync(out.path, "utf8"));
  assert.equal(written.version, "od-motion-tokens/v1");
  assert.ok(written.compiled_at);
  assert.equal(written.source.designSystemId, "acme");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveDesignSource: cascade effective DESIGN.md fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-tokens-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agent", "DESIGN.md"), "# Agent Context Design\n## Color roles\n| Primary | `#123456` | x |\n", "utf8");
  const src = tokens.resolveDesignSource({ cwd: dir });
  assert.equal(src.cascadeLayer, 2);
  assert.equal(src.kind, "agent-context");
  fs.rmSync(dir, { recursive: true, force: true });
});
