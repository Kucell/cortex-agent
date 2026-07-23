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

function digestTree(root) {
  const hash = crypto.createHash("sha256");
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relative = path.relative(root, file);
      const stat = fs.lstatSync(file);
      hash.update(relative);
      if (stat.isDirectory()) visit(file);
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else hash.update(fs.readFileSync(file));
    }
  };
  visit(root);
  return hash.digest("hex");
}

test("focused, aggregate, and activity queries do not mutate managed state", () => {
  const before = digestTree(path.join(ROOT, ".agent"));
  for (const args of [
    ["query", "runs", "--project", ROOT],
    ["query", "dashboard-state", "--project", ROOT],
    ["query", "activity", "--project", ROOT, "--since", "2026-07-01", "--until", "2026-07-31"],
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, LANG: "en_US.UTF-8" } });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(digestTree(path.join(ROOT, ".agent")), before);
});
