"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const cliContract = require("../../lib/cli/contract.js");
const { executeCoordinationCommand } = require("../../lib/coordination/cli");
const { createEvent, STATES } = require("../../lib/coordination/contract");
const { validatePublishSource } = require("../../lib/team-pack/index.js");

const ROOT = path.resolve(__dirname, "..", "..");

test("task CLI delegates writes and reads without duplicating state rules", () => {
  const calls = [];
  const service = {
    submit(event) { calls.push(["submit", event]); return { event, task: { state: "CREATED" } }; },
    getTask(taskId) { calls.push(["getTask", taskId]); return { taskId, state: "CREATED" }; },
    listTasks() { calls.push(["listTasks"]); return []; },
    listEvents(filter) { calls.push(["listEvents", filter]); return []; },
  };
  const event = { eventType: "task.created", taskId: "T-1" };
  const created = executeCoordinationCommand(["task", "create", "--event-json", JSON.stringify(event)], { service });
  assert.equal(created.ok, true);
  assert.deepEqual(calls[0], ["submit", event]);

  const status = executeCoordinationCommand(["task", "status", "--task", "T-1"], { service });
  assert.equal(status.task.taskId, "T-1");
  assert.deepEqual(calls[1], ["getTask", "T-1"]);

  const mismatch = executeCoordinationCommand([
    "task", "ready", "--event-json", JSON.stringify({ eventType: "task.completed" }),
  ], { service });
  assert.equal(mismatch.error.code, "EVENT_TYPE_MISMATCH");
  assert.equal(calls.length, 2);
});

test("task create, assign, and accept construct events from restricted fields", () => {
  const events = [];
  const service = {
    submit(event) {
      events.push(event);
      return { event, task: { state: event.currentState } };
    },
    getTask(taskId) {
      if (taskId !== "T-FIELDS") return null;
      if (events.length === 0) return null;
      const last = events.at(-1);
      return {
        taskId,
        projectId: "project",
        correlationId: "CORR-FIELDS",
        state: last.currentState,
      };
    },
  };
  const common = ["--task", "T-FIELDS", "--actor", "coordinator", "--session", "S-1"];
  const created = executeCoordinationCommand([
    "task", "create", ...common, "--project-id", "project", "--correlation-id", "CORR-FIELDS",
  ], { service });
  assert.equal(created.ok, true);
  assert.equal(events[0].eventType, "task.created");
  assert.equal(events[0].currentState, STATES.CREATED);

  const assigned = executeCoordinationCommand([
    "task", "assign", ...common, "--assignee", "pi",
  ], { service });
  assert.equal(assigned.ok, true);
  assert.deepEqual(events[1].targets, [{ actorId: "pi", kind: "agent" }]);

  const accepted = executeCoordinationCommand([
    "task", "accept", "--task", "T-FIELDS", "--actor", "pi", "--session", "S-PI",
  ], { service });
  assert.equal(accepted.ok, true);
  assert.equal(events[2].eventType, "task.accepted");
  assert.equal(events[2].producer.kind, "agent");

  const rejected = executeCoordinationCommand([
    "task", "create", ...common, "--project-id", "project", "--correlation-id", "CORR-INVALID",
    "--unexpected", "value",
  ], { service });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "UNKNOWN_OPTIONS_REJECTED");
});

test("task CLI accepts only the bounded auth context contract", () => {
  const calls = [];
  const service = {
    submit(event, authContext) {
      calls.push(authContext);
      return { event, task: { state: "CREATED" } };
    },
  };
  const event = { eventType: "task.created", taskId: "T-1" };
  const invalid = executeCoordinationCommand([
    "task", "create", "--event-json", JSON.stringify(event),
    "--auth-context-json", JSON.stringify({
      actorId: "coordinator", kind: "coordinator", sessionId: "session-1",
      workflowGate: "M-008", trusted: true,
    }),
  ], { service });
  assert.equal(invalid.error.code, "INVALID_AUTH_CONTEXT");
  assert.equal(calls.length, 0);

  const valid = executeCoordinationCommand([
    "task", "create", "--event-json", JSON.stringify(event),
    "--auth-context-json", JSON.stringify({
      actorId: "coordinator", kind: "coordinator", sessionId: "session-1",
      workflowGate: "M-008",
    }),
  ], { service });
  assert.equal(valid.ok, true);
  assert.deepEqual(calls[0], {
    actorId: "coordinator", kind: "coordinator", sessionId: "session-1",
    workflowGate: "M-008",
  });
});

test("event ACK uses an injected store and never calls task submit", () => {
  let submitted = false;
  const service = {
    submit() { submitted = true; },
    listEvents(filter) { return [filter]; },
  };
  const acknowledgements = {
    ack(input) { return { ...input, duplicate: false }; },
  };
  const result = executeCoordinationCommand([
    "event", "ack", "--event", "CE-1", "--consumer", "codex",
  ], { service, acknowledgements });
  assert.equal(result.ok, true);
  assert.equal(result.acknowledgement.eventId, "CE-1");
  assert.equal(submitted, false);
});

test("public task CLI opens the real Application Service for writes", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-cli-"));
  const event = createEvent({
    eventId: "CE-cli-create",
    projectId: "project",
    taskId: "T-CLI",
    correlationId: "CORR-CLI",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    repository: { repositoryId: "repo" },
    notification: { policy: "journal_only", dedupeKey: "cli" },
  });
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "bin/cli.js"), "task", "create", "--project", project,
    "--event-json", JSON.stringify(event),
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.task.state, STATES.CREATED);
  assert.equal(fs.readdirSync(path.join(project, ".agent/runtime/coordination/tasks")).length, 1);
  assert.equal(
    fs.readFileSync(path.join(project, ".agent/runtime/coordination/.gitignore"), "utf8"),
    "*\n!.gitignore\n"
  );
  fs.rmSync(project, { recursive: true, force: true });
});

test("public task CLI keeps task state with leases in the legacy runtime before activation", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-legacy-cli-"));
  const legacyRuntime = path.join(project, ".agent-runtime", "coordination");
  fs.mkdirSync(legacyRuntime, { recursive: true });
  const event = createEvent({
    eventId: "CE-legacy-cli-create",
    projectId: "project",
    taskId: "T-LEGACY-CLI",
    correlationId: "CORR-LEGACY-CLI",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-09-10T00:00:00.000Z",
    repository: { repositoryId: "repo" },
    notification: { policy: "journal_only", dedupeKey: "legacy-cli" },
  });
  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "bin/cli.js"), "task", "create", "--project", project,
      "--event-json", JSON.stringify(event),
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readdirSync(path.join(legacyRuntime, "tasks")).length, 1);
    assert.equal(fs.existsSync(path.join(project, ".agent", "runtime", "coordination", "tasks")), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("public task CLI resolves workflow gates from the project mission registry", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-gate-"));
  const run = (action, event, authContext) => spawnSync(process.execPath, [
    path.join(ROOT, "bin/cli.js"), "task", action, "--project", project,
    "--event-json", JSON.stringify(event),
    ...(authContext
      ? ["--auth-context-json", JSON.stringify(authContext)]
      : []),
  ], { cwd: ROOT, encoding: "utf8" });
  const base = {
    projectId: "project",
    taskId: "T-GATE",
    correlationId: "CORR-GATE",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [],
    timestamp: "2026-07-28T00:00:00.000Z",
    repository: { repositoryId: "repo" },
    notification: { policy: "journal_only", dedupeKey: "gate" },
  };
  try {
    assert.equal(run("create", createEvent({
      ...base, eventId: "CE-gate-create", eventType: "task.created",
      previousState: null, currentState: STATES.CREATED, sequence: 1,
    })).status, 0);
    assert.equal(run("assign", createEvent({
      ...base, eventId: "CE-gate-assign", eventType: "task.assigned",
      previousState: STATES.CREATED, currentState: STATES.ASSIGNED, sequence: 2,
      targets: [{ actorId: "agent", kind: "agent" }],
    })).status, 0);
    const cancellation = createEvent({
      ...base, eventId: "CE-gate-cancel", eventType: "task.cancel_requested",
      previousState: STATES.ASSIGNED,
      currentState: STATES.CANCEL_REQUESTED,
      sequence: 3,
    });
    const claim = {
      actorId: "coordinator", kind: "coordinator",
      sessionId: "session-coordinator", workflowGate: "M-008",
    };
    const unknown = run("cancel", cancellation, claim);
    assert.equal(unknown.status, 3);
    assert.equal(JSON.parse(unknown.stdout).error.code, "ERR_ACTOR_MISMATCH");

    const mission = path.join(project, ".agent/missions/M-008");
    fs.mkdirSync(mission, { recursive: true });
    fs.writeFileSync(path.join(mission, "mission-plan.md"), "# M-008\n");
    const registered = run("cancel", cancellation, claim);
    assert.equal(registered.status, 0, registered.stderr || registered.stdout);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("public event ACK opens a durable consumer store", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-ack-"));
  const event = createEvent({
    eventId: "CE-cli-ack",
    projectId: "project",
    taskId: "T-ACK",
    correlationId: "CORR-ACK",
    producer: { actorId: "coordinator", kind: "coordinator" },
    targets: [{ actorId: "codex", kind: "coordinator" }],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    sequence: 1,
    repository: { repositoryId: "repo" },
    notification: { policy: "coordinator_notify", dedupeKey: "ack", ackRequired: true },
  });
  const create = spawnSync(process.execPath, [
    path.join(ROOT, "bin/cli.js"), "task", "create", "--project", project,
    "--event-json", JSON.stringify(event),
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(create.status, 0, create.stderr);
  const ack = spawnSync(process.execPath, [
    path.join(ROOT, "bin/cli.js"), "event", "ack", "--project", project,
    "--event", event.eventId, "--consumer", "codex",
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(ack.status, 0, ack.stderr);
  assert.equal(JSON.parse(ack.stdout).acknowledgement.acknowledged, true);
  assert.equal(fs.readdirSync(
    path.join(project, ".agent/runtime/coordination/consumers")
  ).filter((name) => name.endsWith(".json")).length, 1);
  fs.rmSync(project, { recursive: true, force: true });
});

test("CLI and MCP contracts expose read-only coordination capabilities", () => {
  assert.ok(cliContract.commands.some((entry) => entry.name === "task"));
  assert.ok(cliContract.commands.some((entry) => entry.name === "event"));
  assert.equal(cliContract.management.coordination.mcp_default, "read_only");
  assert.equal(cliContract.management.coordination.writer_profile_default, false);
  assert.match(cliContract.management.coordination.safety, /No arbitrary set_state/);

  const registry = JSON.parse(fs.readFileSync(path.join(
    ROOT, "templates/_shared/.agent/skills/management-api/scripts/projection-registry.json"
  ), "utf8"));
  for (const name of cliContract.management.coordination.projections) {
    assert.ok(registry.projections.some((entry) => entry.name === name));
  }
});

test("focused Management API projections read runtime state without writing", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-query-"));
  const runtime = path.join(project, ".agent/runtime/coordination");
  fs.mkdirSync(path.join(runtime, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "journal"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "consumers"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "leases"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "tasks/T-1.json"), JSON.stringify({
    schemaVersion: "1.0",
    payload: { taskId: "T-1", state: "EXECUTING" },
  }));
  fs.writeFileSync(path.join(runtime, "journal/events-000001.jsonl"), `${JSON.stringify({
    v: 1,
    event: {
      eventId: "CE-1", taskId: "T-1", eventType: "task.progress",
      producer: { actorId: "claude" },
    },
    prevHash: "0".repeat(64),
    hash: "1".repeat(64),
  })}\n`);
  fs.writeFileSync(path.join(runtime, "leases/state.json"), JSON.stringify({
    version: 1,
    leases: [{ leaseId: "LEASE-1", scope: "src/**", owner: "claude", taskId: "T-1" }],
    takeovers: [],
    audit: [],
  }));
  fs.writeFileSync(path.join(runtime, "consumers/consumer.json"), JSON.stringify({
    consumerId: "codex", pending: { delivery: { eventId: "CE-1", taskId: "T-1" } },
  }));
  const before = fs.statSync(path.join(runtime, "tasks/T-1.json")).mtimeMs;
  const { queryCoordination } = require("../../templates/_shared/.agent/skills/management-api/scripts/query-coordination");
  const tasks = queryCoordination({ root: project, args: ["--state", "EXECUTING"], projection: "coordination-tasks" });
  const events = queryCoordination({ root: project, args: ["--producer", "claude"], projection: "coordination-events" });
  const notifications = queryCoordination({ root: project, args: ["--task", "T-1"], projection: "coordination-notifications" });
  const ownership = queryCoordination({ root: project, args: ["--task", "T-1"], projection: "coordination-ownership" });
  assert.equal(tasks.tasks.length, 1);
  assert.equal(events.events.length, 1);
  assert.equal(notifications.notifications.length, 1);
  assert.equal(ownership.ownership.length, 1);
  assert.equal(fs.statSync(path.join(runtime, "tasks/T-1.json")).mtimeMs, before);
  fs.rmSync(project, { recursive: true, force: true });
});

test("Management API reads legacy task state before layout activation despite a stale new runtime", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-query-legacy-"));
  const legacyRuntime = path.join(project, ".agent-runtime", "coordination");
  const staleNewRuntime = path.join(project, ".agent", "runtime", "coordination");
  fs.mkdirSync(path.join(legacyRuntime, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(staleNewRuntime, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(legacyRuntime, "tasks", "T-LEGACY.json"), JSON.stringify({
    schemaVersion: "1.0",
    payload: { taskId: "T-LEGACY", state: "CREATED" },
  }));
  try {
    const { queryCoordination } = require("../../templates/_shared/.agent/skills/management-api/scripts/query-coordination");
    const result = queryCoordination({
      root: project,
      args: ["--task", "T-LEGACY"],
      projection: "coordination-tasks",
    });
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].taskId, "T-LEGACY");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// Regression: the layout activation marker proves the new namespace owns
// future writes; it does not prove every pre-existing record was migrated. A
// Task snapshot that only exists under .agent-runtime/ must stay readable, and
// a committed lease in the same legacy namespace must stay visible, otherwise
// the public task read path reports null for work that really exists.
test("Management API falls back to legacy coordination records after layout activation", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-query-activated-legacy-"));
  const legacyRuntime = path.join(project, ".agent-runtime", "coordination");
  const newRuntime = path.join(project, ".agent", "runtime", "coordination");
  fs.mkdirSync(path.join(legacyRuntime, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(legacyRuntime, "journal"), { recursive: true });
  fs.mkdirSync(path.join(legacyRuntime, "leases"), { recursive: true });
  fs.mkdirSync(path.join(newRuntime, "tasks"), { recursive: true });
  // Activation marker present: new layout is active for writes.
  fs.writeFileSync(path.join(project, ".agent", "runtime", "layout.json"), "{}\n");
  fs.writeFileSync(path.join(legacyRuntime, "tasks", "T-LEGACY-ONLY.json"), JSON.stringify({
    schemaVersion: "1.0",
    payload: { taskId: "T-LEGACY-ONLY", state: "CREATED" },
  }));
  fs.writeFileSync(path.join(legacyRuntime, "tasks", "T-BOTH.json"), JSON.stringify({
    schemaVersion: "1.0",
    payload: { taskId: "T-BOTH", state: "FAILED" },
  }));
  fs.writeFileSync(path.join(newRuntime, "tasks", "T-BOTH.json"), JSON.stringify({
    schemaVersion: "1.0",
    payload: { taskId: "T-BOTH", state: "READY_FOR_REVIEW" },
  }));
  fs.writeFileSync(path.join(legacyRuntime, "journal", "events-000001.jsonl"), [
    JSON.stringify({
      v: 1,
      event: { eventId: "CE-LEGACY-1", taskId: "T-LEGACY-ONLY", eventType: "task.created" },
      prevHash: "0".repeat(64),
      hash: "2".repeat(64),
    }),
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(legacyRuntime, "leases", "state.json"), JSON.stringify({
    version: 1,
    leases: [{ leaseId: "LEASE-LEGACY", scope: "src/**", owner: "claude", taskId: "T-LEGACY-ONLY" }],
    takeovers: [],
    audit: [],
  }));
  try {
    const { queryCoordination } = require("../../templates/_shared/.agent/skills/management-api/scripts/query-coordination");
    const tasks = queryCoordination({ root: project, args: [], projection: "coordination-tasks" });
    const ids = tasks.tasks.map((task) => task.taskId).sort();
    assert.deepEqual(ids, ["T-BOTH", "T-LEGACY-ONLY"]);
    // New-layout record wins for an identity present in both namespaces.
    assert.equal(tasks.tasks.find((task) => task.taskId === "T-BOTH").state, "READY_FOR_REVIEW");

    const exact = queryCoordination({
      root: project,
      args: ["--task", "T-LEGACY-ONLY"],
      projection: "coordination-tasks",
    });
    assert.equal(exact.tasks.length, 1);
    assert.equal(exact.tasks[0].taskId, "T-LEGACY-ONLY");

    const events = queryCoordination({ root: project, args: [], projection: "coordination-events" });
    assert.ok(events.events.some((event) => event.eventId === "CE-LEGACY-1"));

    const ownership = queryCoordination({
      root: project,
      args: ["--task", "T-LEGACY-ONLY"],
      projection: "coordination-ownership",
    });
    assert.equal(ownership.ownership.length, 1);
    assert.equal(ownership.ownership[0].leaseId, "LEASE-LEGACY");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("Team Pack allows policy but rejects coordination runtime records", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coordination-pack-"));
  fs.mkdirSync(path.join(project, "source"), { recursive: true });
  fs.writeFileSync(path.join(project, "source/policy.json"), "{}\n");
  assert.equal(validatePublishSource(
    project, "source/policy.json", "coordination/notification-policy.json"
  ).ok, true);
  const runtime = validatePublishSource(project, "source/policy.json", "coordination/tasks/T-1.json");
  assert.equal(runtime.ok, false);
  assert.equal(runtime.reason, "coordination_runtime_excluded");
  fs.rmSync(project, { recursive: true, force: true });
});
