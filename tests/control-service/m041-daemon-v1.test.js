"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createDaemonEngine,
  createMemoryIdempotencyStore,
} = require("../../lib/control-service/daemon-engine.js");
const {
  createDaemonHealthProducer,
} = require("../../lib/control-service/daemon-health.js");
const {
  readState,
  writeOwner,
  writeState,
} = require("../../lib/control-service/daemon-state.js");
const protocol = require("../../packages/protocol/src");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m041-daemon-"));
}

test("daemon engine delegates complete requests through Control Service and dedupes replays", async () => {
  const calls = [];
  const store = createMemoryIdempotencyStore();
  const engine = createDaemonEngine({
    concurrencyLimit: 2,
    idempotency: store,
    requestSource: async () => [
      { task_id: "T-1", idempotency_key: "K-1" },
      { task_id: "T-2", idempotency_key: "K-2" },
    ],
    controlService: {
      async execute(request) {
        calls.push(request.task_id);
        return { status: "dispatched", task_id: request.task_id };
      },
    },
  });

  const first = await engine.tick();
  const second = await engine.tick();

  assert.equal(first.processed, 2);
  assert.equal(second.processed, 0);
  assert.equal(second.skipped, 2);
  assert.deepEqual(calls.sort(), ["T-1", "T-2"]);
  assert.equal(store.size(), 2);
});

test("daemon engine fails closed when a request lacks idempotency key", async () => {
  const engine = createDaemonEngine({
    requestSource: async () => [{ task_id: "T-1" }],
    controlService: { execute: async () => ({ status: "dispatched" }) },
  });
  await assert.rejects(
    () => engine.tick(),
    (error) => error.code === "ERR_DAEMON_IDEMPOTENCY_REQUIRED",
  );
});

test("daemon PlatformHealth reports optional stopped daemon as healthy", async () => {
  const root = tempRoot();
  try {
    const producer = createDaemonHealthProducer(root);
    const components = await producer.produce({ now: "2026-09-30T03:30:00.000Z" });
    const snapshot = protocol.normalizePlatformHealth({
      generated_at: "2026-09-30T03:30:00.000Z",
      components,
    });
    assert.equal(snapshot.overall, "healthy");
    assert.equal(components[0].checks.find((item) => item.id === "request.source").status, "healthy");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("daemon PlatformHealth reports running daemon without request source as degraded", async () => {
  const root = tempRoot();
  try {
    writeState(root, {
      enabled: true,
      status: "running",
      pid: process.pid,
      started_at: "2026-09-30T03:00:00.000Z",
      last_heartbeat_at: "2026-09-30T03:29:59.000Z",
    });
    writeOwner(root, {
      schema_version: 1,
      pid: process.pid,
      token: "test",
      project_root: root,
      started_at: "2026-09-30T03:00:00.000Z",
    });

    const producer = createDaemonHealthProducer(root, {
      request_source_configured: false,
    });
    const components = await producer.produce({ now: "2026-09-30T03:30:00.000Z" });
    assert.equal(components[0].status, "degraded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
