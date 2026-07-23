"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

for (const language of ["en", "zh"]) {
  test(`init installs activity recording baseline for ${language}`, () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-activity-${language}-`));
    const result = spawnSync(process.execPath, [path.join(root, "bin", "cli.js"), "init", "--lang", language, "--platforms", "codex"], {
      cwd,
      encoding: "utf8"
    });
    assert.strictEqual(result.status, 0, result.stderr);
    for (const file of [
      ".agent/config/activity-recording.yml",
      ".agent/activities/activity-event.schema.json",
      ".agent/activities/activity-receipt.schema.json",
      ".agent/activities/activity-source-health.schema.json",
      ".agent/activities/index.schema.json",
      ".agent/skills/activity-recording/scripts/index.js"
    ]) {
      assert.ok(fs.existsSync(path.join(cwd, file)), file);
    }
  });
}
