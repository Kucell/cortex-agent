"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cli = path.resolve(__dirname, "../../bin/cli.js");

test("local-publish-validate propagates child failure through the CLI", () => {
  const result = spawnSync(process.execPath, [cli, "local-publish-validate", "--unknown-test-option"], {
    encoding: "utf8", timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option/);
});

test("local-publish-validate help exits successfully", () => {
  const result = spawnSync(process.execPath, [cli, "local-publish-validate", "--help"], {
    encoding: "utf8", timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
});
