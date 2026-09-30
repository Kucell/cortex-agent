"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  createLocalControlService,
} = require(path.join(ROOT, "lib", "control-service", "local.js"));
const {
  createPaseoRuntime,
} = require(path.join(ROOT, "packages", "runtime-paseo", "src"));

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m040-e2e-"));
  for (const sub of ["runs", "queues", "sessions", "decisions", "waitpoints", "locks"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function fakePaseoClient() {
  const handles = new Map();
  function handle(id, cwd) {
    let state = {
      id,
      workspaceId: "WS-E2E",
      cwd,
      status: "idle",
      archivedAt: null,
      pendingPermissions: [],
      lastError: null,
    };
    const h = {
      id,
      get workspaceId() { return state.workspaceId; },
      get cwd() { return state.cwd; },
      get status() { return state.status; },
      get archivedAt() { return state.archivedAt; },
      get pendingPermissions() { return state.pendingPermissions; },
      get lastError() { return state.lastError; },
      current() { return state; },
      async refresh() { return { agent: state, project: null }; },
      async send() { state = { ...state, status: "running" }; },
      async waitForFinish() {
        state = { ...state, status: "idle" };
        return { status: "idle", final: state, error: null, lastMessage: "validated" };
      },
      timeline: {
        async refetch() {
          return {
            agent: state,
            direction: "tail",
            projection: "projected",
            epoch: "epoch-e2e",
            reset: false,
            startCursor: { epoch: "epoch-e2e", seq: 1 },
            endCursor: { epoch: "epoch-e2e", seq: 2 },
            hasOlder: false,
            hasNewer: false,
            entries: [
              {
                provider: "codex",
                item: { type: "assistant_message", text: "private agent output", turnId: "turn-1" },
                timestamp: "2026-09-29T08:00:01.000Z",
                seq: 1,
                epoch: "epoch-e2e",
              },
              {
                provider: "codex",
                item: { type: "tool_call", status: "completed", input: { secret: "hidden" }, turnId: "turn-1" },
                timestamp: "2026-09-29T08:00:02.000Z",
                seq: 2,
                epoch: "epoch-e2e",
              },
            ],
            error: null,
          };
        },
      },
      async archive() {
        state = { ...state, status: "closed", archivedAt: "2026-09-29T08:10:00.000Z" };
        return { archivedAt: state.archivedAt };
      },
    };
    handles.set(id, h);
    return h;
  }

  return {
    async connect() {},
    async close() {},
    getConnectionState() { return { status: "connected" }; },
    agents: {
      async create(options) { return handle("agent-e2e", options.cwd); },
      ref(id) { return handles.get(id) || handle(id, "/tmp"); },
    },
  };
}

function hostRequirement(now) {
  return {
    schema_version: "1.0",
    requirement_id: "HOST-E2E",
    task_id: "T-E2E",
    created_at: now,
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: { approved_decision_id: "D-E2E", require_active_lease: false },
    preferred: {},
    ttl_at: "2026-09-29T09:00:00.000Z",
  };
}

function snapshot(now) {
  return {
    schema_version: "1.0",
    snapshot_id: "SNAP-PASEO-E2E",
    host_profile_ref: "H-paseo-codex",
    taken_at: now,
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
    },
    governance: { approved: true, decision_id: "D-E2E" },
    lease: { active: true, holder: "cortex" },
    reliability: { value: 1, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.2, source: "explicit-workflow", quality: "high" },
    latency: { value: 10, source: "explicit-workflow", quality: "high" },
  };
}

test("M-040 governed E2E flows through routing, authorization, Paseo, CortexEvent and verification", async () => {
  const root = mkProject();
  const now = "2026-09-29T08:00:00.000Z";
  const paseo = createPaseoRuntime({
    url: "ws://127.0.0.1:6767/ws",
    runtime_ref: "runtime:paseo:e2e",
    clientFactory: async () => fakePaseoClient(),
  });

  const endpoint = {
    endpoint_ref: "runtime-endpoint:local:paseo:e2e",
    host_ref: "host:local",
    runtime_ref: "runtime:paseo:e2e",
    location: "local",
    transport: "websocket",
    availability: "available",
    descriptor: paseo.port.descriptor,
    workspace_refs: ["workspace:WS-E2E"],
  };

  try {
    const service = createLocalControlService({
      clock: () => now,
      authorize(input) {
        assert.equal(input.task_id, "T-E2E");
        assert.equal(input.selection.runtime_ref, "runtime:paseo:e2e");
        return { authorized: true, authorization_ref: "decision:D-E2E" };
      },
      async dispatch(input) {
        const created = await paseo.port.createRun({
          cwd: root,
          provider: "codex/gpt-5",
          prompt: "execute bounded E2E fixture",
        }, {
          idempotency_key: input.idempotency_key,
        });
        await paseo.port.send(created.run_ref, "continue");
        const waited = await paseo.port.wait(created.run_ref, { timeout_ms: 1000 });
        const timeline = await paseo.port.getTimeline(created.run_ref, {
          project_ref: "project:cortex-agent",
          host_ref: "host:local",
          workspace_ref: "workspace:WS-E2E",
          mission_id: "M-040",
          milestone_id: "MS-011",
          task_id: "T-E2E",
        });
        return {
          run_ref: created.run_ref,
          wait: waited,
          timeline,
          verification_evidence: {
            authorization_ref: input.authorization_ref,
            event_count: timeline.events.length,
            reconciliation_required: timeline.reconciliation.required,
          },
        };
      },
    });

    const result = await service.execute({
      project_root: root,
      task_id: "T-E2E",
      idempotency_key: "M-040:MS-011:E2E",
      workflow_gate: "mission",
      now,
      runtime_requirement: {
        requirement_id: "RUNTIME-E2E",
        required_capabilities: [
          "runtime.run.create",
          "runtime.run.send",
          "runtime.run.wait",
          "runtime.timeline.read",
        ],
        endpoint_ref: "runtime-endpoint:local:paseo:e2e",
        workspace_ref: "workspace:WS-E2E",
      },
      endpoints: [endpoint],
      host_requirement: hostRequirement(now),
      bindings: [{
        endpoint_ref: endpoint.endpoint_ref,
        snapshot: snapshot(now),
      }],
    });

    assert.equal(result.status, "dispatched");
    assert.equal(result.authorization.authorization_ref, "decision:D-E2E");
    assert.equal(result.plan.mutation_evidence.mutated_count, 0);
    assert.equal(result.dispatch_result.run_ref, "run:paseo:agent-e2e");
    assert.equal(result.dispatch_result.wait.status, "waiting");
    assert.equal(result.dispatch_result.timeline.events.length, 2);
    assert.equal(result.dispatch_result.timeline.reconciliation.required, false);
    assert.equal(result.dispatch_result.verification_evidence.event_count, 2);
    assert.equal(result.dispatch_result.verification_evidence.authorization_ref, "decision:D-E2E");
    assert.equal(
      result.dispatch_result.timeline.events.every((event) =>
        event.correlation.mission_id === "M-040"
        && event.correlation.milestone_id === "MS-011"
        && event.redacted === true),
      true,
    );
    const serialized = JSON.stringify(result.dispatch_result.timeline);
    assert.equal(serialized.includes("private agent output"), false);
    assert.equal(serialized.includes("hidden"), false);
  } finally {
    await paseo.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
