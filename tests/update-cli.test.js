"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const REL = "skills/agent-dashboard/scripts/serve.js";
const TEMPLATE = path.join(ROOT, "templates", "_shared", ".agent", REL);

function sha(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function fixture({ userModified = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-update-cli-"));
  const target = path.join(cwd, ".agent", REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const installed = "// installed framework version\n";
  const current = userModified ? "// local project customization\n" : installed;
  fs.writeFileSync(target, current, "utf8");
  fs.writeFileSync(path.join(cwd, ".agent", ".script-manifest.json"), `${JSON.stringify({
    schema_version: 1,
    scripts: { [REL]: { origin_hash: sha(installed), sha256: sha(installed) } },
  }, null, 2)}\n`, "utf8");
  return { cwd, target, current };
}

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

test("update safely refreshes an unmodified managed script", (t) => {
  const { cwd, target } = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = run(cwd, ["update", "--lang", "en"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(TEMPLATE));
  assert.match(result.stdout, /Update complete/);
});

test("update preserves local script changes and reports partial completion", (t) => {
  const { cwd, target, current } = fixture({ userModified: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = run(cwd, ["update", "--lang", "en"]);
  assert.equal(result.status, 2, `${result.stderr}\n${result.stdout}`);
  assert.equal(fs.readFileSync(target, "utf8"), current);
  assert.match(`${result.stdout}\n${result.stderr}`, /Safe update partially complete/);
});

test("unknown commands fail instead of silently printing successful help", () => {
  const result = run(ROOT, ["updaet"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: updaet/);
});

test("help exposes the update command", () => {
  const result = run(ROOT, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /update\s+Add new files/);
});
