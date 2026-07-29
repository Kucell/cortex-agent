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
  for (const forbidden of ["exec", "patch"]) {
    assert.equal(contract.commands.some((entry) => entry.name === forbidden), false);
    const result = spawnSync(process.execPath, [CLI, forbidden, "anything"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 2);
  }
  for (const name of ["daemon", "trigger"]) {
    const entry = contract.commands.find((item) => item.name === name);
    assert.equal(entry.mode, "phase0_stub");
    assert.equal(entry.implemented, false);
    assert.equal(Object.prototype.hasOwnProperty.call(contract.management.writers, name), false);
    const result = spawnSync(process.execPath, [CLI, name, "anything", "--json"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "PHASE_ZERO_STUB");
    assert.equal(payload.side_effects, false);
  }
  const dispatch = contract.commands.find((entry) => entry.name === "dispatch");
  assert.equal(dispatch.mode, "governed_manual");
  assert.equal(dispatch.implemented, true);
  assert.equal(dispatch.automatic_dispatch_enabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(contract.management.writers, "dispatch"), false);
  const result = spawnSync(process.execPath, [CLI, "runs", "arbitrary", "--project", ROOT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2);
});
