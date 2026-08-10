"use strict";

// ─── lib/commands/surface/agent.js unit tests ─────────────────────────────────
//
// Coverage:
//   - dependency-injected service is used by executeBridgeCommand
//   - non-ok result sets process.exitCode to result.exitCode || 3
//   - launch subcommand delegates to executeGovernedLaunch
//
// Mocking strategy: surface/agent.js destructures `executeBridgeCommand` and
// `executeGovernedLaunch` at the top of the module, so simple require.cache
// replacement is too late. We use the cache-delete + re-require trick:
//   1. Set up a fake entry in require.cache for the dependency.
//   2. Delete the consumer (agent.js) from require.cache.
//   3. Re-require the consumer — its top-level require() picks up the mock.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const AGENT_PATH = require.resolve("../../../lib/commands/surface/agent");
const BRIDGE_PATH = require.resolve("../../../lib/coordination/host-event-bridge");
const LAUNCH_PATH = require.resolve("../../../lib/governed/launch-cli");

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

function makeCtx(args) {
  return {
    args,
    options: {},
    cwd: path.resolve(__dirname, "..", "..", ".."),
    lang: "en",
    command: "agent",
  };
}

function loadAgentWithMocks({ bridgeMock, launchMock }) {
  // Save the originals (if any)
  const origBridge = require.cache[BRIDGE_PATH];
  const origLaunch = require.cache[LAUNCH_PATH];
  const origAgent = require.cache[AGENT_PATH];

  // Inject the mocks
  require.cache[BRIDGE_PATH] = {
    id: BRIDGE_PATH,
    filename: BRIDGE_PATH,
    loaded: true,
    exports: { executeBridgeCommand: bridgeMock },
  };
  require.cache[LAUNCH_PATH] = {
    id: LAUNCH_PATH,
    filename: LAUNCH_PATH,
    loaded: true,
    exports: { executeGovernedLaunch: launchMock },
  };

  // Force agent.js to re-require
  delete require.cache[AGENT_PATH];
  const mod = require(AGENT_PATH);

  // Return a teardown function
  return () => {
    delete require.cache[AGENT_PATH];
    if (origBridge) require.cache[BRIDGE_PATH] = origBridge;
    else delete require.cache[BRIDGE_PATH];
    if (origLaunch) require.cache[LAUNCH_PATH] = origLaunch;
    else delete require.cache[LAUNCH_PATH];
    if (origAgent) require.cache[AGENT_PATH] = origAgent;
  };
}

test("agent: dependency-injected service is used by executeBridgeCommand", async () => {
  const fakeService = { kind: "fake-service", close: () => {} };
  const captured = { service: null, args: null };
  const fakeBridge = (args, opts) => {
    captured.args = args;
    captured.service = opts && opts.service;
    return { ok: true, command: "agent" };
  };

  const teardown = loadAgentWithMocks({ bridgeMock: fakeBridge, launchMock: async () => ({ ok: true }) });
  const { agent } = require(AGENT_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out = "";
  try {
    await agent(makeCtx(["agent", "report", "--event-type", "task.progress"]), { service: fakeService });
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
  assert.equal(captured.service, fakeService, "service must be passed to executeBridgeCommand");
  assert.deepEqual(captured.args, ["agent", "report", "--event-type", "task.progress"]);
});

test("agent: non-ok result sets process.exitCode = result.exitCode", async () => {
  const fakeService = {};
  const fakeBridge = () => ({ ok: false, command: "agent", exitCode: 9 });
  const teardown = loadAgentWithMocks({ bridgeMock: fakeBridge, launchMock: async () => ({ ok: true }) });
  const { agent } = require(AGENT_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await agent(makeCtx(["agent", "report", "--event-type", "task.progress"]), { service: fakeService });
    assert.equal(process.exitCode, 9);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
});

test("agent: non-ok result without exitCode falls back to 3", async () => {
  const fakeService = {};
  const fakeBridge = () => ({ ok: false, command: "agent" });
  const teardown = loadAgentWithMocks({ bridgeMock: fakeBridge, launchMock: async () => ({ ok: true }) });
  const { agent } = require(AGENT_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await agent(makeCtx(["agent", "report", "--event-type", "task.progress"]), { service: fakeService });
    assert.equal(process.exitCode, 3);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
});

test("agent: launch subcommand delegates to executeGovernedLaunch (bridge NOT called)", async () => {
  const fakeService = { close: () => {} };
  const captured = { args: null, opts: null };
  const fakeGovernedLaunch = async (args, opts) => {
    captured.args = args;
    captured.opts = opts;
    return { ok: true, command: "agent" };
  };
  let bridgeCallCount = 0;
  const fakeBridge = () => { bridgeCallCount += 1; return { ok: true }; };

  const teardown = loadAgentWithMocks({ bridgeMock: fakeBridge, launchMock: fakeGovernedLaunch });
  const { agent } = require(AGENT_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await agent(makeCtx(["agent", "launch", "task-1", "--gate", "mission"]), { service: fakeService });
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
  assert.equal(bridgeCallCount, 0, "executeBridgeCommand must not be called for launch");
  assert.deepEqual(captured.args, ["task-1", "--gate", "mission"]);
  assert.equal(captured.opts.service, fakeService);
  assert.equal(typeof captured.opts.releaseService, "function");
});
