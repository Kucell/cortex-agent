"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const contract = require("../lib/cli-contract");

test("management CLI exposes only explicit projections and writer actions", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(contract.management.writers, "write"), false);
  for (const forbidden of ["exec", "patch", "daemon", "dispatch", "trigger"]) {
    assert.equal(contract.commands.some((entry) => entry.name === forbidden), false);
    const result = spawnSync(process.execPath, [CLI, forbidden, "anything"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 2);
  }
  const result = spawnSync(process.execPath, [CLI, "runs", "arbitrary", "--project", ROOT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2);
});
