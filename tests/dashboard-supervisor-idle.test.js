"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  callSupervisor,
  cleanupFixture,
  createFixture,
  readState,
  setWorkloads,
  waitFor,
} = require("./helpers/dashboard-supervisor-fixture.js");

function activeSession(role = "developer") {
  return {
    session_id: `S-${role}`,
    agent_id: role,
    role,
    status: "running",
    last_heartbeat_at: new Date().toISOString(),
  };
}

test("dashboard-manager does not self-sustain and idle deadline stops Dashboard", async () => {
  const fixture = createFixture({ idleShutdownMs: 100 });
  setWorkloads(fixture, { sessions: [activeSession()] });
  try {
    callSupervisor(fixture.root, ["auto", "enable"]);
    await waitFor(() => readState(fixture).status === "running");
    setWorkloads(fixture, { sessions: [activeSession("dashboard-manager")] });
    await waitFor(() => readState(fixture).status === "idle_grace");
    const stopped = await waitFor(() => {
      const state = readState(fixture);
      return state.status === "enabled_idle" && state.dashboard_pid === null ? state : null;
    }, 5000);
    assert.equal(stopped.url, null);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("stop --if-idle refuses active Dashboard and succeeds after idle", async () => {
  const fixture = createFixture({ idleShutdownMs: 5000 });
  setWorkloads(fixture, { sessions: [activeSession()] });
  try {
    callSupervisor(fixture.root, ["auto", "enable"]);
    await waitFor(() => readState(fixture).status === "running");
    const refused = callSupervisor(fixture.root, ["stop", "--if-idle"]);
    assert.equal(refused.status, 1);
    assert.equal(refused.payload.refused, true);
    setWorkloads(fixture, { sessions: [] });
    await waitFor(() => readState(fixture).status === "idle_grace");
    const stopped = callSupervisor(fixture.root, ["stop", "--if-idle"]);
    assert.equal(stopped.status, 0, stopped.stderr);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("shared .agent worktrees reuse the configured owner daemon", async () => {
  const fixture = createFixture();
  const sibling = fs.mkdtempSync(path.join(path.dirname(fixture.root), "dashboard-shared-"));
  fs.symlinkSync(fixture.agentRoot, path.join(sibling, ".agent"), "dir");
  try {
    const enabled = callSupervisor(fixture.root, ["auto", "enable"]);
    assert.equal(enabled.status, 0, enabled.stderr);
    const sharedEnsure = callSupervisor(sibling, ["ensure"]);
    assert.equal(sharedEnsure.status, 0, sharedEnsure.stderr);
    assert.equal(sharedEnsure.payload.supervisor_pid, enabled.payload.state.supervisor_pid);
    assert.equal(sharedEnsure.payload.dashboard_root, fs.realpathSync(fixture.root));
  } finally {
    await cleanupFixture(fixture);
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("non-trigger active Queue keeps an already running Dashboard alive", async () => {
  const fixture = createFixture({ idleShutdownMs: 100 });
  setWorkloads(fixture, { sessions: [activeSession()] });
  try {
    callSupervisor(fixture.root, ["auto", "enable"]);
    await waitFor(() => readState(fixture).status === "running");
    setWorkloads(fixture, {
      queues: [{ queue_id: "Q-1", items: [{ state: "running" }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(readState(fixture).status, "running");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("daemon recovery safely replaces an owned orphan Dashboard", async () => {
  const fixture = createFixture();
  setWorkloads(fixture, { sessions: [activeSession()] });
  try {
    callSupervisor(fixture.root, ["auto", "enable"]);
    const first = await waitFor(() => {
      const state = readState(fixture);
      return state.status === "running" ? state : null;
    });
    process.kill(first.supervisor_pid, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(first.supervisor_pid, 0);
        return false;
      } catch (_) {
        return true;
      }
    });
    const ensured = callSupervisor(fixture.root, ["ensure"]);
    assert.equal(ensured.status, 0, ensured.stderr);
    assert.notEqual(ensured.payload.supervisor_pid, first.supervisor_pid);
    const recovered = await waitFor(() => {
      const state = readState(fixture);
      return state.status === "running"
        && state.supervisor_pid !== first.supervisor_pid
        && state.dashboard_pid !== first.dashboard_pid
        ? state
        : null;
    }, 8000);
    assert.ok(recovered.url);
    assert.throws(() => process.kill(first.dashboard_pid, 0));
  } finally {
    await cleanupFixture(fixture);
  }
});

test("forged foreign supervisor PID is never signaled", async () => {
  const owner = createFixture();
  const foreign = createFixture();
  try {
    const foreignEnabled = callSupervisor(foreign.root, ["auto", "enable"]);
    assert.equal(foreignEnabled.status, 0, foreignEnabled.stderr);
    const foreignPid = foreignEnabled.payload.state.supervisor_pid;
    const configPath = path.join(owner.agentRoot, "config", "dashboard-automation.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, `${JSON.stringify({
      ...config,
      enabled: true,
      dashboard_root: fs.realpathSync(owner.root),
    }, null, 2)}\n`);
    const runtime = path.join(owner.agentRoot, "runtime-evidence", "dashboard-supervisor");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "state.json"), `${JSON.stringify({
      schema_version: 1,
      status: "enabled_idle",
      agent_root: fs.realpathSync(owner.agentRoot),
      dashboard_root: fs.realpathSync(owner.root),
      supervisor_pid: foreignPid,
      dashboard_pid: null,
      url: null,
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      last_active_at: null,
      idle_deadline_at: null,
      last_reason: "forged",
      last_error: null,
    }, null, 2)}\n`);
    const stopped = callSupervisor(owner.root, ["stop"]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.doesNotThrow(() => process.kill(foreignPid, 0));
  } finally {
    await cleanupFixture(owner);
    await cleanupFixture(foreign);
  }
});

test("stale Dashboard owner cannot kill a same-root process without the token", async () => {
  const fixture = createFixture();
  const configPath = path.join(fixture.agentRoot, "config", "dashboard-automation.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({
    ...config,
    enabled: true,
    dashboard_root: fs.realpathSync(fixture.root),
  }, null, 2)}\n`);
  const dashboardScript = path.join(fixture.agentRoot, "skills", "agent-dashboard", "scripts", "serve.js");
  const manual = spawn(process.execPath, [dashboardScript, "--port", String(config.requested_port)], {
    cwd: fixture.root,
    stdio: "ignore",
  });
  try {
    await waitFor(() => {
      try {
        process.kill(manual.pid, 0);
        return true;
      } catch (_) {
        return false;
      }
    });
    const runtime = path.join(fixture.agentRoot, "runtime-evidence", "dashboard-supervisor");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "dashboard-owner.json"), `${JSON.stringify({
      schema_version: 1,
      pid: manual.pid,
      supervisor_pid: 999999,
      supervisor_token: "forged-token-1234567890",
      agent_root: fs.realpathSync(fixture.agentRoot),
      dashboard_root: fs.realpathSync(fixture.root),
      started_at: new Date().toISOString(),
    }, null, 2)}\n`);
    const ensured = callSupervisor(fixture.root, ["ensure"]);
    assert.equal(ensured.status, 0, ensured.stderr);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotThrow(() => process.kill(manual.pid, 0));
  } finally {
    try {
      process.kill(manual.pid, "SIGTERM");
    } catch (_) {
      // Already stopped.
    }
    await cleanupFixture(fixture);
  }
});

test("ownership-lost daemon cannot overwrite successor state", async () => {
  const fixture = createFixture();
  try {
    const enabled = callSupervisor(fixture.root, ["auto", "enable"]);
    assert.equal(enabled.status, 0, enabled.stderr);
    const oldPid = enabled.payload.state.supervisor_pid;
    const runtime = path.join(fixture.agentRoot, "runtime-evidence", "dashboard-supervisor");
    const successorToken = "successor-token-1234567890";
    fs.writeFileSync(path.join(runtime, "owner.json"), `${JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      token: successorToken,
      agent_root: fs.realpathSync(fixture.agentRoot),
      dashboard_root: fs.realpathSync(fixture.root),
      started_at: new Date().toISOString(),
    }, null, 2)}\n`);
    const successorState = {
      ...readState(fixture),
      status: "enabled_idle",
      supervisor_pid: process.pid,
      dashboard_pid: null,
      url: null,
      last_heartbeat_at: new Date().toISOString(),
      last_reason: "successor_started",
    };
    fs.writeFileSync(path.join(runtime, "state.json"), `${JSON.stringify(successorState, null, 2)}\n`);
    process.kill(oldPid, "SIGUSR1");
    await waitFor(() => {
      try {
        process.kill(oldPid, 0);
        return false;
      } catch (_) {
        return true;
      }
    });
    const after = readState(fixture);
    assert.equal(after.supervisor_pid, process.pid);
    assert.equal(after.last_reason, "successor_started");
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, "owner.json"), "utf8")).token, successorToken);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("ownership-lost daemon stops its local Dashboard after successor overwrites shared owners", async () => {
  const fixture = createFixture();
  setWorkloads(fixture, { sessions: [activeSession()] });
  try {
    callSupervisor(fixture.root, ["auto", "enable"]);
    const old = await waitFor(() => {
      const state = readState(fixture);
      return state.status === "running" ? state : null;
    });
    const runtime = path.join(fixture.agentRoot, "runtime-evidence", "dashboard-supervisor");
    const successorToken = "successor-dashboard-token-1234567890";
    const successorOwner = {
      schema_version: 1,
      pid: process.pid,
      token: successorToken,
      agent_root: fs.realpathSync(fixture.agentRoot),
      dashboard_root: fs.realpathSync(fixture.root),
      started_at: new Date().toISOString(),
    };
    const successorDashboardOwner = {
      schema_version: 1,
      pid: process.pid,
      supervisor_pid: process.pid,
      supervisor_token: successorToken,
      agent_root: fs.realpathSync(fixture.agentRoot),
      dashboard_root: fs.realpathSync(fixture.root),
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(runtime, "owner.json"), `${JSON.stringify(successorOwner, null, 2)}\n`);
    fs.writeFileSync(path.join(runtime, "dashboard-owner.json"), `${JSON.stringify(successorDashboardOwner, null, 2)}\n`);
    fs.writeFileSync(path.join(runtime, "state.json"), `${JSON.stringify({
      ...old,
      status: "enabled_idle",
      supervisor_pid: process.pid,
      dashboard_pid: null,
      url: null,
      last_reason: "successor_started",
    }, null, 2)}\n`);
    process.kill(old.supervisor_pid, "SIGUSR1");
    await waitFor(() => {
      try {
        process.kill(old.dashboard_pid, 0);
        return false;
      } catch (_) {
        return true;
      }
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, "owner.json"), "utf8")).token, successorToken);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, "dashboard-owner.json"), "utf8")).supervisor_token, successorToken);
    assert.equal(readState(fixture).last_reason, "successor_started");
  } finally {
    await cleanupFixture(fixture);
  }
});
