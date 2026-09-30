"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");

test("Dashboard supervisor passes the Cortex CLI path to the dashboard process", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "lib", "dashboard", "supervisor.js"),
    "utf8",
  );
  assert.match(source, /CORTEX_AGENT_CLI_PATH/);
  assert.match(source, /bin", "cli\.js"/);
});

test("Dashboard project/health APIs delegate to the project CLI read model", () => {
  const source = fs.readFileSync(
    path.join(
      ROOT,
      "templates",
      "_shared",
      ".agent",
      "skills",
      "agent-dashboard",
      "scripts",
      "serve.js",
    ),
    "utf8",
  );

  for (const endpoint of ["/api/projects", "/api/platform-health"]) {
    assert.equal(source.includes(endpoint), true, `missing ${endpoint}`);
  }
  assert.match(source, /CORTEX_AGENT_CLI_PATH/);
  assert.match(source, /\[cliPath, "project", \.\.\.args, "--json"\]/);
  assert.equal(source.includes(".agent/topology/projects.json"), false);
});
