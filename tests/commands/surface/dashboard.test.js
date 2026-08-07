"use strict";

// ─── lib/commands/surface/dashboard.js unit tests ─────────────────────────────
//
// Coverage:
//   - resolveManagementProject returns !ok → managementApiError, exitCode = 3
//   - happy path: spawnSync called with lib/dashboard-supervisor.js
//   - result.error → managementApiError, exitCode = 3
//
// Mocking strategy:
//   - `resolveManagementProject` is destructured at the top of dashboard.js from
//     lib/management-client. We use the cache-delete + re-require trick to
//     inject the mock.
//   - `spawnSync` is a built-in (`node:child_process`), so require.cache cannot
//     replace it. We patch `Module._load` to intercept the require of
//     `node:child_process` and return our fake module.

const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

const DASH_PATH = require.resolve("../../../lib/commands/surface/dashboard");
const MC_PATH = require.resolve("../../../lib/management-client");

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
    cwd: process.cwd(),
    lang: "en",
    command: "dashboard",
  };
}

function loadDashboardWithMocks({ resolveProjectMock, spawnSyncMock }) {
  const origMc = require.cache[MC_PATH];
  const origDash = require.cache[DASH_PATH];

  // 1. Inject the management-client mock.
  require.cache[MC_PATH] = {
    id: MC_PATH,
    filename: MC_PATH,
    loaded: true,
    exports: { resolveManagementProject: resolveProjectMock },
  };

  // 2. Patch Module._load to intercept node:child_process if a spawnSyncMock
  //    is provided. We restore it in the teardown.
  let origLoad = null;
  if (spawnSyncMock) {
    origLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "node:child_process" || request === "child_process") {
        return { spawnSync: spawnSyncMock };
      }
      return origLoad.call(this, request, parent, isMain);
    };
  }

  // 3. Force dashboard.js to re-require.
  delete require.cache[DASH_PATH];
  const mod = require(DASH_PATH);

  return () => {
    delete require.cache[DASH_PATH];
    if (origLoad) Module._load = origLoad;
    if (origMc) require.cache[MC_PATH] = origMc;
    else delete require.cache[MC_PATH];
    if (origDash) require.cache[DASH_PATH] = origDash;
  };
}

test("dashboard: resolveManagementProject returns !ok → exitCode = 3", () => {
  const teardown = loadDashboardWithMocks({
    resolveProjectMock: () => ({ ok: false, error: { code: "X", message: "x" }, exitCode: 3 }),
  });
  const { dashboard } = require(DASH_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dashboard(makeCtx(["dashboard"]));
    assert.equal(process.exitCode, 3);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
});

test("dashboard: happy path → spawnSync called with lib/dashboard-supervisor.js, exitCode from result.status", () => {
  const fakeProject = {
    ok: true,
    project: { root: "/tmp/dashboard-test-root", agent_root: "/tmp/dashboard-test-root/.agent" },
  };
  const spawnCalls = [];
  const teardown = loadDashboardWithMocks({
    resolveProjectMock: () => fakeProject,
    spawnSyncMock: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { status: 0 };
    },
  });
  const { dashboard } = require(DASH_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dashboard(makeCtx(["dashboard"]));
    assert.equal(spawnCalls.length, 1, "spawnSync must be called once");
    const call = spawnCalls[0];
    const expectedScript = path.resolve(__dirname, "..", "..", "..", "lib", "dashboard-supervisor.js");
    assert.equal(call.args[0], expectedScript);
    assert.equal(call.opts.cwd, fakeProject.project.root);
    assert.equal(process.exitCode, 0, "result.status = 0 → exitCode 0");
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
});

test("dashboard: result.error → managementApiError → exitCode = 3", () => {
  const teardown = loadDashboardWithMocks({
    resolveProjectMock: () => ({
      ok: true,
      project: { root: "/tmp/r", agent_root: "/tmp/r/.agent" },
    }),
    spawnSyncMock: () => ({ error: new Error("spawn failure"), status: null }),
  });
  const { dashboard } = require(DASH_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dashboard(makeCtx(["dashboard"]));
    assert.equal(process.exitCode, 3);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
});
