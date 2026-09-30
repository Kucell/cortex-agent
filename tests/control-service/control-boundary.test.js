"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");

test("Control Service core owns no filesystem/process/network persistence", () => {
  const text = fs.readFileSync(
    path.join(ROOT, "lib", "control-service", "service.js"),
    "utf8",
  );
  for (const forbidden of [
    "node:fs",
    "child_process",
    "node:http",
    "node:https",
    ".agent/",
    ".agent-runtime/",
  ]) {
    assert.equal(text.includes(forbidden), false, `control core must not contain ${forbidden}`);
  }
});

test("M-041 daemon host is opt-in while trigger remains Phase 0 fail-closed", () => {
  const contract = require(path.join(ROOT, "lib", "cli", "contract.js"));
  const daemon = contract.commands.find((item) => item.name === "daemon");
  assert.equal(daemon.mode, "control_service_daemon");
  assert.equal(daemon.implemented, true);
  assert.equal(daemon.default_enabled, false);
  assert.equal(daemon.automatic_dispatch_enabled, false);

  const trigger = contract.commands.find((item) => item.name === "trigger");
  assert.equal(trigger.mode, "phase0_stub");
  assert.equal(trigger.implemented, false);
});
