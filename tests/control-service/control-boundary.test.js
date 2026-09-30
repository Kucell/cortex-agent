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

test("daemon and trigger public CLI remain Phase 0 fail-closed while Control Service core stabilizes", () => {
  const contract = require(path.join(ROOT, "lib", "cli", "contract.js"));
  for (const name of ["daemon", "trigger"]) {
    const entry = contract.commands.find((item) => item.name === name);
    assert.equal(entry.mode, "phase0_stub");
    assert.equal(entry.implemented, false);
    assert.equal(entry.default_enabled === false || name === "trigger", true);
  }
});
