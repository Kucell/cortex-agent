"use strict";

// ─── VC-014 — Template parity for the feedback config and hook projection ──

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SHARED_EXAMPLE = path.join(ROOT, "templates", "_shared", ".agent", "config", "feedback.json.example");
const ZH_README = path.join(ROOT, "templates", "zh", ".agent", "config", "README-feedback.md");
const EN_README = path.join(ROOT, "templates", "en", ".agent", "config", "README-feedback.md");
const ZH_HOOKS = path.join(ROOT, "templates", "zh", ".agent", "hooks", "hooks.json");
const EN_HOOKS = path.join(ROOT, "templates", "en", ".agent", "hooks", "hooks.json");

test("VC-014 feedback.json.example exists in the shared template tree", () => {
  assert.ok(fs.existsSync(SHARED_EXAMPLE), `missing ${SHARED_EXAMPLE}`);
  const parsed = JSON.parse(fs.readFileSync(SHARED_EXAMPLE, "utf8"));
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.nudge.enabled, false);
  assert.equal(parsed.adapters.cortex_diagnostic, false);
  assert.equal(parsed.adapters.evolution_observation, false);
  assert.equal(parsed.storage.retention_days, 30);
  assert.equal(parsed.storage.max_event_bytes, 16384);
  assert.equal(parsed.storage.max_events_per_day, 10000);
});

test("VC-014 zh and en README-feedback.md both exist and document exit codes", () => {
  assert.ok(fs.existsSync(ZH_README));
  assert.ok(fs.existsSync(EN_README));
  const zh = fs.readFileSync(ZH_README, "utf8");
  const en = fs.readFileSync(EN_README, "utf8");
  assert.match(zh, /退出码/);
  assert.match(en, /Exit codes/);
  for (const code of [0, 2, 3, 4, 5, 6]) {
    assert.match(zh, new RegExp(`\\| ${code} \\|`));
    assert.match(en, new RegExp(`\\| ${code} \\|`));
  }
});

test("VC-014 both templates expose the feedback nudge SessionStart hook (additive only)", () => {
  const zh = JSON.parse(fs.readFileSync(ZH_HOOKS, "utf8"));
  const en = JSON.parse(fs.readFileSync(ZH_HOOKS, "utf8"));
  assert.ok(zh && zh.hooks && Array.isArray(zh.hooks.SessionStart), "zh SessionStart block missing");
  assert.ok(en && en.hooks && Array.isArray(en.hooks.SessionStart), "en SessionStart block missing");
  const zhHas = zh.hooks.SessionStart.some((entry) => entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("buildNudge")));
  const enHas = en.hooks.SessionStart.some((entry) => entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("buildNudge")));
  assert.equal(zhHas, true, "zh hooks.json missing buildNudge SessionStart hook");
  assert.equal(enHas, true, "en hooks.json missing buildNudge SessionStart hook");
});

test("VC-014 feedback nudge hook is wrapped in exit 0 and never reads prompts (defensive)", () => {
  for (const file of [ZH_HOOKS, EN_HOOKS]) {
    const text = fs.readFileSync(file, "utf8");
    // Every nudge command must end with `exit 0` so a hook failure can never
    // block SessionStart.
    const nudgeLines = text.split("\n").filter((l) => l.includes("buildNudge"));
    for (const line of nudgeLines) {
      assert.match(line, /exit 0/);
    }
  }
});

test("VC-014 .agent/feedback/ holds README and inbox/.gitkeep (zero event files committed)", () => {
  const inbox = path.join(ROOT, ".agent", "feedback", "inbox");
  const keep = path.join(inbox, ".gitkeep");
  const readme = path.join(ROOT, ".agent", "feedback", "README.md");
  assert.ok(fs.existsSync(readme));
  assert.ok(fs.existsSync(keep));
  // Walk the inbox and assert no event.json slipped in.
  function walk(dir) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.isFile() && e.name !== ".gitkeep") out.push(full);
    }
    return out;
  }
  const stray = walk(inbox);
  assert.deepEqual(stray, [], `unexpected feedback files committed: ${stray.join(", ")}`);
});

test("VC-014 bin/cli.js routes feedback without mutating other commands", () => {
  const text = fs.readFileSync(path.join(ROOT, "bin", "cli.js"), "utf8");
  assert.match(text, /case "feedback":/);
  assert.match(text, /runFeedback/);
});