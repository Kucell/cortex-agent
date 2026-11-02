"use strict";

// @runner-timeout 600
// The lifecycle ticket cases drive real supervised children; under the
// parallel runner's load they exceed the default hang-detection window.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { beginManagedCallerSession, startManagedCallerSession } = require("../../lib/governed/managed-caller-supervisor");
const exec = promisify(execFile);
const fixture = name => path.join(__dirname, "fixtures", name);

test("ticket observes direct exit after a real managed session and legacy API remains compatible", { timeout: 15000 }, async () => {
  const options = { modulePath: fixture("m044-ms002-executor.js"), handshakeTimeoutMs: 5000 };
  const lease = beginManagedCallerSession(options);
  assert.ok(Object.isFrozen(lease));
  const { session, child } = await lease.ready;
  child.stdout.resume(); child.stderr.resume();
  try {
    assert.equal(session.established, true);
    await session.close("test");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const exit = await lease.directExit;
    assert.equal(exit.kind, "exited");
    assert.deepEqual(await lease.directExit, exit);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  const legacy = await startManagedCallerSession(options);
  legacy.child.stdout.resume(); legacy.child.stderr.resume();
  const exited = new Promise(resolve => legacy.child.once("exit", resolve));
  await legacy.session.close("test");
  if (legacy.child.exitCode === null && legacy.child.signalCode === null) legacy.child.kill("SIGKILL");
  await exited;
});

test("preflight and asynchronous spawn failure resolve not-started without changing ready errors", async () => {
  const invalid = beginManagedCallerSession({});
  await assert.rejects(invalid.ready, /modulePath is required/);
  assert.equal((await invalid.directExit).kind, "not-started");
  const preparationError = new Error("environment preparation failed before fork");
  const preparation = beginManagedCallerSession({ modulePath: fixture("handshake-no-reply.js"),
    env: { get LIFECYCLE_TEST_VALUE() { throw preparationError; } } });
  await assert.rejects(preparation.ready, error => error === preparationError);
  assert.equal((await preparation.directExit).kind, "not-started");
  assert.equal((await preparation.directExit).error, preparationError);
  const missing = beginManagedCallerSession({ modulePath: fixture("handshake-no-reply.js"),
    spawnOptions: { execPath: path.join(__dirname, "missing-lifecycle-node") } });
  await assert.rejects(missing.ready, { code: "ENOENT" });
  const exit = await missing.directExit;
  assert.equal(exit.kind, "not-started"); assert.equal(exit.error.code, "ENOENT");
});

test("handshake failure retains a ticket for the actual direct child exit", { timeout: 10000 }, async () => {
  const lease = beginManagedCallerSession({ modulePath: fixture("handshake-no-reply.js"), handshakeTimeoutMs: 200 });
  await assert.rejects(lease.ready, /timed out/);
  const exit = await lease.directExit;
  assert.equal(exit.kind, "exited"); assert.equal(exit.signal, "SIGKILL");
});

test("direct exit does not wait for inherited stdout or prove descendant exit", { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-descendant-"));
  try {
    const readyFile = path.join(dir, "pid");
    const lease = beginManagedCallerSession({ modulePath: fixture("managed-caller-lifecycle-descendant.js"),
      args: [readyFile], handshakeTimeoutMs: 3000 });
    let readySettled = false;
    lease.ready.then(() => { readySettled = true; }, () => { readySettled = true; });
    const exit = await lease.directExit;
    const descendantPid = Number(fs.readFileSync(readyFile, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.equal(exit.kind, "exited");
    assert.equal(readySettled, false, "cleanup still waits for inherited stdout to close");
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    await assert.rejects(lease.ready);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failed cleanup remains observable until a later real exit, with no unhandled errors", { timeout: 15000 }, async () => {
  const { stdout } = await exec(process.execPath, ["--unhandled-rejections=strict", fixture("managed-caller-lifecycle-fault.js")], { timeout: 12000 });
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.timedOutBeforeExit, true);
  assert.match(evidence.cleanupError, /termination failed/);
  assert.deepEqual(evidence.result, { kind: "exited", code: null, signal: "SIGKILL" });
});

test("ignored ready rejection is observed under strict unhandled-rejection policy", { timeout: 10000 }, async () => {
  const script = `const {beginManagedCallerSession}=require(process.argv[1]);\n` +
    `const a=beginManagedCallerSession({}); const b=beginManagedCallerSession({modulePath:process.argv[2],handshakeTimeoutMs:100});\n` +
    `Promise.all([a.directExit,b.directExit]).then(x=>{if(x[0].kind!=='not-started'||x[1].kind!=='exited')process.exitCode=1});`;
  await exec(process.execPath, ["--unhandled-rejections=strict", "-e", script,
    path.resolve(__dirname, "../../lib/governed/managed-caller-supervisor.js"), fixture("handshake-no-reply.js")], { timeout: 8000 });
});

test("fork throwing after real OS spawn leaves directExit pending without an observed handle", { timeout: 10000 }, async () => {
  const { stdout } = await exec(process.execPath,
    ["--unhandled-rejections=strict", fixture("managed-caller-lifecycle-probe.js"), "postspawn-signal-throw"], { timeout: 8000 });
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.observedLiveChild, true);
  assert.deepEqual(evidence.exit, { code: null, signal: "SIGKILL" });
  assert.equal(evidence.beforeKill, "pending", "fork has not returned a handle, but the OS child is alive");
  assert.equal(evidence.afterActualExit, "pending", "the supervisor still has no proof of that child's exit");
});

test("legacy ignored rejections still fail under strict, while caught errors retain their identity", { timeout: 15000 }, async () => {
  for (const mode of ["legacy-ignored-preflight", "legacy-ignored-handshake"]) {
    await assert.rejects(exec(process.execPath,
      ["--unhandled-rejections=strict", fixture("managed-caller-lifecycle-probe.js"), mode], { timeout: 8000 }), error => {
      assert.equal(error.code, 1, mode);
      assert.match(error.stderr, mode.endsWith("preflight") ? /modulePath is required/ : /timed out/);
      assert.doesNotMatch(error.stdout, /survived/);
      return true;
    });
  }
  const { stdout } = await exec(process.execPath,
    ["--unhandled-rejections=strict", fixture("managed-caller-lifecycle-probe.js"), "legacy-caught"], { timeout: 8000 });
  assert.equal(stdout, "caught original rejection\n");
});
