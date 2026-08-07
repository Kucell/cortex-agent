"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const REL = "skills/agent-dashboard/scripts/serve.js";
const TEMPLATE = path.join(ROOT, "templates", "_shared", ".agent", REL);
const { sha, buildManagedScriptsMap } = require("../helpers/managed-scripts");

function fixture({ userModified = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-update-cli-"));
  const target = path.join(cwd, ".agent", REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const installed = "// installed framework version\n";
  const current = userModified ? "// local project customization\n" : installed;
  fs.writeFileSync(target, current, "utf8");
  // Manifest must cover every managed template script so reconcileScripts
  // never reports `unmanaged_cold_start` for a script that the test did not
  // pre-register. The helper sets origin_hash to the post-walkAndAdd hash
  // (shared version when both en and _shared define the file, otherwise the
  // sole version), which lets the en overlay re-apply through
  // `stale_template` instead of leaving the file skipped.
  const scripts = buildManagedScriptsMap(ROOT);
  // Override serve.js with the test's dummy "installed" content so the
  // default fixture takes the stale_template path (project file gets
  // refreshed to the shared template) and the userModified fixture takes
  // the user_modified path (project file preserved, exit 2).
  scripts[REL] = { origin_hash: sha(installed), sha256: sha(installed) };
  fs.writeFileSync(path.join(cwd, ".agent", ".script-manifest.json"), `${JSON.stringify({
    schema_version: 1,
    scripts,
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
  assert.match(result.stdout, /update \[options\]\s+Add files and safely refresh/);
});
