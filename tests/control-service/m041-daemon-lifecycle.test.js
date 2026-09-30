"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const lifecycle = require("../../lib/control-service/daemon-lifecycle.js");
const state = require("../../lib/control-service/daemon-state.js");
const {
  createDaemonHealthProducer,
} = require("../../lib/control-service/daemon-health.js");

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m041-daemon-life-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  return dir;
}

test("daemon start/status/stop is explicit, idempotent and local-runtime scoped", async () => {
  const project = root();
  try {
    const before = lifecycle.statusDaemon(project);
    assert.equal(before.live, false);
    assert.equal(fs.existsSync(state.statePath(project)), false);

    const first = lifecycle.startDaemon(project, { poll_interval_ms: 1000 });
    assert.equal(first.ok, true);
    assert.equal(first.started, true);
    assert.equal(first.state.status, "running");
    assert.equal(first.state.enabled, true);

    const second = lifecycle.startDaemon(project, { poll_interval_ms: 1000 });
    assert.equal(second.ok, true);
    assert.equal(second.started, false);
    assert.equal(second.idempotent, true);

    const current = lifecycle.statusDaemon(project);
    assert.equal(current.read_only, true);
    assert.equal(current.live, true);
    assert.equal(current.stale_owner, false);
    assert.equal(
      state.statePath(project).startsWith(path.join(project, ".agent-runtime")),
      true,
    );

    const healthProducer = createDaemonHealthProducer(project, {
      request_source_configured: false,
    });
    const health = await healthProducer.produce({
      now: "2026-09-30T04:00:00.000Z",
    });
    assert.equal(health[0].status, "degraded");

    const stopped = lifecycle.stopDaemon(project);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.state.status, "stopped");
    assert.equal(stopped.state.enabled, false);

    const stoppedAgain = lifecycle.stopDaemon(project);
    assert.equal(stoppedAgain.ok, true);
    assert.equal(stoppedAgain.idempotent, true);
  } finally {
    try { lifecycle.stopDaemon(project); } catch (_) {}
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("daemon status detects stale owner without mutating state", () => {
  const project = root();
  try {
    state.writeOwner(project, {
      schema_version: 1,
      pid: 99999999,
      token: "stale",
      project_root: project,
      started_at: "2026-09-30T03:00:00.000Z",
    });
    state.writeState(project, {
      enabled: true,
      status: "running",
      pid: 99999999,
      started_at: "2026-09-30T03:00:00.000Z",
      last_heartbeat_at: "2026-09-30T03:00:01.000Z",
    });

    const before = fs.readFileSync(state.statePath(project), "utf8");
    const result = lifecycle.statusDaemon(project);
    const after = fs.readFileSync(state.statePath(project), "utf8");

    assert.equal(result.live, false);
    assert.equal(result.stale_owner, true);
    assert.equal(after, before);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("daemon start recovers stale owner/process state before spawning", () => {
  const project = root();
  try {
    state.writeOwner(project, {
      schema_version: 1,
      pid: 99999998,
      token: "stale",
      project_root: project,
      started_at: "2026-09-30T03:00:00.000Z",
    });
    state.writeState(project, {
      enabled: true,
      status: "running",
      pid: 99999998,
      started_at: "2026-09-30T03:00:00.000Z",
      last_heartbeat_at: "2026-09-30T03:00:01.000Z",
    });

    const result = lifecycle.startDaemon(project, { poll_interval_ms: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.state.status, "running");
    assert.notEqual(result.state.pid, 99999998);
    lifecycle.stopDaemon(project);
  } finally {
    try { lifecycle.stopDaemon(project); } catch (_) {}
    fs.rmSync(project, { recursive: true, force: true });
  }
});
