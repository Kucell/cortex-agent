"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { resolveTemplatePath, templateSurface } = require("../helpers/template-layers");

const ROOT = path.resolve(__dirname, "..", "..");
function markdownFiles(lang) {
  return [...templateSurface(lang)]
    .filter(([name]) => path.posix.dirname(name) === "workflows" && name.endsWith(".md"))
    .map(([, file]) => file);
}

test("standard workflows use public Management CLI commands", () => {
  const offenders = [];
  for (const lang of ["zh", "en"]) {
    let publicCalls = 0;
    for (const file of markdownFiles(lang)) {
      const source = fs.readFileSync(file, "utf8");
      if (source.includes(".agent/skills/management-api/scripts/index.js")) offenders.push(path.relative(ROOT, file));
      publicCalls += (source.match(/cortex-agent (?:query|runs|queues|sessions|decisions|inbox|waitpoints)\b/g) || []).length;
    }
    assert.ok(publicCalls >= 10, `expected broad CLI migration in ${lang} workflows, found ${publicCalls} calls`);
  }
  assert.deepEqual(offenders, []);
});

test("Management API skills teach CLI discovery and debug-only fallback", () => {
  for (const file of [
    resolveTemplatePath("skills/management-api/SKILL.md", "zh"),
    resolveTemplatePath("skills/management-api/SKILL.md", "en"),
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /cortex-agent help --json/);
    assert.match(source, /cortex-agent help query --json --project/);
    assert.match(source, /implementation\/debug|实现、调试/);
    assert.doesNotMatch(source, /^node \.agent\/skills\/management-api\/scripts\/index\.js/gm);
  }
});
