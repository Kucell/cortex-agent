"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const VARIANTS = ["_shared", "zh", "en"];

// The template tree has three layers and a file lives in exactly one of them
// (see rules/template-layer-dedup.md). A language-neutral implementation ships
// from _shared only; the language layer overrides it where the content
// actually differs.
//
// A project therefore receives the _shared copy plus its language overlay —
// which is exactly what `upgrade` lays down. This helper resolves the file
// the same way: look in the language layer first, then fall back to the
// shared base.
function resolveTemplateFile(lang, ...segments) {
  const layers = lang === "_shared" ? ["_shared"] : [lang, "_shared"];
  for (const layer of layers) {
    const candidate = path.join(ROOT, "templates", layer, ".agent", ...segments);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function seedProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-memory-lint-"));
  for (const type of ["user", "feedback", "project", "reference"]) {
    fs.mkdirSync(path.join(root, ".agent", "memory", type), { recursive: true });
  }
  fs.mkdirSync(path.join(root, ".agent", "skills", "knowledge-lint", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "memory", "MEMORY.md"), [
    "# Memory", "", "## user (1/10)", "", "## feedback (0/30)", "",
    "## project (0/20)", "", "## reference (0/50)", "",
  ].join("\n"));
  return root;
}

for (const variant of VARIANTS) {
  test(`knowledge-lint ${variant}: includes shared memory-integrity findings`, () => {
    const root = seedProject();
    try {
      const source = resolveTemplateFile(variant, "skills", "knowledge-lint", "scripts", "index.js");
      assert.ok(source, `knowledge-lint must ship for the ${variant} variant`);
      const target = path.join(root, ".agent", "skills", "knowledge-lint", "scripts", "index.js");
      fs.copyFileSync(source, target);
      const result = spawnSync(process.execPath, [target], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CORTEX_AGENT_CLI: CLI },
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(path.join(root, ".agent", "metrics", "knowledge-health.json"), "utf8"));
      assert.equal(report.summary.memory_integrity_issues, 1);
      assert.equal(report.findings.memory_integrity[0].kind, "drift");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
