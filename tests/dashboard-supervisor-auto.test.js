"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  callSupervisor,
  cleanupFixture,
  createFixture,
  readState,
  waitFor,
} = require("./helpers/dashboard-supervisor-fixture.js");

test("auto status is read-only and reports disabled", () => {
  const fixture = createFixture();
  try {
    const result = callSupervisor(fixture.root, ["auto", "status"]);
    assert.equal(result.status, 0);
    assert.equal(result.payload.enabled, false);
    assert.equal(fs.existsSync(path.join(fixture.agentRoot, "runtime-evidence", "dashboard-supervisor", "state.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("auto enable fixes the owner root and starts one daemon", async () => {
  const fixture = createFixture();
  try {
    const first = callSupervisor(fixture.root, ["auto", "enable"]);
    const second = callSupervisor(fixture.root, ["auto", "enable"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.payload.state.supervisor_pid, first.payload.state.supervisor_pid);
    const config = JSON.parse(fs.readFileSync(path.join(fixture.agentRoot, "config", "dashboard-automation.json"), "utf8"));
    assert.equal(config.enabled, true);
    assert.equal(config.dashboard_root, fs.realpathSync(fixture.root));
    await waitFor(() => readState(fixture).supervisor_pid === first.payload.state.supervisor_pid);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("auto disable stops the daemon and returns to disabled", async () => {
  const fixture = createFixture();
  try {
    const enabled = callSupervisor(fixture.root, ["auto", "enable"]);
    assert.equal(enabled.status, 0, enabled.stderr);
    const disabled = callSupervisor(fixture.root, ["auto", "disable"]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.payload.enabled, false);
    await waitFor(() => {
      const state = readState(fixture);
      return state.status === "disabled" && state.supervisor_pid === null;
    });
  } finally {
    await cleanupFixture(fixture);
  }
});
