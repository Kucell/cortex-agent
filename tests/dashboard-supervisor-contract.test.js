"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const LOCAL_SKILL = path.join(ROOT, ".agent", "skills", "dashboard-supervisor");
const SHARED_SKILL = path.join(ROOT, "templates", "_shared", ".agent", "skills", "dashboard-supervisor");
const contracts = require(path.join(LOCAL_SKILL, "scripts", "contracts.js"));
const classifier = require(path.join(LOCAL_SKILL, "scripts", "workload-classifier.js"));
const { resolveDashboardRoots } = require(path.join(LOCAL_SKILL, "scripts", "root-resolution.js"));

function runtimeState(overrides = {}) {
  return {
    schema_version: 1,
    status: "running",
    agent_root: "/tmp/project/.agent",
    dashboard_root: "/tmp/project",
    supervisor_pid: 101,
    dashboard_pid: 102,
    url: "http://127.0.0.1:8787",
    started_at: "2026-07-23T00:00:00.000Z",
    last_heartbeat_at: "2026-07-23T00:01:00.000Z",
    last_active_at: "2026-07-23T00:01:00.000Z",
    idle_deadline_at: null,
    last_reason: "dashboard_started",
    last_error: null,
    ...overrides,
  };
}

function classify(projections, options = {}) {
  return classifier.classifyWorkloads(projections, {
    now: "2026-07-23T00:05:00.000Z",
    startOn: contracts.START_REASONS,
    ...options,
  });
}

test("default policy is valid, disabled, strict, and localhost-only", () => {
  const local = JSON.parse(fs.readFileSync(path.join(ROOT, ".agent", "config", "dashboard-automation.json")));
  const shared = JSON.parse(fs.readFileSync(path.join(ROOT, "templates", "_shared", ".agent", "config", "dashboard-automation.json")));
  assert.deepEqual(local, shared);
  assert.equal(local.enabled, false);
  assert.equal(contracts.validateConfig(local).ok, true);
  assert.equal(contracts.validateConfig({ ...local, typo: true }).diagnostics[0].code, contracts.DIAGNOSTIC_CODES.CONFIG_INVALID);
  assert.equal(contracts.validateConfig({ ...local, localhost_only: false }).diagnostics[0].code, contracts.DIAGNOSTIC_CODES.REMOTE_BIND_FORBIDDEN);
});

test("runtime state enforces ownership, local URL, and state invariants", () => {
  assert.equal(contracts.validateSupervisorState(runtimeState()).ok, true);
  assert.equal(contracts.validateSupervisorState(runtimeState({ dashboard_pid: null })).diagnostics[0].code, contracts.DIAGNOSTIC_CODES.STATE_INVALID);
  assert.equal(contracts.validateSupervisorState(runtimeState({ url: "http://0.0.0.0:8787" })).ok, false);
  assert.equal(contracts.validateSupervisorState(runtimeState({ url: "file://localhost/tmp/dashboard" })).ok, false);
  assert.equal(contracts.validateSupervisorState(runtimeState({ started_at: "July 23 2026" })).ok, false);
  assert.equal(contracts.validateSupervisorState(runtimeState({ started_at: "2026-02-30T00:00:00Z" })).ok, false);
  assert.equal(contracts.validateSupervisorState(runtimeState({ started_at: "2026-07-23T24:00:00Z" })).ok, false);
  assert.equal(contracts.validateSupervisorState(runtimeState({
    status: "stopped",
    supervisor_pid: null,
    dashboard_pid: null,
    url: null,
  })).ok, true);
});

test("classifier detects explicit task, run, session, queue, and worktree activity", () => {
  const result = classify({
    tasks: [{ task_id: "T-1", status: "active", stage: "implement" }],
    runs: [{ run_id: "R-1", status: "running" }],
    sessions: [{ session_id: "S-1", status: "running", last_heartbeat_at: "2026-07-23T00:04:00.000Z" }],
    queues: [{ queue_id: "Q-1", items: [{ state: "running" }] }],
    worktrees: [{ worktree_id: "W-1", runtime_state: "handoff_required" }],
  });
  assert.equal(result.active, true);
  assert.deepEqual(result.reasons.map((reason) => reason.code), [
    "queue_running",
    "run_running",
    "session_running",
    "task_active",
    "worktree_handoff_required",
  ]);
});

test("classifier excludes stale and self-maintaining workloads", () => {
  const result = classify({
    runs: [
      { run_id: "R-dashboard", status: "running", role: "dashboard-manager" },
      { run_id: "R-continuity", status: "running", agent_id: "runtime-continuity" },
      { run_id: "R-query", status: "running", kind: "management-query" },
    ],
    sessions: [
      { session_id: "S-dashboard", status: "running", role: "dashboard-manager", last_heartbeat_at: "2026-07-23T00:04:30.000Z" },
      { session_id: "S-query", status: "running", operation: "query", last_heartbeat_at: "2026-07-23T00:04:30.000Z" },
      { session_id: "S-stale", status: "running", last_heartbeat_at: "2026-07-22T23:59:00.000Z" },
      { session_id: "S-paused-stale", status: "paused", last_heartbeat_at: "2026-07-22T23:59:00.000Z" },
    ],
  });
  assert.equal(result.active, false);
  assert.equal(result.state, "idle");
  assert.equal(result.excluded.length, 7);
  assert.ok(result.diagnostics.some((entry) => entry.code === contracts.DIAGNOSTIC_CODES.SESSION_STALE_EXCLUDED));
  assert.ok(result.diagnostics.some((entry) => entry.code === contracts.DIAGNOSTIC_CODES.SELF_WORKLOAD_EXCLUDED));
});

test("classifier is deterministic, preserves input, and ignores inferred activity fields", () => {
  const base = {
    tasks: [{ task_id: "T-1", status: "completed", stage: "done", updated_at: "2026-07-23T00:04:59.000Z", git_dirty: true, plan: "active" }],
    queues: [{ queue_id: "Q-1", status: "active", items: [{ state: "queued" }], mtime: Date.now() }],
  };
  const snapshot = JSON.stringify(base);
  const first = classify(base);
  const second = classify({
    tasks: [{ ...base.tasks[0], updated_at: "2099-01-01T00:00:00.000Z", git_dirty: false, plan: "running now" }],
    queues: [{ ...base.queues[0], dirty: true, mtime: 1 }],
  });
  assert.equal(first.active, false);
  assert.equal(second.active, false);
  assert.equal(first.state, "idle");
  assert.equal(JSON.stringify(base), snapshot);
  assert.deepEqual(classify(base), classify(base));
});

test("bad records do not hide valid active records", () => {
  const result = classify({ tasks: [null], runs: [{ run_id: "R-1", status: "running" }] });
  assert.equal(result.active, true);
  assert.ok(result.diagnostics.some((entry) => entry.code === contracts.DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID));
  assert.equal(classify({ runs: "unavailable" }).state, "indeterminate");
  assert.equal(classifier.classifyWorkloads({}, {}).state, "indeterminate");
  assert.equal(classifier.classifyWorkloads(null, { now: 1 }).state, "indeterminate");
  assert.equal(classifier.classifyWorkloads(42, { now: 1 }).state, "indeterminate");
  assert.equal(classifier.classifyWorkloads({}, { now: "July 23 2026" }).state, "indeterminate");
  const warning = result.diagnostics.find((entry) => entry.code === contracts.DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID);
  const sourceError = classify({ runs: "unavailable" }).diagnostics.find((entry) => entry.code === contracts.DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID);
  assert.equal(contracts.diagnosticExitCode(warning), contracts.EXIT_CODES.SUCCESS);
  assert.equal(contracts.diagnosticExitCode(sourceError), contracts.EXIT_CODES.UNAVAILABLE);
});

test("startOn controls trigger reasons without hiding active workloads", () => {
  const result = classify(
    { tasks: [{ task_id: "T-1", status: "active", stage: "implement" }] },
    { startOn: ["run_running"] },
  );
  assert.equal(result.active, true);
  assert.equal(result.trigger_active, false);
  assert.deepEqual(result.reasons.map((reason) => reason.code), ["task_active"]);
  assert.deepEqual(result.trigger_reasons, []);
});

test("canonical roots preserve one singleton and explicit owner across shared worktrees", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-roots-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sharedAgent = path.join(temp, "shared-agent");
  const owner = path.join(temp, "owner");
  const caller = path.join(temp, "caller");
  fs.mkdirSync(sharedAgent);
  fs.mkdirSync(owner);
  fs.mkdirSync(caller);
  fs.symlinkSync(sharedAgent, path.join(owner, ".agent"));
  fs.symlinkSync(sharedAgent, path.join(caller, ".agent"));

  const ownerResult = resolveDashboardRoots({ project: owner, operation: "enable" });
  const callerResult = resolveDashboardRoots({ project: caller, configuredDashboardRoot: owner, operation: "ensure" });
  assert.equal(ownerResult.ok, true);
  assert.equal(callerResult.ok, true);
  assert.equal(ownerResult.singleton_key, fs.realpathSync(sharedAgent));
  assert.equal(callerResult.singleton_key, ownerResult.singleton_key);
  assert.equal(callerResult.dashboard_root, fs.realpathSync(owner));
  assert.equal(callerResult.invocation_root, fs.realpathSync(caller));
  assert.equal(callerResult.shared_agent_root, true);
});

test("root resolver rejects missing and mismatched owners without rebinding", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-owner-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, "project");
  const other = path.join(temp, "other");
  fs.mkdirSync(path.join(project, ".agent"), { recursive: true });
  fs.mkdirSync(path.join(other, ".agent"), { recursive: true });
  const missing = resolveDashboardRoots({ project, configuredDashboardRoot: path.join(temp, "missing"), operation: "ensure" });
  const mismatch = resolveDashboardRoots({ project, configuredDashboardRoot: other, operation: "ensure" });
  assert.equal(missing.diagnostics[0].code, contracts.DIAGNOSTIC_CODES.OWNER_MISSING);
  assert.equal(mismatch.diagnostics[0].code, contracts.DIAGNOSTIC_CODES.OWNER_AGENT_ROOT_MISMATCH);
  assert.equal(mismatch.exit_code, contracts.EXIT_CODES.CONFLICT);
});

test("state transition table allows only frozen transitions", () => {
  for (const [from, targets] of Object.entries(contracts.STATE_TRANSITIONS)) {
    for (const to of targets) {
      const event = contracts.STATE_TRANSITION_EVENTS[from][to];
      assert.equal(contracts.validateTransition(from, to, event).ok, true, `${from} --${event}--> ${to}`);
      assert.equal(contracts.validateTransition(from, to, "recovery_failed").ok, event === "recovery_failed");
    }
  }
  const invalid = contracts.validateTransition("disabled", "running", "dashboard_started");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics[0].code, contracts.DIAGNOSTIC_CODES.STATE_TRANSITION_CONFLICT);
});

test("shared schemas are byte-identical and language overlays contain no supervisor copy", () => {
  for (const file of ["dashboard-automation.schema.json", "supervisor-state.schema.json"]) {
    assert.equal(
      fs.readFileSync(path.join(LOCAL_SKILL, "schemas", file), "utf8"),
      fs.readFileSync(path.join(SHARED_SKILL, "schemas", file), "utf8"),
    );
  }
  for (const language of ["en", "zh"]) {
    assert.equal(fs.existsSync(path.join(ROOT, "templates", language, ".agent", "skills", "dashboard-supervisor")), false);
    assert.equal(fs.existsSync(path.join(ROOT, "templates", language, ".agent", "config", "dashboard-automation.json")), false);
  }
});

test("shared implementation works after standalone installation", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-install-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const installed = path.join(temp, ".agent", "skills", "dashboard-supervisor");
  fs.cpSync(SHARED_SKILL, installed, { recursive: true });
  const installedContracts = require(path.join(installed, "scripts", "contracts.js"));
  const installedClassifier = require(path.join(installed, "scripts", "workload-classifier.js"));
  assert.equal(installedContracts.validateConfig({ ...installedContracts.DEFAULT_CONFIG }).ok, true);
  assert.equal(installedClassifier.classifyWorkloads({ runs: [{ run_id: "R", status: "running" }] }, {
    now: 1,
    startOn: installedContracts.START_REASONS,
  }).active, true);
});
