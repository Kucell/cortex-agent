"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const paseo = require(path.join(ROOT, "packages", "runtime-paseo", "src"));
const runtimePort = require(path.join(ROOT, "packages", "runtime-port", "src"));

function fakeClient() {
  const calls = [];
  const snapshots = new Map();

  function createHandle(id, initial = {}) {
    let current = {
      id,
      workspaceId: "WS-PASEO",
      cwd: "/tmp/project",
      status: "idle",
      archivedAt: null,
      pendingPermissions: [],
      lastError: null,
      ...initial,
    };
    const handle = {
      id,
      get workspaceId() { return current.workspaceId; },
      get cwd() { return current.cwd; },
      get status() { return current.status; },
      get archivedAt() { return current.archivedAt; },
      get pendingPermissions() { return current.pendingPermissions; },
      get lastError() { return current.lastError; },
      current() { return current; },
      async refresh() {
        calls.push(["refresh", id]);
        return { agent: current, project: null };
      },
      async send(text, options) {
        calls.push(["send", id, text, options]);
        current = { ...current, status: "running" };
      },
      async waitForFinish(timeoutMs) {
        calls.push(["wait", id, timeoutMs]);
        current = { ...current, status: "idle" };
        return {
          status: "idle",
          final: current,
          error: null,
          lastMessage: "done",
        };
      },
      timeline: {
        async refetch(options) {
          calls.push(["timeline", id, options]);
          return {
            agent: current,
            direction: "tail",
            projection: "projected",
            epoch: "epoch-1",
            reset: false,
            startCursor: { epoch: "epoch-1", seq: 4 },
            endCursor: { epoch: "epoch-1", seq: 5 },
            hasOlder: true,
            hasNewer: false,
            entries: [
              {
                provider: "codex",
                item: {
                  type: "assistant_message",
                  text: "secret-user-content-not-forwarded",
                  turnId: "turn-1",
                },
                timestamp: "2026-09-29T07:00:00.000Z",
                seq: 4,
                epoch: "epoch-1",
              },
              {
                provider: "codex",
                item: {
                  type: "tool_call",
                  status: "completed",
                  input: { password: "must-not-forward" },
                  turnId: "turn-1",
                },
                timestamp: "2026-09-29T07:00:01.000Z",
                seq: 5,
                epoch: "epoch-1",
              },
            ],
            error: null,
          };
        },
      },
      async archive() {
        calls.push(["archive", id]);
        current = { ...current, status: "closed", archivedAt: "2026-09-29T07:10:00.000Z" };
        return { archivedAt: current.archivedAt };
      },
    };
    snapshots.set(id, handle);
    return handle;
  }

  const client = {
    calls,
    async connect() {
      calls.push(["connect"]);
    },
    async close() {
      calls.push(["close"]);
    },
    getConnectionState() {
      return { status: "connected" };
    },
    agents: {
      async create(options) {
        calls.push(["create", options]);
        return createHandle(options.agentId || "agent-1", { cwd: options.cwd, status: "initializing" });
      },
      ref(id) {
        calls.push(["ref", id]);
        return snapshots.get(id) || createHandle(id);
      },
    },
  };
  return client;
}

test("Paseo adapter uses truthful public-SDK RuntimePort capabilities", () => {
  const runtime = paseo.createPaseoRuntime({
    url: "ws://127.0.0.1:6767/ws",
    clientFactory: async () => fakeClient(),
  });

  const caps = runtime.port.descriptor.capabilities;
  assert.ok(caps.includes("runtime.run.create"));
  assert.ok(caps.includes("runtime.run.send"));
  assert.ok(caps.includes("runtime.run.wait"));
  assert.ok(caps.includes("runtime.timeline.read"));
  assert.ok(caps.includes("runtime.run.archive"));
  assert.equal(caps.includes("runtime.run.cancel"), false);
  assert.throws(
    () => runtime.port.cancel("run:paseo:agent-1"),
    (error) => error.code === "ERR_RUNTIME_CAPABILITY_UNSUPPORTED",
  );
});

test("Paseo createRun maps public agent handle to canonical RunRef", async () => {
  const client = fakeClient();
  const runtime = paseo.createPaseoRuntime({
    url: "ws://127.0.0.1:6767/ws",
    clientFactory: async () => client,
  });

  const result = await runtime.port.createRun({
    cwd: "/work/axrail",
    provider: "codex/gpt-5",
    prompt: "Review this project",
  }, {
    idempotency_key: "M-040:MS-010:1",
  });

  assert.equal(result.run_ref, "run:paseo:agent-1");
  assert.equal(result.status, "created");
  const create = client.calls.find((call) => call[0] === "create");
  assert.equal(create[1].config.provider, "codex/gpt-5");
  assert.equal(create[1].cwd, "/work/axrail");
  assert.equal(create[1].prompt, "Review this project");
  assert.equal(create[1].idempotencyKey, "M-040:MS-010:1");
  await runtime.close();
});

test("Paseo send/status/wait preserve reusable session semantics", async () => {
  const client = fakeClient();
  const runtime = paseo.createPaseoRuntime({
    url: "ws://127.0.0.1:6767/ws",
    clientFactory: async () => client,
  });
  const created = await runtime.port.createRun({
    cwd: "/work/demo",
    provider: "claude/sonnet",
  });

  await runtime.port.send(created.run_ref, "continue");
  const running = await runtime.port.getStatus(created.run_ref);
  assert.equal(running.status, "running");

  const waited = await runtime.port.wait(created.run_ref, { timeout_ms: 1234 });
  assert.equal(waited.status, "waiting");
  assert.equal(waited.result.wait_status, "idle");
  assert.equal(waited.result.last_message, "done");
  assert.equal(waited.evidence.timed_out, false);
  await runtime.close();
});

test("Paseo lifecycle mapping does not confuse idle with completion", () => {
  assert.equal(paseo.normalizeAgentStatus({ status: "initializing" }), "created");
  assert.equal(paseo.normalizeAgentStatus({ status: "running" }), "running");
  assert.equal(paseo.normalizeAgentStatus({ status: "idle" }), "waiting");
  assert.equal(paseo.normalizeAgentStatus({ status: "error" }), "failed");
  assert.equal(paseo.normalizeAgentStatus({ status: "closed" }), "stopped");
  assert.equal(
    paseo.normalizeAgentStatus({ status: "closed", archivedAt: "2026-09-29T00:00:00Z" }),
    "archived",
  );
});

test("Paseo timeline is normalized to redacted CortexEvent records with epoch sequence", async () => {
  const client = fakeClient();
  const runtime = paseo.createPaseoRuntime({
    url: "ws://127.0.0.1:6767/ws",
    clientFactory: async () => client,
    runtime_ref: "runtime:paseo:test",
  });
  const created = await runtime.port.createRun({
    cwd: "/work/demo",
    provider: "codex/gpt-5",
  });

  const timeline = await runtime.port.getTimeline(created.run_ref, {
    project_ref: "project:cortex-agent",
    host_ref: "host:mac-mini",
    mission_id: "M-040",
    milestone_id: "MS-010",
    task_id: "T-PASEO",
  });

  assert.equal(timeline.events.length, 2);
  assert.equal(timeline.events[0].type, "runtime.paseo.assistant.message");
  assert.equal(timeline.events[0].source.runtime_ref, "runtime:paseo:test");
  assert.equal(timeline.events[0].source.host_ref, "host:mac-mini");
  assert.equal(timeline.events[0].correlation.run_ref, created.run_ref);
  assert.deepEqual(timeline.events[0].sequence, {
    stream_id: "paseo:agent-1:epoch-1",
    value: 4,
  });
  assert.equal(timeline.events[0].redacted, true);
  assert.equal(JSON.stringify(timeline).includes("secret-user-content-not-forwarded"), false);
  assert.equal(JSON.stringify(timeline).includes("must-not-forward"), false);
  assert.equal(timeline.cursor.position, "epoch:epoch-1:seq:4");
  assert.equal(timeline.next_cursor.position, "epoch:epoch-1:seq:5");
  assert.equal(timeline.reconciliation.required, false);
  await runtime.close();
});

test("Paseo timeline reset explicitly requires reconciliation", () => {
  const normalized = paseo.normalizePaseoTimeline(
    "agent-1",
    "run:paseo:agent-1",
    {
      epoch: "epoch-2",
      reset: true,
      direction: "tail",
      projection: "projected",
      startCursor: null,
      endCursor: null,
      hasOlder: false,
      hasNewer: false,
      entries: [],
      error: null,
    },
    { runtime_ref: "runtime:paseo" },
  );
  assert.equal(normalized.reconciliation.required, true);
  assert.equal(normalized.reconciliation.reason, "paseo_timeline_reset_or_epoch_replacement");
});

test("Paseo archive maps to RuntimePort archived state", async () => {
  const client = fakeClient();
  const runtime = paseo.createPaseoRuntime({
    url: "ws://127.0.0.1:6767/ws",
    clientFactory: async () => client,
  });
  const created = await runtime.port.createRun({
    cwd: "/work/demo",
    provider: "codex/gpt-5",
  });
  const result = await runtime.port.archive(created.run_ref);
  assert.equal(result.status, "archived");
  assert.equal(result.archived_at, "2026-09-29T07:10:00.000Z");
  await runtime.close();
});

test("Paseo health reports connection failures without throwing", async () => {
  const runtime = paseo.createPaseoRuntime({
    url: "ws://127.0.0.1:6767/ws",
    clientFactory: async () => ({
      agents: { create() {} },
      async connect() { throw new Error("daemon unavailable"); },
    }),
  });
  const health = await runtime.port.health();
  assert.equal(health.ready, false);
  assert.equal(health.status, "down");
  assert.match(health.error, /daemon unavailable/);
});

test("Paseo public SDK dependency remains optional at module load", () => {
  assert.equal(typeof paseo.createPaseoRuntime, "function");
  assert.equal(typeof paseo.defaultClientFactory, "function");
});

test("Paseo RunRef accepts only the adapter namespace", () => {
  assert.equal(paseo.paseoRunRef("agent-7"), "run:paseo:agent-7");
  assert.equal(paseo.paseoAgentId("run:paseo:agent-7"), "agent-7");
  assert.throws(
    () => paseo.paseoAgentId("run:native:agent-7"),
    (error) => error.code === "ERR_PASEO_RUN_REF",
  );
});
