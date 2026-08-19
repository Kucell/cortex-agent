"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const MANAGEMENT_FILES = [
  "index.js",
  "normalize-token-usage.js",
  "projection-registry.json",
  "query-token-attempts.js",
  "token-attempt-ledger.js",
  "token-attempt-receipt.js",
  "query-activity.js",
  "query-coordination.js",
  "query-dispatch-state.js",
  "query-governed-attempt.js",
  // MS-004 R1: task-state / run-state projections backed by dedicated
  // query-* scripts (lib/commands/management/api-helpers).
  "query-task-state.js",
  "query-run-state.js",
];

function createProject(prefix = "cortex-management-cli-") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const scripts = path.join(cwd, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of MANAGEMENT_FILES) {
    const source = path.join(
      ROOT,
      "templates",
      "_shared",
      ".agent",
      "skills",
      "management-api",
      "scripts",
      file
    );
    fs.copyFileSync(source, path.join(scripts, file));
  }
  fs.mkdirSync(path.join(cwd, ".agent", "tasks", "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
    path.join(cwd, ".agent", "tasks", "scripts", "task-state.js"),
  );
  for (const directory of ["runs", "queues", "sessions", "inbox", "decisions", "waitpoints", "plans"]) {
    fs.mkdirSync(path.join(cwd, ".agent", directory), { recursive: true });
  }
  fs.writeFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "# Task progress\n", "utf8");
  // Seed minimal task-state and run-state fixtures so the exact-lookup
  // projections have a target during e2e.
  fs.writeFileSync(path.join(cwd, ".agent", "tasks", "T-QUERY-EXACT.json"), `${JSON.stringify({ task_id: "T-QUERY-EXACT", title: "E2E fixture", status: "ready_for_review", acceptance_criteria: [], validation_commands: [] })}\n`);
  fs.writeFileSync(path.join(cwd, ".agent", "runs", "R-QUERY-EXACT.json"), `${JSON.stringify({ run_id: "R-QUERY-EXACT", task_id: "T-QUERY-EXACT", kind: "implement", status: "running", started_at: "2026-07-23T00:00:00.000Z", events: [] })}\n`);
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
    // exact_lookup=true projections need an explicit identifier; pick a
    // placeholder that the test fixture does not need to materialise
    // because the assertions below only inspect envelope shape.
    let exactArgs = [];
    if (entry.exact_lookup) {
      const filter = (entry.filters && entry.filters[0]) || "task-id";
      // task-* projections need a T-* id; run-* projections need an R-* id;
      // dispatch-plan / triggers / others can reuse the same T-/R- fixtures.
      const isRun = entry.name.startsWith("run-");
      const placeholder = isRun ? "R-QUERY-EXACT" : "T-QUERY-EXACT";
      exactArgs = [`--${filter}`, placeholder];
    }
    const result = run(caller, ["query", entry.name, "--project", project, ...exactArgs]);
    assert.equal(result.status, 0, `${entry.name}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "query");
    assert.equal(payload.projection, entry.name);
    if (!Object.prototype.hasOwnProperty.call(payload, "data")) console.error(`MISSING data field on ${entry.name}: keys=${Object.keys(payload)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(payload, "data"));
    if (entry.name === "activity") assert.equal(payload.filters.inclusive, true);
    else assert.deepEqual(payload.filters, {});
    // activity projection always emits an informational warning about records
    // without valid structured timestamps. dispatch-state emits an
    // informational "run for task_id=X already exists" warning whenever the
    // fixture already contains a run for that exact id. Filter those out; other
    // projections must not emit any warnings.
    const warningsFiltered = payload.warnings.filter(
      (w) => !/unknown_time/i.test(w) && !/already exists; use --force or pick a fresh/i.test(w),
    );
    assert.deepEqual(warningsFiltered, [], `unexpected warnings for ${entry.name}: ${JSON.stringify(payload.warnings)}`);
    assert.equal(payload.project.root, fs.realpathSync(project));
    assert.equal(payload.project.agent_root, fs.realpathSync(path.join(project, ".agent")));
  }
});

test("operation lifecycle projections filter through the public CLI and redact private fields", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const operations = path.join(project, ".agent", "operations");
  fs.mkdirSync(operations, { recursive: true });
  fs.writeFileSync(path.join(operations, "OP-QUERY-1.json"), JSON.stringify({
    schema_version: "1.0",
    operation_id: "OP-QUERY-1",
    status: "authorized",
    relations: { task_id: "T-QUERY-1", run_id: "R-QUERY-1", session_id: "S-QUERY-1" },
    input_summary: { redacted: true, prompt: "must-not-leak" },
  }));
  fs.writeFileSync(path.join(operations, "OP-QUERY-2.json"), JSON.stringify({
    schema_version: "1.0",
    operation_id: "OP-QUERY-2",
    status: "failed",
    relations: { task_id: "T-QUERY-2", run_id: "R-QUERY-2", session_id: "S-QUERY-2" },
  }));

  const result = run(project, [
    "query", "operations", "--project", project,
    "--task", "T-QUERY-1", "--status", "authorized",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].operation_id, "OP-QUERY-1");
  assert.equal(payload.data[0].input_summary.prompt, "[REDACTED]");
  assert.doesNotMatch(result.stdout, /must-not-leak/);

  const fixtures = {
    readiness: {
      file: "RD-QUERY-1.json",
      value: { readiness_id: "RD-QUERY-1", revision: "REV-1", verdict: "ready" },
      args: ["--status", "ready"],
    },
    authorizations: {
      file: "AUTH-QUERY-1.json",
      value: {
        authorization_id: "AUTH-QUERY-1",
        revision: "AUTH-REV-1",
        consumed_operation_ids: ["OP-QUERY-1"],
        reason: "-----BEGIN PRIVATE KEY----- fake",
      },
      args: ["--operation", "OP-QUERY-1"],
    },
    checkpoints: {
      file: "CHK-QUERY-1.json",
      value: { checkpoint_id: "CHK-QUERY-1", operation_id: "OP-QUERY-1", task_id: "T-QUERY-1" },
      args: ["--operation", "OP-QUERY-1"],
    },
  };
  for (const [projection, fixture] of Object.entries(fixtures)) {
    const directory = path.join(project, ".agent", projection);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, fixture.file), JSON.stringify(fixture.value));
    const queried = run(project, ["query", projection, "--project", project, ...fixture.args]);
    assert.equal(queried.status, 0, queried.stderr);
    const projected = JSON.parse(queried.stdout);
    assert.equal(projected.data.length, 1, projection);
    assert.doesNotMatch(queried.stdout, /BEGIN PRIVATE KEY/, projection);
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

test("legacy projects without capabilities fall through to the direct query", (t) => {
  // Pre-1.9.0 Management APIs (1.6.0–1.8.x) do not expose a `capabilities`
  // projection. The `query` CLI must not refuse every projection just because
  // the registry handshake is unavailable; instead it surfaces the underlying
  // Management API response so the user can see whether the legacy dispatcher
  // handled the projection or rejected it.
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const script = path.join(project, ".agent", "skills", "management-api", "scripts", "index.js");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ok:false,error:'unsupported_command'})); process.exitCode=2;\n", "utf8");
  const result = run(project, ["query", "runs"]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "UNSUPPORTED_COMMAND");
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

test("dashboard state keeps validation evidence separate from task blocking", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, ".agent", "plans", "task-progress.md"), [
    "# Task progress",
    "",
    "## Active Tasks",
    "",
    "| Task ID | Priority | Task | Progress | Plan |",
    "| --- | --- | --- | --- | --- |",
    "| M-005 | P1 | Observability | 94% | Runtime evidence PARTIAL; release evidence remains NOT_RUN |",
    "| T-004 | P1 | Target benchmark | 65% | Two target environments remain NOT_RUN |",
    "| T-009 | P0 | Explicit blocker | 20% | Status: blocked |",
  ].join("\n"), "utf8");

  const result = run(project, ["query", "dashboard-state"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const tasks = new Map(payload.data.tasks.map((task) => [task.id, task]));
  assert.equal(tasks.get("M-005").status, "active");
  assert.equal(tasks.get("M-005").validation_status, "NOT_RUN");
  assert.equal(tasks.get("T-004").status, "active");
  assert.equal(tasks.get("T-004").validation_status, "NOT_RUN");
  assert.equal(tasks.get("T-009").status, "blocked");
});
