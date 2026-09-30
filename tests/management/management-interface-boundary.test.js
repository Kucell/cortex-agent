"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const contract = require("../../lib/cli/contract.js");

test("management CLI exposes only explicit projections and writer actions", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(contract.management.writers, "write"), false);
  for (const forbidden of ["exec", "patch"]) {
    assert.equal(contract.commands.some((entry) => entry.name === forbidden), false);
    const result = spawnSync(process.execPath, [CLI, forbidden, "anything"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 2);
  }
  const daemon = contract.commands.find((item) => item.name === "daemon");
  assert.equal(daemon.mode, "control_service_daemon");
  assert.equal(daemon.implemented, true);
  assert.equal(daemon.default_enabled, false);
  assert.equal(daemon.automatic_dispatch_enabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(contract.management.writers, "daemon"), false);
  const daemonStatus = spawnSync(process.execPath, [CLI, "daemon", "status", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(daemonStatus.status, 0);
  const daemonPayload = JSON.parse(daemonStatus.stdout);
  assert.equal(daemonPayload.read_only, true);

  const trigger = contract.commands.find((item) => item.name === "trigger");
  assert.equal(trigger.mode, "phase0_stub");
  assert.equal(trigger.implemented, false);
  assert.equal(Object.prototype.hasOwnProperty.call(contract.management.writers, "trigger"), false);
  const triggerResult = spawnSync(process.execPath, [CLI, "trigger", "anything", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(triggerResult.status, 2);
  const triggerPayload = JSON.parse(triggerResult.stdout);
  assert.equal(triggerPayload.error.code, "PHASE_ZERO_STUB");
  assert.equal(triggerPayload.side_effects, false);
  const dispatch = contract.commands.find((entry) => entry.name === "dispatch");
  assert.equal(dispatch.mode, "governed_manual");
  assert.equal(dispatch.implemented, true);
  assert.equal(dispatch.automatic_dispatch_enabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(contract.management.writers, "dispatch"), false);
  const result = spawnSync(process.execPath, [CLI, "runs", "arbitrary", "--project", ROOT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2);
});
