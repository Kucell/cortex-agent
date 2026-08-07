"use strict";

// ─── lib/commands/surface/notification.js unit tests ──────────────────────────
//
// Coverage:
//   - dependency-injected harness is used
//   - ok result leaves process.exitCode unchanged
//   - non-ok result with exitCode → process.exitCode = exitCode
//   - non-ok result without exitCode → process.exitCode defaults to 3
//
// Mocking: notification.js destructures `executeNotificationCommand` at the
// top, so we use the cache-delete + re-require trick.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const NOTIF_PATH = require.resolve("../../../lib/commands/surface/notification");
const NOTIF_CLI_PATH = require.resolve("../../../lib/coordination/notification-cli");
const NOTIF_HOST_PATH = require.resolve("../../../lib/coordination/notification-host");

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

function makeCtx(extra = {}) {
  return {
    args: ["notification", "list"],
    options: {},
    cwd: path.resolve(__dirname, "..", "..", ".."),
    lang: "en",
    command: "notification",
    ...extra,
  };
}

function loadNotificationWithMock(executeMock) {
  const origCli = require.cache[NOTIF_CLI_PATH];
  const origHost = require.cache[NOTIF_HOST_PATH];
  const origNotif = require.cache[NOTIF_PATH];

  require.cache[NOTIF_CLI_PATH] = {
    id: NOTIF_CLI_PATH,
    filename: NOTIF_CLI_PATH,
    loaded: true,
    exports: { executeNotificationCommand: executeMock },
  };
  // host is required at the top; provide a no-op createNotificationHarness
  require.cache[NOTIF_HOST_PATH] = {
    id: NOTIF_HOST_PATH,
    filename: NOTIF_HOST_PATH,
    loaded: true,
    exports: { createNotificationHarness: () => ({ kind: "stub-harness" }) },
  };

  delete require.cache[NOTIF_PATH];
  const mod = require(NOTIF_PATH);

  return () => {
    delete require.cache[NOTIF_PATH];
    if (origCli) require.cache[NOTIF_CLI_PATH] = origCli;
    else delete require.cache[NOTIF_CLI_PATH];
    if (origHost) require.cache[NOTIF_HOST_PATH] = origHost;
    else delete require.cache[NOTIF_HOST_PATH];
    if (origNotif) require.cache[NOTIF_PATH] = origNotif;
  };
}

test("notification: passes ctx.args and the dependency-injected harness to executeNotificationCommand", async () => {
  const fakeHarness = { kind: "fake-harness" };
  const captured = { args: null, harness: null };
  const fakeExecute = async (args, harness) => {
    captured.args = args;
    captured.harness = harness;
    return { ok: true, command: "notification" };
  };

  const teardown = loadNotificationWithMock(fakeExecute);
  const { notification } = require(NOTIF_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await notification(makeCtx(), { harness: fakeHarness });
    assert.equal(process.exitCode, origExit, "exitCode must be unchanged for ok result");
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
  assert.deepEqual(captured.args, ["notification", "list"]);
  assert.equal(captured.harness, fakeHarness, "dependency-injected harness must be used");
});

test("notification: non-ok result sets process.exitCode to result.exitCode", async () => {
  const fakeExecute = async () => ({ ok: false, command: "notification", exitCode: 7 });
  const teardown = loadNotificationWithMock(fakeExecute);
  const { notification } = require(NOTIF_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await notification(makeCtx());
    assert.equal(process.exitCode, 7, "exitCode must equal result.exitCode on failure");
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
});

test("notification: non-ok result without exitCode falls back to 3", async () => {
  const fakeExecute = async () => ({ ok: false, command: "notification" });
  const teardown = loadNotificationWithMock(fakeExecute);
  const { notification } = require(NOTIF_PATH);

  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await notification(makeCtx());
    assert.equal(process.exitCode, 3, "exitCode must default to 3 on failure without exitCode");
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
    teardown();
  }
});
