"use strict";

// ─── skill browse Tests (P-007 §3.3 / BR-5) ─────────────────────────────────
//
// Coverage: lib/commands/skill-browse.js — area filter, top-n truncation,
// invalid area error, and end-to-end CLI.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const path = require("node:path");
const { skillBrowse, VALID_AREAS } = require("../../lib/commands/skill-browse");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

// ─── unit: skillBrowse() ───────────────────────────────────────────────────

test("skill-browse: VALID_AREAS has 4 entries", () => {
  assert.deepEqual([...VALID_AREAS].sort(), ["agent-tuning", "aiapp", "office", "swe"]);
});

test("skill-browse: default area=null returns mixed areas with by_area counts", () => {
  const r = skillBrowse({ area: null, topN: 5 });
  assert.equal(r.area, null);
  assert.ok(r.scanned >= 40, `expected at least 40 skills, got ${r.scanned}`);
  assert.ok(r.returned <= 5);
  assert.ok(r.by_area.aiapp >= 1);
  assert.ok(r.by_area["agent-tuning"] >= 1);
  assert.ok(r.by_area.swe >= 1);
});

test("skill-browse: --area filter returns only that area", () => {
  const r = skillBrowse({ area: "agent-tuning", topN: 50 });
  for (const s of r.skills) assert.equal(s.area, "agent-tuning");
  assert.equal(r.scanned, r.by_area["agent-tuning"]);
});

test("skill-browse: topN truncates results but not by_area counts", () => {
  const r = skillBrowse({ area: "aiapp", topN: 3 });
  assert.equal(r.returned, 3);
  assert.ok(r.by_area.aiapp > 3, "by_area counts the full population, not just returned");
  assert.equal(r.scanned, r.by_area.aiapp);
});

test("skill-browse: invalid area throws ERR_INVALID_AREA", () => {
  assert.throws(
    () => skillBrowse({ area: "bogus" }),
    (err) => err.code === "ERR_INVALID_AREA"
  );
});

test("skill-browse: skills have name + area + summary fields", () => {
  const r = skillBrowse({ area: null, topN: 10 });
  for (const s of r.skills) {
    assert.ok(typeof s.name === "string" && s.name.length > 0);
    assert.ok(typeof s.area === "string");
    assert.ok(typeof s.summary === "string" && s.summary.length > 0);
  }
});

test("skill-browse: skills are alphabetically sorted", () => {
  const r = skillBrowse({ area: null, topN: 50 });
  const names = r.skills.map((s) => s.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted);
});

// ─── end-to-end: CLI ───────────────────────────────────────────────────────

test("cli: skill browse --json returns structured output", () => {
  const r = spawnSync(process.execPath, [CLI, "skill", "browse", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.scanned >= 40);
  assert.ok(Array.isArray(out.skills));
});

test("cli: skill browse --area swe --top-n 2 --json", () => {
  const r = spawnSync(process.execPath, [CLI, "skill", "browse", "--area", "swe", "--top-n", "2", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.area, "swe");
  assert.equal(out.returned, 2);
  for (const s of out.skills) assert.equal(s.area, "swe");
});

test("cli: skill browse --area=bogus exits 2 with error message", () => {
  const r = spawnSync(process.execPath, [CLI, "skill", "browse", "--area", "bogus", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid area/);
});

test("cli: skill (no subcommand) exits 2 with usage hint", () => {
  const r = spawnSync(process.execPath, [CLI, "skill", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: cortex-agent skill browse/);
});

test("cli: skill browse human output is grouped by area", () => {
  const r = spawnSync(process.execPath, [CLI, "skill", "browse", "--area", "agent-tuning", "--top-n", "1"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agent-tuning: \d+/);
  assert.match(r.stdout, /\[agent-tuning\]/);
});
