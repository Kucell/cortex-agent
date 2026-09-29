"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const { filtersToArgs } = require(path.join(ROOT, "lib", "sdk", "local-transport.js"));

test("local SDK transport converts structured filters to existing Management CLI args", () => {
  assert.deepEqual(filtersToArgs({
    task: "T-1",
    state: "EXECUTING",
    ignored: null,
    enabled: true,
  }), [
    "--task", "T-1",
    "--state", "EXECUTING",
    "--enabled",
  ]);
});

test("local SDK transport repeats array-valued filters deterministically", () => {
  assert.deepEqual(filtersToArgs({ host: ["codex", "claude-code"] }), [
    "--host", "codex",
    "--host", "claude-code",
  ]);
});
