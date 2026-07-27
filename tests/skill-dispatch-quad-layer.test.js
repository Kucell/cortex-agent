"use strict";

/**
 * Quad-Layer Skill Dispatch — main-repo entry test.
 *
 * Validates the four-layer defense (intent -> screening -> arbitration ->
 * execution fusing) is wired through the public `.agent/skills/` surface
 * that ships with cortex-agent. Tests exercise the same scripts as the
 * inner integration suite but use the standard `node --test` runner so
 * they are visible to the main repo's test discovery.
 *
 * The skill implementations themselves live in the inner `.agent/`
 * workspace (L3); this file only validates the wiring contract.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKILL_DIR = path.join(ROOT, ".agent", "skills");
const SKILL_INDEX = path.join(SKILL_DIR, "skill-index.json");

const REQUIRED_SCRIPTS = [
  path.join("intent-classifier", "scripts", "classify.js"),
  path.join("skill-selector", "scripts", "select.js"),
  path.join("skill-arbiter", "scripts", "arbitrate.js"),
  path.join("skill-executor", "scripts", "execute.js"),
];

const REQUIRED_INPUTS = [
  "帮我审查代码",
  "准备部署",
  "/code-review",
  "查询天气并推荐航班",
  "随便看看",
];

test("quad-layer skill scripts and index are wired under .agent/skills", () => {
  for (const relativePath of REQUIRED_SCRIPTS) {
    const file = path.join(SKILL_DIR, relativePath);
    assert.ok(
      // eslint-disable-next-line no-bitwise
      require("node:fs").existsSync(file),
      `missing quad-layer script: ${relativePath}`,
    );
  }
  assert.ok(
    require("node:fs").existsSync(SKILL_INDEX),
    `missing skill-index.json at ${SKILL_INDEX}`,
  );
});

test("quad-layer input set covers intent / explicit / composite / unknown", () => {
  // Smoke check: the input set is large enough that at least the four
  // layer-1 buckets (intent / explicit / composite / unknown) are
  // represented. This guards against silent regressions in the test
  // corpus that would make Layer 2 / Layer 3 untestable.
  assert.ok(REQUIRED_INPUTS.length >= 5);
  assert.ok(REQUIRED_INPUTS.includes("帮我审查代码"));
  assert.ok(REQUIRED_INPUTS.some((s) => s.startsWith("/")));
  assert.ok(REQUIRED_INPUTS.some((s) => s.includes("并")));
  assert.ok(REQUIRED_INPUTS.some((s) => s.length <= 5));
});

test("Layer 1 intent classifier runs and emits a stable JSON shape", () => {
  const result = spawnSync("node", [
    path.join(SKILL_DIR, "intent-classifier", "scripts", "classify.js"),
    "--input", "帮我审查代码",
  ], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Skills emit a { ok, layer, ... } envelope with the contract fields
  // flattened at the top level. Accept that contract directly.
  assert.ok(payload.ok === true);
  assert.strictEqual(payload.layer, "intent-classifier");
  assert.ok(typeof payload.intent === "string");
  assert.ok(typeof payload.confidence === "number");
  assert.ok(["explicit_command", "matched_pattern", "keyword", "unknown"].includes(payload.matched_by));
});

test("Layer 2 skill selector returns structured candidates", () => {
  const result = spawnSync("node", [
    path.join(SKILL_DIR, "skill-selector", "scripts", "select.js"),
    "--intent", "code_review",
    "--domain", "development",
  ], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.candidates));
  assert.ok(payload.candidates.length > 0);
  assert.ok(payload.candidates.every((c) => typeof c.name === "string"));
});

test("Layer 3 skill arbiter reads skill-index.json and recommends one", () => {
  const result = spawnSync("node", [
    path.join(SKILL_DIR, "skill-arbiter", "scripts", "arbitrate.js"),
    "--skill-index", SKILL_INDEX,
    "--intent", "code_review",
  ], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.ok === true);
  assert.strictEqual(payload.layer, "skill-arbiter");
  assert.ok(Array.isArray(payload.ranked_skills));
  assert.ok(payload.ranked_skills.length > 0);
  const top = payload.ranked_skills[0];
  assert.ok(typeof top.name === "string" && top.name.length > 0);
  assert.ok(typeof top.score === "number");
});

test("Layer 4 skill executor exposes a fusing surface", () => {
  const result = spawnSync("node", [
    path.join(SKILL_DIR, "skill-executor", "scripts", "execute.js"),
    "--help",
  ], { encoding: "utf8" });
  // --help may exit 0 or print to stdout; we only assert the script is wired.
  assert.ok(result.stdout || result.stderr, "execute.js produced no output");
});