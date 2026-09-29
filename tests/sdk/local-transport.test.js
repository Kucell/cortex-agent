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

test("local transport advertises a standard Cortex capability descriptor shape", () => {
  const text = require("node:fs").readFileSync(
    path.join(ROOT, "lib", "sdk", "local-transport.js"),
    "utf8",
  );
  assert.match(text, /schema_version:\s*"1"/);
  assert.match(text, /implementation:\s*"cortex-local-transport"/);
  assert.match(text, /protocol_version:\s*"1\.0"/);
  assert.equal(text.includes('transport: "local"'), false);
});
