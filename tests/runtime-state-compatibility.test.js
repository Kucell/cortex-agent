"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const FIXTURES = path.join(__dirname, "fixtures", "runtime-state");

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), "utf8"));
}

function emptyProjection(generatedAt) {
  return {
    ok: true,
    query: "runtime-state",
    generated_at: generatedAt,
    resources: [],
    summary: { total: 0, active: 0, blocked: 0, failed: 0, stale: 0, completed: 0 },
    recent_events: [],
    blocking: [],
    evidence_readiness: { ready: 0, missing: 0, unavailable: 0 },
  };
}

test("legacy projects without runtime, workspace, or MCP directories project as empty success", () => {
  const root = path.join(FIXTURES, "legacy-empty");
  assert.equal(readJson("legacy-empty", "project.json").fixture_version, 1);
  for (const absent of ["runtime", "workspaces", "mcp"]) {
    assert.equal(fs.existsSync(path.join(root, absent)), false, `${absent} must remain absent`);
  }

  const projection = emptyProjection("2026-07-19T08:00:00.000Z");
  assert.equal(projection.ok, true);
  assert.deepEqual(projection.resources, []);
  assert.deepEqual(projection.summary, { total: 0, active: 0, blocked: 0, failed: 0, stale: 0, completed: 0 });
});

test("an optional disabled MCP adapter does not degrade the core projection", () => {
  const projection = readJson("complete-projection", "projection.json");
  const capabilities = readJson("complete-projection", "capabilities.json");

  assert.equal(capabilities.mcp.enabled, false);
  assert.equal(capabilities.mcp.reason, "optional-adapter-disabled");
  assert.equal(capabilities.management_api.enabled, true);
  assert.equal(projection.ok, true);
  assert.equal(projection.resources.length, 1);
  assert.equal(projection.summary.completed, 1);
});

test("fixtures are canonical JSON, versioned where metadata is present, and contain no credential patterns", () => {
  const files = [];
  for (const fixture of fs.readdirSync(FIXTURES).sort()) {
    const fixtureFiles = fs.readdirSync(path.join(FIXTURES, fixture)).sort();
    const metadata = fixtureFiles
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson(fixture, name))
      .filter((value) => Object.prototype.hasOwnProperty.call(value, "fixture_version"));
    assert.equal(metadata.length, 1, `${fixture} must have exactly one versioned metadata document`);
    assert.equal(metadata[0].fixture_version, 1);
    for (const name of fixtureFiles) {
      if (name.endsWith(".json")) files.push(path.join(FIXTURES, fixture, name));
    }
  }
  const credentialPattern = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization|bearer\s+|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(raw, `${JSON.stringify(parsed, null, 2)}\n`, `${path.basename(file)} is not deterministic canonical JSON`);
    assert.equal(credentialPattern.test(raw), false, `${path.basename(file)} contains a credential-like field or value`);
    if (Object.prototype.hasOwnProperty.call(parsed, "fixture_version")) assert.equal(parsed.fixture_version, 1);
  }
});
