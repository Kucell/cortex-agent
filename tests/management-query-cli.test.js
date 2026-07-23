"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const MANAGEMENT_FILES = [
  "index.js",
  "normalize-token-usage.js",
  "projection-registry.json",
  "query-activity.js",
];

function createProject(prefix = "cortex-management-cli-") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const scripts = path.join(cwd, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of MANAGEMENT_FILES) {
    const source = file === "query-activity.js"
      ? path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", file)
      : path.join(ROOT, ".agent", "skills", "management-api", "scripts", file);
    fs.copyFileSync(source, path.join(scripts, file));
  }
  for (const directory of ["runs", "queues", "sessions", "inbox", "decisions", "waitpoints", "plans"]) {
    fs.mkdirSync(path.join(cwd, ".agent", directory), { recursive: true });
  }
  fs.writeFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "# Task progress\n", "utf8");
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
  });
}

test("generic query delegates every registered core projection", (t) => {
  const project = createProject();
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-management-caller-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(caller, { recursive: true, force: true }));

  const capabilities = run(caller, ["query", "capabilities", "--project", project]);
  assert.equal(capabilities.status, 2, "capabilities is metadata, not a public projection");

  const registry = JSON.parse(fs.readFileSync(path.join(project, ".agent", "skills", "management-api", "scripts", "projection-registry.json")));
  for (const entry of registry.projections) {
    const result = run(caller, ["query", entry.name, "--project", project]);
    assert.equal(result.status, 0, `${entry.name}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "query");
    assert.equal(payload.projection, entry.name);
    assert.ok(Object.prototype.hasOwnProperty.call(payload, "data"));
    if (entry.name === "activity") assert.equal(payload.filters.inclusive, true);
    else assert.deepEqual(payload.filters, {});
    assert.deepEqual(payload.warnings, []);
    assert.equal(payload.project.root, fs.realpathSync(project));
    assert.equal(payload.project.agent_root, fs.realpathSync(path.join(project, ".agent")));
  }
});

test("generic query rejects projections outside target capabilities", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const result = run(project, ["query", "workspaces"]);
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "UNSUPPORTED_PROJECTION");
  assert.ok(payload.error.details.supported.includes("runs"));
});

test("capabilities omit registry entries without real query handlers", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const registryFile = path.join(project, ".agent", "skills", "management-api", "scripts", "projection-registry.json");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.projections.push({ name: "not-implemented", kind: "collection", exact_lookup: false, filters: [] });
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const script = path.join(project, ".agent", "skills", "management-api", "scripts", "index.js");
  const result = spawnSync(process.execPath, [script, "query", "capabilities"], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.projections.some((entry) => entry.name === "not-implemented"), false);
});

test("missing project option values fail with structured usage errors", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  for (const args of [["query", "runs", "--project"], ["query", "runs", "--project="], ["query", "runs", "--project", "--status", "running"]]) {
    const result = run(project, args);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_PROJECT_OPTION");
  }
});

test("legacy projects without capabilities return a fallback-safe error", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const script = path.join(project, ".agent", "skills", "management-api", "scripts", "index.js");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ok:false,error:'unsupported_command'})); process.exitCode=2;\n", "utf8");
  const result = run(project, ["query", "runs"]);
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).error.code, "CAPABILITY_UNAVAILABLE");
});

test("existing resource aliases honor explicit projects", (t) => {
  const project = createProject();
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-management-alias-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(caller, { recursive: true, force: true }));
  for (const args of [["runs", "list"], ["queues", "list"], ["sessions", "list"]]) {
    const result = run(caller, [...args, "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).project.root, fs.realpathSync(project));
  }
});
