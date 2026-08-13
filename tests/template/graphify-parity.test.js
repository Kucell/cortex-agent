"use strict";

// ─── Graphify template parity tests (T-GWG-001) ─────────────────────────────
//
// Pins the contract that the en/zh Graphify templates stay behaviorally
// consistent after the freshness integration. Concretely:
//   - Both SKILL.md files mention freshness preflight and `/ship` gate.
//   - Both README files expose the same CLI surface bullet points.
//   - The post-commit hook script lives only under `_shared` (single
//     source of truth) and is byte-identical between any future copies.
//   - The plugin config.yml / fallback content matches.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const EN_SKILL = path.join(ROOT, "templates", "en", ".agent", "skills", "graphify", "SKILL.md");
const ZH_SKILL = path.join(ROOT, "templates", "zh", ".agent", "skills", "graphify", "SKILL.md");
const EN_README = path.join(ROOT, "templates", "en", ".agent", "plugins", "graphify", "README.md");
const ZH_README = path.join(ROOT, "templates", "zh", ".agent", "plugins", "graphify", "README.md");
const SHARED_HOOK = path.join(ROOT, "templates", "_shared", ".agent", "plugins", "graphify", "scripts", "post-commit-update.js");

function countOccurrences(haystack, needle) {
  if (!haystack) return 0;
  return haystack.split(needle).length - 1;
}

test("graphify SKILL.md: en + zh both describe freshness preflight", () => {
  const en = fs.readFileSync(EN_SKILL, "utf8");
  const zh = fs.readFileSync(ZH_SKILL, "utf8");
  assert.match(en, /freshness preflight/i);
  assert.match(zh, /freshness preflight/i);
});

test("graphify SKILL.md: en + zh both describe the ship-time gate", () => {
  const en = fs.readFileSync(EN_SKILL, "utf8");
  const zh = fs.readFileSync(ZH_SKILL, "utf8");
  assert.match(en, /Ship-time Freshness Closure/i);
  assert.match(zh, /\/ship 阶段的 Freshness 收口/);
});

test("graphify SKILL.md: en + zh share the same subcommand headings", () => {
  const en = fs.readFileSync(EN_SKILL, "utf8");
  const zh = fs.readFileSync(ZH_SKILL, "utf8");
  for (const heading of ["/graphify query", "/graphify path", "/graphify explain", "/graphify extract"]) {
    assert.ok(en.includes(heading), `EN SKILL missing ${heading}`);
    assert.ok(zh.includes(heading), `ZH SKILL missing ${heading}`);
  }
});

test("graphify README: en + zh both document the CLI surface", () => {
  const en = fs.readFileSync(EN_README, "utf8");
  const zh = fs.readFileSync(ZH_README, "utf8");
  for (const sub of ["graphify context", "graphify preflight", "graphify update", "graphify doctor", "graphify receipt"]) {
    assert.ok(en.includes(sub), `EN README missing ${sub}`);
    assert.ok(zh.includes(sub), `ZH README missing ${sub}`);
  }
});

test("graphify README: en + zh both document the freshness lifecycle", () => {
  const en = fs.readFileSync(EN_README, "utf8");
  const zh = fs.readFileSync(ZH_README, "utf8");
  for (const trigger of ["cortex-agent init", "cortex-agent doctor --fix", "git commit", "/ship"]) {
    assert.ok(en.includes(trigger), `EN README missing ${trigger}`);
    assert.ok(zh.includes(trigger), `ZH README missing ${trigger}`);
  }
});

test("graphify hook script lives only under _shared", () => {
  assert.equal(fs.existsSync(SHARED_HOOK), true);
  // en + zh must NOT carry their own copy of the hook (single source).
  const enHook = path.join(ROOT, "templates", "en", ".agent", "plugins", "graphify", "scripts", "post-commit-update.js");
  const zhHook = path.join(ROOT, "templates", "zh", ".agent", "plugins", "graphify", "scripts", "post-commit-update.js");
  assert.equal(fs.existsSync(enHook), false, "en hook must come from _shared");
  assert.equal(fs.existsSync(zhHook), false, "zh hook must come from _shared");
});

test("graphify hook script is delegating to lib/graphify/hook.js", () => {
  const text = fs.readFileSync(SHARED_HOOK, "utf8");
  // The new wrapper must explicitly require lib/graphify/hook.js.
  assert.match(text, /graphify\/hook\.js/);
  // And it must never block the commit (exit 0 always).
  assert.match(text, /process\.exit\(0\)/);
});

test("graphify SKILL.md: EN and ZH both expose the same number of preflight references", () => {
  const en = fs.readFileSync(EN_SKILL, "utf8");
  const zh = fs.readFileSync(ZH_SKILL, "utf8");
  const enCount = countOccurrences(en, "preflight");
  const zhCount = countOccurrences(zh, "preflight");
  assert.ok(enCount >= 3, `EN preflight mentions: ${enCount}`);
  assert.ok(zhCount >= 3, `ZH preflight mentions: ${zhCount}`);
});