"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const ROOTS = [
  path.join(ROOT, "templates", "zh", ".agent", "workflows"),
  path.join(ROOT, "templates", "en", ".agent", "workflows"),
];

function markdownFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => path.join(dir, name));
}

test("standard workflows use public Management CLI commands", () => {
  const offenders = [];
  for (const root of ROOTS) {
    let publicCalls = 0;
    for (const file of markdownFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      if (source.includes(".agent/skills/management-api/scripts/index.js")) offenders.push(path.relative(ROOT, file));
      publicCalls += (source.match(/cortex-agent (?:query|runs|queues|sessions|decisions|inbox|waitpoints)\b/g) || []).length;
    }
    assert.ok(publicCalls >= 10, `expected broad CLI migration in ${path.relative(ROOT, root)}, found ${publicCalls} calls`);
  }
  assert.deepEqual(offenders, []);
});

test("Management API skills teach CLI discovery and debug-only fallback", () => {
  for (const file of [
    path.join(ROOT, "templates", "zh", ".agent", "skills", "management-api", "SKILL.md"),
    path.join(ROOT, "templates", "en", ".agent", "skills", "management-api", "SKILL.md"),
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /cortex-agent help --json/);
    assert.match(source, /cortex-agent help query --json --project/);
    assert.match(source, /implementation\/debug|实现、调试/);
    assert.doesNotMatch(source, /^node \.agent\/skills\/management-api\/scripts\/index\.js/gm);
  }
});
