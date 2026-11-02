"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { startManagedCallerSession } = require("../../lib/governed/managed-caller-supervisor");
const { environment, SENTINELS } = require("./fixtures/permit-witness-isolation-env");

// Development process-boundary evidence only. Real supervisor/session + OS
// audits, no replacement fact source or credentials. Not an OS sandbox, tree
// reaper, transport proof or production-safety validation.
const base = testRuntime("test-tmp");
fs.mkdirSync(base, { recursive: true });
const scratch = fs.mkdtempSync(path.join(base, "worker-isolation-"));
const originalTemp = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]]));
let preserveEvidence = false;
for (const key of Object.keys(originalTemp)) process.env[key] = scratch;
after(() => {
  for (const [key, value] of Object.entries(originalTemp)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (!preserveEvidence) fs.rmSync(scratch, { recursive: true, force: true });
});
const supported = { skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24, timeout: 30000 };
function bounded(promise, label, ms = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timeout")), ms); })])
    .finally(() => clearTimeout(timer));
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(label + " timeout");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }

// Only the original ChildProcess handle is signalled, never a PID read from a
// file or a descendant. Session closure is not evidence of direct worker exit.
async function closeWorker(runtime, evidence, { graceMs = 250, killMs = 3000 } = {}) {
  const { session, child } = runtime;
  const exitedAlready = child.exitCode !== null || child.signalCode !== null;
  let onExit;
  const exited = exitedAlready ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise(resolve => { onExit = (code, signal) => resolve({ code, signal }); child.once("exit", onExit); });
  let closeError;
  try {
    try { await bounded(session.close("isolation-test-cleanup"), "session close", graceMs); }
    catch (error) { closeError = error; evidence.sessionCloseError = error.message; }
    let exit;
    try { exit = await bounded(exited, "cooperative direct worker exit", graceMs); }
    catch {
      evidence.directWorkerForcedTerminationAttempted = true;
      // Recheck exit fields immediately before using the retained handle.
      if (child.exitCode === null && child.signalCode === null) {
        evidence.directWorkerKillAccepted = child.kill("SIGKILL");
      }
      // kill() success alone is not exit evidence; always await the exit event.
      exit = await bounded(exited, "forced direct worker exit", killMs);
    }
    evidence.directWorkerExitObserved = true;
    evidence.directWorkerExit = exit;
    if (closeError) throw closeError;
    return exit;
  } catch (error) {
    evidence.directWorkerCleanupError = error.message;
    throw error;
  } finally { if (onExit) child.off("exit", onExit); }
}

for (const mode of ["species-promise", "unreturned-rejection"]) {
  test(`real managed worker ${mode} failure leaves coordinator alive and session permanently closed`, supported, async t => {
    const root = fs.mkdtempSync(path.join(scratch, mode + "-"));
    const readyFile = path.join(root, "descendant.pid"), stopFile = path.join(root, "descendant.stop");
    const marker = path.join(root, "forbidden-effects.log");
    const preloadFile = path.join(root, "harmless-preload.cjs"), token = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(preloadFile, "require('node:fs').writeFileSync(require('node:path').join(process.env.ISOLATION_PRELOAD_DIR,'preload-'+process.pid),'synthetic preload');\n");
    let passed = false, cleanupRecorded = false, cleanupFailed = false, runtime;
    const evidence = { mode, processTreeExitProven: false, osSandboxClaim: false, productionSafetyClaim: false };
    let probes = 0, writes = 0, recoveries = 0, closeEvents = 0, frames, stderr = "", descendantPid;
    t.after(async () => {
      try {
        if (runtime) {
          await closeWorker(runtime, evidence);
        }
      } catch (error) {
        cleanupFailed = true; evidence.workerCleanupError = error.message;
        throw error;
      } finally {
        try {
          fs.writeFileSync(stopFile, token);
          // Acknowledgement proves cooperation, not descendant or tree exit.
          if (fs.existsSync(readyFile)) {
            await until(() => fs.existsSync(stopFile + ".ack"), "cooperative descendant stop acknowledgement");
            assert.deepEqual(JSON.parse(fs.readFileSync(stopFile + ".ack", "utf8")), { token, cooperativeStopObserved: true });
            evidence.descendantCooperativeStopAcknowledged = true;
          }
          cleanupRecorded = true;
        } finally {
          if (runtime) for (const stream of runtime.child.stdio) if (stream) stream.destroy();
          if (!passed || !cleanupRecorded || cleanupFailed) {
            preserveEvidence = true;
            fs.writeFileSync(path.join(root, "failure-evidence.json"), JSON.stringify({ ...evidence, passed, cleanupRecorded, stderr }, null, 2));
            t.diagnostic("Failure evidence retained: " + root);
          } else {
            t.diagnostic(JSON.stringify({ mode, descendantCooperativeStopAcknowledged: true,
              descendantExitProven: false, processTreeExitProven: false }));
          }
        }
      }
    });
    const savedSentinels = Object.fromEntries(["NODE_OPTIONS", ...SENTINELS].map(key => [key, process.env[key]]));
    let starting;
    try {
      process.env.NODE_OPTIONS = "--require=" + JSON.stringify(preloadFile);
      process.env.ISOLATION_FAKE_API_KEY = "synthetic-not-a-real-key";
      process.env.ISOLATION_PRELOAD_DIR = root;
      starting = startManagedCallerSession({
        modulePath: path.join(__dirname, "fixtures/permit-witness-isolation-worker.js"),
        args: [mode, readyFile, stopFile, token, preloadFile], handshakeTimeoutMs: 5000, requestTimeoutMs: 5000,
        // options.env merges into ambient env; spawnOptions.env is the existing
        // full replacement. Do not alter the supervisor's production defaults.
        spawnOptions: { execArgv: ["--unhandled-rejections=strict"], env: environment(scratch) },
        allowedOperations: ["isolation.probe", "isolation.write", "isolation.recover"],
        onAuthorizedRequest: ({ operation }) => {
          if (operation === "isolation.probe") { probes++; return { accepted: true }; }
          if (operation === "isolation.write") writes++; else recoveries++;
          fs.appendFileSync(marker, operation + "\n");
          return { synthetic: true };
        },
      });
    } finally {
      for (const [key, value] of Object.entries(savedSentinels)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    runtime = await starting;
    const { session, child } = runtime;
    child.stdout.resume(); child.stderr.on("data", data => { stderr += data.toString(); });
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.on("message", message => { if (message.type === "isolation-envelopes") frames = message.frames; });
    session.onClose(() => { closeEvents++; });
    assert.equal(session.established, true);
    assert.equal(session.auditChannelHolders().ok, true);
    assert.equal(session.auditProcessContinuity().ok, true);
    const arm = await bounded(session.request("isolation.arm", { synthetic: true }), "arm worker");
    assert.equal(arm.loaded, true); assert.equal(arm.mode, mode);
    assert.deepEqual(arm.environment, { onlyAllowedEnvironment: true, unexpectedEnvironmentKeys: [], nodeOptionsAbsent: true, syntheticKeyAbsent: true, preloadDirectoryAbsent: true });
    assert.equal(arm.liveReplayError, "request_sequence_invalid");
    evidence.liveChannelAcceptedRequestReplayRejected = true;
    assert.equal(probes, 1, "real authenticated inbound path must work before worker failure");
    assert.ok(frames && frames.length === 2);
    const descendant = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    descendantPid = descendant.pid; assert.ok(Number.isSafeInteger(descendantPid)); assert.equal(descendant.token, token);
    assert.deepEqual(descendant.environment, arm.environment);
    assert.equal(fs.readdirSync(root).some(name => name.startsWith("preload-")), false, "NODE_OPTIONS sentinel must not execute in either process");
    evidence.workerAndDescendantEnvironmentWhitelisted = true;
    child.send({ type: "isolation-trigger" }, () => {});
    const exit = await bounded(exited, "strict rejection worker exit");
    assert.equal(exit.code, 1); assert.equal(exit.signal, null);
    assert.match(stderr, mode === "species-promise" ? /synthetic species rejection/ : /synthetic unreturned rejection/);
    if (mode === "species-promise") assert.match(stderr, /synthetic species getter invoked/);
    // This code and timer run in the still-live coordinating test process.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alive(process.pid), true); assert.equal(session.closed, true); assert.equal(session.established, false);
    const closedReason = session.closedReason; assert.match(closedReason, /child_exit:1|channel_error/);
    assert.equal(closeEvents, 1);
    await assert.rejects(session.handshake(), /session is closed/);
    await assert.rejects(session.request("isolation.arm", {}), /not established/);
    // CLOSED-SESSION LOCAL EVENT INJECTION, not live-channel replay evidence.
    // These genuine test-session frames were never accepted on the live channel.
    const executions = session.inboundExecutions.length;
    for (const frame of frames) child.emit("message", frame);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.inboundExecutions.length, executions);
    assert.equal(probes, 1);
    assert.equal(writes, 0); assert.equal(recoveries, 0); assert.equal(fs.existsSync(marker), false);
    assert.equal(session.closedReason, closedReason); assert.equal(session.closed, true); assert.equal(closeEvents, 1);
    // The descendant is deliberately alive AFTER its direct parent exits. No
    // claim that exit or supervisor.close proves a process tree has been reaped.
    assert.equal(alive(descendantPid), true); // PID presence only, no stable process identity proof.
    Object.assign(evidence, { coordinatorAlive: true, workerExit: exit.code, sessionClosed: true,
      closedSessionInjectedWrites: writes, closedSessionInjectedRecoveries: recoveries,
      descendantPidPresentAfterWorkerExit: true, descendantExitProven: false });
    t.diagnostic(JSON.stringify(evidence));
    passed = true;
  });
}

for (const mode of ["cooperative-bye", "ignore-bye"]) {
  test(`direct managed worker ${mode} cleanup waits for exit and uses the retained child handle when necessary`, supported, async t => {
    const root = fs.mkdtempSync(path.join(scratch, mode + "-"));
    const evidence = { mode, directWorkerExitObserved: false, processTreeExitProven: false,
      descendantExitProven: false, osSandboxClaim: false, productionSafetyClaim: false };
    let runtime, passed = false, cleanupFailed = false, stderr = "", ignored = 0;
    t.after(async () => {
      try { if (runtime) await closeWorker(runtime, evidence); }
      catch (error) { cleanupFailed = true; throw error; }
      finally {
        if (runtime) for (const stream of runtime.child.stdio) if (stream) stream.destroy();
        if (!passed || cleanupFailed) {
          preserveEvidence = true;
          fs.writeFileSync(path.join(root, "failure-evidence.json"), JSON.stringify({ ...evidence, passed, stderr }, null, 2));
          t.diagnostic("Failure evidence retained: " + root);
        }
      }
    });
    runtime = await startManagedCallerSession({
      modulePath: path.join(__dirname, "fixtures/permit-witness-isolation-worker.js"), args: [mode],
      handshakeTimeoutMs: 5000, requestTimeoutMs: 5000,
      spawnOptions: { execArgv: ["--unhandled-rejections=strict"], env: environment(scratch) },
      allowedOperations: ["isolation.probe"], onAuthorizedRequest: () => assert.fail("cleanup must not dispatch work"),
    });
    const { session, child } = runtime;
    child.stdout.resume(); child.stderr.on("data", data => { stderr += data.toString(); });
    child.on("message", message => { if (message.type === "isolation-bye-ignored") ignored++; });
    assert.equal(session.auditChannelHolders().ok, true);
    assert.equal(session.auditProcessContinuity().ok, true);
    const ready = await bounded(session.request("isolation.ready", {}), "ready");
    assert.equal(ready.mode, mode); assert.equal(ready.loaded, true);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    const exit = await closeWorker(runtime, evidence, { graceMs: 250, killMs: 3000 });
    assert.equal(session.closed, true); assert.equal(evidence.directWorkerExitObserved, true);
    if (mode === "ignore-bye") {
      assert.equal(ignored, 1, "worker must actually receive and ignore BYE");
      assert.equal(evidence.directWorkerForcedTerminationAttempted, true);
      assert.equal(evidence.directWorkerKillAccepted, true);
      assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
    } else {
      assert.equal(evidence.directWorkerForcedTerminationAttempted, undefined);
      assert.deepEqual(exit, { code: 0, signal: null });
    }
    await assert.rejects(session.request("isolation.ready", {}), /not established/);
    const repeat = await closeWorker(runtime, evidence);
    assert.deepEqual(repeat, exit);
    assert.equal(evidence.processTreeExitProven, false);
    t.diagnostic(JSON.stringify(evidence));
    passed = true;
  });
}
