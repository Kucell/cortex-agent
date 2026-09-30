"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  submitDaemonRequest,
  createQueuedRequestSource,
  listDaemonRequests,
} = require("../../lib/control-service/daemon-requests.js");
const {
  createFileIdempotencyStore,
} = require("../../lib/control-service/daemon-idempotency.js");
const {
  createLocalDaemonEngine,
} = require("../../lib/control-service/daemon-runtime.js");

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m041-daemon-req-"));
  fs.mkdirSync(path.join(dir, ".agent", "queues"), { recursive: true });
  return dir;
}

function request() {
  return {
    opt_in: true,
    task_id: "T-1",
    idempotency_key: "K-1",
    workflow_gate: "mission",
    runtime_requirement: {
      requirement_id: "RR-1",
      required_capabilities: ["runtime.run.create"],
    },
    endpoints: [{
      endpoint_ref: "runtime-endpoint:local:native:codex",
      host_ref: "host:local",
      runtime_ref: "runtime:native:codex",
      location: "local",
      transport: "stdio",
      availability: "available",
      descriptor: {
        protocol: "cortex-runtime",
        protocol_version: "1.0",
        implementation: "native-adapter:codex",
        capabilities: ["runtime.run.create"],
      },
      workspace_refs: [],
    }],
    host_requirement: {
      schema_version: "1.0",
      requirement_id: "HR-1",
      task_id: "T-1",
      created_at: "2026-09-30T04:00:00.000Z",
      required_capabilities: ["session.boundary", "tool.before.block"],
      minimum_capability_levels: { "tool.before.block": "native" },
      governance: {
        approved_decision_id: "D-1",
        require_active_lease: false,
      },
      preferred: {},
      ttl_at: "2026-09-30T06:00:00.000Z",
    },
    bindings: [{
      endpoint_ref: "runtime-endpoint:local:native:codex",
      snapshot: {
        schema_version: "1.0",
        snapshot_id: "SNAP-1",
        host_profile_ref: "H-codex",
        taken_at: "2026-09-30T04:00:00.000Z",
        capabilities: {
          "session.boundary": "native",
          "tool.before.block": "native",
        },
        governance: { approved: true, decision_id: "D-1" },
        lease: { active: true, holder: "owner" },
        reliability: { value: 1, source: "explicit-workflow", quality: "high" },
        cost: { value: 0, source: "explicit-workflow", quality: "high" },
        latency: { value: 1, source: "explicit-workflow", quality: "high" },
      },
    }],
  };
}

test("daemon request source requires both queued owner state and explicit opt-in sidecar", async () => {
  const project = root();
  try {
    submitDaemonRequest(project, request());

    let source = createQueuedRequestSource(project, {
      readDispatchState: () => ({ queued: [] }),
    });
    assert.deepEqual(await source(), []);

    source = createQueuedRequestSource(project, {
      readDispatchState: () => ({
        queued: [{ task_id: "T-1", queue_id: "Q-1" }],
      }),
    });
    const requests = await source();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].task_id, "T-1");
    assert.equal(requests[0].idempotency_key, "K-1");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("daemon request submission requires explicit opt-in", () => {
  const project = root();
  try {
    const value = request();
    value.opt_in = false;
    assert.throws(
      () => submitDaemonRequest(project, value),
      (error) => error.code === "ERR_DAEMON_REQUEST_OPT_IN",
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("durable daemon idempotency ledger survives store recreation", () => {
  const project = root();
  try {
    const first = createFileIdempotencyStore(project);
    first.mark("K-1", { status: "dispatched" });
    const second = createFileIdempotencyStore(project);
    assert.equal(second.has("K-1"), true);
    assert.equal(second.size(), 1);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("local daemon engine retries blocked requests and remembers only dispatched requests", async () => {
  const project = root();
  try {
    submitDaemonRequest(project, request());
    const source = createQueuedRequestSource(project, {
      readDispatchState: () => ({
        queued: [{ task_id: "T-1", queue_id: "Q-1" }],
      }),
    });

    let calls = 0;
    const engine = createLocalDaemonEngine(project, {
      requestSource: source,
      controlService: {
        async execute() {
          calls += 1;
          return calls === 1
            ? { status: "awaiting_authorization", reason: "decision_open" }
            : { status: "dispatched", dispatch_result: { ok: true } };
        },
      },
    });

    const first = await engine.tick();
    assert.equal(first.processed, 1);
    assert.equal(listDaemonRequests(project)[0].status, "pending");

    const second = await engine.tick();
    assert.equal(second.processed, 1);
    assert.equal(listDaemonRequests(project)[0].status, "processed");

    const third = await engine.tick();
    assert.equal(third.polled, 0);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
