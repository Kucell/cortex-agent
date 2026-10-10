"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

test("root, npm lockfile and bundled Claude plugin versions remain identical", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.deepEqual(lock.packages[""].engines, pkg.engines);
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.metadata.version, pkg.version);
  const entries = marketplace.plugins.filter((entry) => entry.name === pkg.name);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, pkg.version);
});

test("the current release version is documented", () => {
  const version = readJson("package.json").version;
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes("## [" + version + "]"), "missing current release changelog entry");
});
