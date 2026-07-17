"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CLI = path.resolve(__dirname, "..", "bin", "cli.js");

function createProject(handlerSource) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-management-cli-"));
  const script = path.join(cwd, ".agent", "skills", "management-api", "scripts", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `"use strict";\n${handlerSource}\n`, "utf8");
  return cwd;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
  });
}

function queryFixture(resource, values) {
  return `
const fs = require("fs");
fs.writeFileSync("management-call.json", JSON.stringify(process.argv.slice(2)));
const resource = process.argv[3];
const values = ${JSON.stringify(values)};
process.stdout.write(JSON.stringify({
  ok: true,
  query: resource,
  generated_at: "2026-07-17T00:00:00.000Z",
  [resource]: values[resource],
  summary: { total: values[resource].length }
}));
if (resource !== ${JSON.stringify(resource)}) process.exitCode = 9;
`;
}

test("runs list forwards to the focused Management API query", (t) => {
  const runs = [{ run_id: "R-002", status: "running" }];
  const cwd = createProject(queryFixture("runs", { runs }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = runCli(cwd, ["runs", "list"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).runs, runs);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "management-call.json"))), ["query", "runs"]);
});

test("runs show selects an exact run from the Management API read model", (t) => {
  const runs = [
    { run_id: "R-001", status: "completed" },
    { run_id: "R-010", status: "running", activity: "Validating" },
  ];
  const cwd = createProject(queryFixture("runs", { runs }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = runCli(cwd, ["runs", "show", "R-010"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload.query, "run");
  assert.deepEqual(payload.run, runs[1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "management-call.json"))), ["query", "runs"]);
});

test("runs show reports missing IDs and unknown runs precisely", (t) => {
  const cwd = createProject(queryFixture("runs", { runs: [] }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const missing = runCli(cwd, ["runs", "show"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage: cortex-agent runs show <run-id>/);
  assert.equal(fs.existsSync(path.join(cwd, "management-call.json")), false);

  const hiddenRun = path.join(cwd, ".agent", "runs", "R-missing.json");
  fs.mkdirSync(path.dirname(hiddenRun), { recursive: true });
  fs.writeFileSync(hiddenRun, JSON.stringify({ run_id: "R-missing" }), "utf8");
  const unknown = runCli(cwd, ["runs", "show", "R-missing"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Run not found: R-missing/);
});

for (const resource of ["queues", "sessions"]) {
  test(`${resource} list forwards to its focused Management API query`, (t) => {
    const item = resource === "queues"
      ? { queue_id: "Q-001", status: "active", items: [] }
      : { session_id: "S-001", status: "stale", stale: true };
    const cwd = createProject(queryFixture(resource, { [resource]: [item] }));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

    const result = runCli(cwd, [resource, "list"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout)[resource], [item]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "management-call.json"))), ["query", resource]);
  });
}

test("management commands fail clearly when the Management API is unavailable", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-management-cli-missing-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = runCli(cwd, ["queues", "list"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Management API query failed/);
  assert.match(result.stderr, /Missing \.agent\/skills\/management-api\/scripts\/index\.js/);
});
