"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  SUPERVISOR,
  callSupervisor,
  cleanupFixture,
  createFixture,
  probe,
  readState,
  setWorkloads,
  waitFor,
} = require("./helpers/dashboard-supervisor-fixture.js");

test("supervisor entry exists and status is read-only", () => {
  assert.ok(fs.existsSync(SUPERVISOR));
  const fixture = createFixture();
  try {
    const result = callSupervisor(fixture.root, ["status"]);
    assert.equal(result.status, 0);
    assert.equal(result.payload.status, "disabled");
    assert.equal(result.payload.supervisor_alive, false);
    assert.equal(fs.existsSync(`${fixture.agentRoot}/runtime-evidence/dashboard-supervisor/state.json`), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("disabled ensure is a zero-write no-op with exit 0", () => {
  const fixture = createFixture();
  try {
    const result = callSupervisor(fixture.root, ["ensure"]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.payload, {
      ok: true,
      enabled: false,
      action: "none",
      reason: "supervisor_disabled",
    });
    assert.equal(fs.existsSync(`${fixture.agentRoot}/runtime-evidence/dashboard-supervisor/state.json`), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("active workload starts one real Dashboard and repeated ensure reuses it", async () => {
  const fixture = createFixture();
  setWorkloads(fixture, {
    sessions: [{
      session_id: "S-worker",
      agent_id: "worker",
      role: "developer",
      status: "running",
      last_heartbeat_at: new Date().toISOString(),
    }],
  });
  try {
    const enabled = callSupervisor(fixture.root, ["auto", "enable"]);
    assert.equal(enabled.status, 0, enabled.stderr);
    const firstPid = enabled.payload.state.supervisor_pid;
    assert.ok(firstPid > 0);
    const ensured = callSupervisor(fixture.root, ["ensure"]);
    assert.equal(ensured.status, 0, ensured.stderr);
    assert.equal(ensured.payload.supervisor_pid, firstPid);
    const running = await waitFor(() => {
      const state = readState(fixture);
      return state.status === "running" && state.url ? state : null;
    });
    assert.ok(running.dashboard_pid > 0);
    assert.equal(await probe(running.url), true);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("help exposes standard CLI, default disabled, and no MCP writer", () => {
  const fixture = createFixture();
  try {
    const result = callSupervisor(fixture.root, ["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.payload.usage, /cortex-agent dashboard/);
    assert.equal(result.payload.default_enabled, false);
    assert.equal(result.payload.mcp_writer, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
