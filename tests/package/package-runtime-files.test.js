"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");

test("npm package includes the governed launch runtime dependency", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const [{ files }] = JSON.parse(output);
  assert.ok(
    files.some(({ path: file }) => file === "scripts/codex-p002-shadow-pilot.js"),
    "package must include scripts/codex-p002-shadow-pilot.js required by governed launch",
  );
});
