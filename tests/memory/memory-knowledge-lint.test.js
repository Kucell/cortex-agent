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
      const source = path.join(ROOT, "templates", variant, ".agent", "skills", "knowledge-lint", "scripts", "index.js");
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
