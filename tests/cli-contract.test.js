"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const contract = require("../lib/cli-contract");

test("machine-readable help covers every dispatched public command", () => {
  const source = fs.readFileSync(CLI, "utf8");
  const dispatched = [...source.matchAll(/case\s+"([a-z][a-z-]*)"\s*:/g)].map((match) => match[1]);
  const registered = contract.commands.map((entry) => entry.name);
  assert.deepEqual([...new Set(dispatched)].sort(), [...registered].sort());

  const result = spawnSync(process.execPath, [CLI, "help", "--json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.contract.discovery_command, "cortex-agent help --json");
  assert.deepEqual(payload.contract.management.writers, contract.management.writers);
});

test("query help can discover real project capabilities", () => {
  const result = spawnSync(process.execPath, [CLI, "help", "query", "--json", "--project", ROOT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.contract.commands[0].name, "query");
  assert.equal(payload.management_capabilities.projections.some((entry) => entry.name === "activity"), true);
  assert.equal(payload.project.root, ROOT);
});
