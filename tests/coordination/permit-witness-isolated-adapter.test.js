"use strict";

// @runner-timeout 600
// The isolated adapter drives a real host process over the wire, so its
// normal runtime is well beyond the default hang-detection window.

const { testRuntime } = require("../helpers/runtime-sandbox");

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// Observe REAL fork calls; the wrapper always delegates to the original. No
// replacement session, child, factSource or identity audit is used anywhere.
const childProcess = require("node:child_process");
const realFork = childProcess.fork, launches = [];
childProcess.fork = function(modulePath, args, options) {
  launches.push({ modulePath, args: [...args], envKeys: Object.keys(options.env).sort(), execArgv: [...options.execArgv] });
  return Reflect.apply(realFork, this, [modulePath, args, options]);
};
const { IsolationBudget, IsolatedHistoryAdapter, LIMITS } = require("../../lib/coordination/permit-witness-isolated-adapter");
childProcess.fork = realFork;
const fixture = require("./fixtures/permit-witness-v2-history");
const { environment } = require("../../lib/coordination/permit-witness-isolated-contract");
const base = testRuntime("test-tmp");
fs.mkdirSync(base, { recursive: true });
const scratch = fs.mkdtempSync(path.join(base, "isolated-adapter-"));
const saved = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]]));
for (const key of Object.keys(saved)) process.env[key] = scratch;
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}); // Evidence is intentionally retained under .agent, including failures.
const supported = { skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24, timeout: 20000 };
const providerPath = path.join(__dirname, "fixtures/permit-witness-isolated-provider.js");
function setup(mode = "normal", timeoutMs = 5000, budget = new IsolationBudget()) {
  const root = fs.mkdtempSync(path.join(scratch, mode + "-"));
  const adapter = new IsolatedHistoryAdapter({ providerPath, runtimeDirectory: root, budget, timeoutMs });
  const q = fixture.query(); q.issuerStoreId = mode;
  const bytes = fixture.request(q), context = adapter.authorizeHistory(bytes);
  return { root, adapter, budget, bytes, context };
}
async function run(s) {
  const outcome = await s.adapter.observeHistory(s.context, s.bytes);
  fs.writeFileSync(path.join(s.root, "outcome.json"), JSON.stringify(outcome, null, 2));
  assert.equal(outcome.mode, "development-only"); assert.equal(outcome.commit, "not-applicable");
  assert.equal(outcome.executionAuthorized, false); assert.equal(outcome.resumeAllowed, false);
  assert.equal(outcome.originalRequestOutcome, "unknown"); assert.equal(outcome.provenance, "untrusted-provider");
  assert.equal(outcome.evidence.treeExitProven, false); assert.equal(outcome.evidence.chargesRetained, true);
  assert.equal(outcome.evidence.parentOperationsExecuted, 0);
  assert.equal(outcome.budget.workers, 1); assert.equal(outcome.budget.dispatches, 1);
  assert.equal(outcome.budget.reservedBytes, LIMITS.reservationBytes);
  const lifecycle = s.adapter.historyLifecycle(s.context);
  assert.ok(Object.isFrozen(lifecycle));
  const cleaned = await lifecycle.directExit;
  assert.equal(cleaned.directExitObserved, true); assert.equal(cleaned.sessionClosed, true);
  assert.equal(cleaned.cleanupFailed, false); assert.equal(cleaned.directExitState, "confirmed");
  fs.writeFileSync(path.join(s.root, "cleanup.json"), JSON.stringify(cleaned, null, 2));
  // Still executing in the actual coordinator process after hostile execution.
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  // Most legacy assertions concern eventual cleanup, separate from the
  // immutable business result. Dedicated barriers below verify early return.
  return { ...outcome, evidence: cleaned };
}
function loaded(s) { return JSON.parse(fs.readFileSync(path.join(s.root, "provider-loaded.jsonl"), "utf8").trim()); }
test("preflight rejects foreign/revoked contexts, non-history/tail/oversize and launch escape hatches without charging or loading", async () => {
  const s = setup();
  await assert.rejects(s.adapter.observeHistory({}, s.bytes), /context unavailable/);
  const other = setup();
  await assert.rejects(other.adapter.observeHistory(s.context, s.bytes), /context unavailable/);
  const changed = fixture.query(); changed.request.targetId = "other-target"; changed.request.pin.instance_id = "other-target";
  await assert.rejects(s.adapter.observeHistory(s.context, fixture.request(changed)), /context unavailable/);
  await assert.rejects(s.adapter.observeHistory(s.context, Buffer.concat([s.bytes, Buffer.from([0])])));
  await assert.rejects(s.adapter.observeHistory(s.context, Buffer.alloc(LIMITS.frameBytes + 1)), /frame limit/);
  const format1 = require("./fixtures/permit-witness-v2");
  const oldFrame = require("../../lib/coordination/permit-witness-frame");
  assert.throws(() => s.adapter.authorizeHistory(Buffer.from("not-history")));
  assert.throws(() => s.adapter.authorizeHistory(format1.request()), /SCHEMA/);
  assert.throws(() => s.adapter.authorizeHistory(oldFrame.encodeFrame({ direction: "request", operation: 2,
    requestId: fixture.ID, payload: Buffer.from("{}") })));
  const checkpoint = fixture.raw(fixture.canonical({ format_version: 2, action: "checkpoint", args: {} }));
  assert.throws(() => s.adapter.authorizeHistory(checkpoint), /SCHEMA/);
  assert.throws(() => new IsolatedHistoryAdapter({ providerPath, runtimeDirectory: s.root, budget: s.budget,
    timeoutMs: 5000, spawnOptions: {} }), /fields/);
  s.adapter.revokeHistory(s.context);
  await assert.rejects(s.adapter.observeHistory(s.context, s.bytes), /context unavailable/);
  assert.equal(s.budget.snapshot().workers, 0);
  assert.equal(fs.existsSync(path.join(s.root, "provider-loaded.jsonl")), false);
  const tooSmall = setup("normal", 5000, new IsolationBudget({ maxReservedBytes: 1 }));
  await assert.rejects(tooSmall.adapter.observeHistory(tooSmall.context, tooSmall.bytes), /budget exhausted/);
  assert.equal(tooSmall.budget.snapshot().workers, 0);
  assert.equal(launches.length, 0, "preflight and insufficient byte reservation must not call fork");
});
test("real managed worker observes only, never loads provider in parent, strips ambient preload and synthetic key", supported, async () => {
  const s = setup();
  const preload = path.join(s.root, "preload.cjs");
  fs.writeFileSync(preload, "require('node:fs').writeFileSync(" + JSON.stringify(path.join(s.root, "preload-ran")) + ",'synthetic');\n");
  const old = { NODE_OPTIONS: process.env.NODE_OPTIONS, ISOLATED_SYNTHETIC_KEY: process.env.ISOLATED_SYNTHETIC_KEY };
  let promise;
  try {
    process.env.NODE_OPTIONS = "--require=" + JSON.stringify(preload);
    process.env.ISOLATED_SYNTHETIC_KEY = "synthetic-not-a-real-credential";
    promise = run(s);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const outcome = await promise;
  assert.equal(outcome.status, "observed"); assert.equal(outcome.observation.status, "observed");
  assert.equal(outcome.observation.result.status, "not-found-at-boundary");
  assert.equal(outcome.evidence.identityAudited, true); assert.equal(outcome.evidence.managedSessionEstablished, true);
  assert.equal(outcome.evidence.forcedTerminationAttempted, false);
  assert.deepEqual(loaded(s), { pid: loaded(s).pid, allowedEnvironment: true, nodeOptionsAbsent: true, syntheticKeyAbsent: true });
  assert.notEqual(loaded(s).pid, process.pid); assert.equal(require.cache[providerPath], undefined);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0], {
    modulePath: path.resolve(__dirname, "../../lib/coordination/permit-witness-isolated-worker.js"), args: [providerPath],
    envKeys: ["PATH", "TEMP", "TMP", "TMPDIR", ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [])].sort(),
    execArgv: ["--unhandled-rejections=strict"],
  });
  fs.writeFileSync(path.join(s.root, "launch.json"), JSON.stringify(launches[0], null, 2));
  assert.equal(fs.existsSync(path.join(s.root, "preload-ran")), false);
  await assert.rejects(s.adapter.observeHistory(s.context, s.bytes), /context unavailable/);
  const next = s.adapter.authorizeHistory(s.bytes);
  await assert.rejects(s.adapter.observeHistory(next, s.bytes), /budget exhausted/);
  assert.equal(s.budget.snapshot().workers, 1, "direct exit cannot release a tree reservation");
  assert.equal(launches.length, 1, "reused or exhausted context cannot spawn again");
});
for (const mode of ["species", "unreturned", "extra", "committed", "noise", "parent-write", "disconnect"]) {
  test(`real in-worker ${mode} is terminal unknown, parent survives, no retry or budget release`, supported, async () => {
    const s = setup(mode);
    const outcome = await run(s);
    assert.equal(outcome.status, "unknown"); assert.equal(outcome.observation, undefined);
    assert.notEqual(loaded(s).pid, process.pid);
    if (mode === "species") assert.equal(fs.existsSync(path.join(s.root, "species-read")), true);
    if (["species", "unreturned", "extra", "committed"].includes(mode)) assert.equal(outcome.evidence.directExit.code, 1);
    if (mode === "noise") assert.equal(outcome.code, "ERR_ISOLATED_STDIO_LIMIT");
    if (mode === "parent-write") assert.equal(outcome.code, "ERR_ISOLATED_UNEXPECTED_MESSAGE");
    await assert.rejects(s.adapter.observeHistory(s.context, s.bytes), /context unavailable/);
    assert.equal(s.budget.snapshot().workers, 1);
  });
}
test("timeout closes real session; signed late response on live IPC cannot replace unknown; ignoring BYE is forcibly reaped", supported, async () => {
  // The deadline now includes startup and OS audits. Leave enough room to
  // reach the provider under parallel load before exercising late completion.
  const s = setup("late", 5000);
  const outcome = await run(s);
  assert.equal(outcome.status, "unknown"); assert.equal(outcome.code, "ERR_ISOLATED_TIMEOUT");
  assert.equal(fs.existsSync(path.join(s.root, "bye-ignored")), true);
  assert.equal(fs.existsSync(path.join(s.root, "late-completed")), true);
  assert.ok(outcome.evidence.lateResponseMessages >= 1, "actual IPC response after close, not local emit");
  assert.equal(outcome.evidence.forcedTerminationAttempted, true);
  assert.equal(outcome.evidence.directExit.signal, "SIGKILL");
  await assert.rejects(s.adapter.observeHistory(s.context, s.bytes), /context unavailable/);
});
test("revocation while provider is pending latches unknown and uses child handle to kill unresponsive BYE worker", supported, async () => {
  const s = setup("hang");
  const pending = run(s);
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(path.join(s.root, "provider-loaded.jsonl"))) {
    if (Date.now() > deadline) throw new Error("provider not loaded");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const during = s.budget.snapshot();
  assert.equal(during.workers, 1); assert.equal(during.dispatches, 1);
  assert.equal(during.reservedBytes, LIMITS.reservationBytes);
  const competing = setup("normal", 5000, s.budget);
  await assert.rejects(competing.adapter.observeHistory(competing.context, competing.bytes), /budget exhausted/);
  assert.equal(fs.existsSync(path.join(competing.root, "provider-loaded.jsonl")), false);
  assert.equal(s.adapter.revokeHistory(s.context), true);
  const outcome = await pending;
  assert.equal(outcome.status, "unknown"); assert.equal(outcome.code, "ERR_ISOLATED_REVOKED");
  assert.equal(outcome.evidence.forcedTerminationAttempted, true); assert.equal(outcome.evidence.directExit.signal, "SIGKILL");
});
test("descendant remains after direct worker exit: no claim of tree exit, budget retained, cooperative stop only", supported, async t => {
  const s = setup("descendant");
  t.after(async () => {
    fs.writeFileSync(path.join(s.root, "descendant-stop"), "synthetic-stop");
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(s.root, "descendant-stop-ack"))) {
      if (Date.now() > deadline) throw new Error("cooperation not acknowledged; evidence retained at " + s.root);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  const outcome = await run(s);
  assert.equal(outcome.status, "observed");
  const descendant = JSON.parse(fs.readFileSync(path.join(s.root, "descendant-ready"), "utf8"));
  assert.equal(descendant.allowedEnvironment, true); assert.equal(descendant.nodeOptionsAbsent, true);
  assert.equal(descendant.syntheticKeyAbsent, true);
  assert.doesNotThrow(() => process.kill(descendant.pid, 0)); // Presence only, NOT stable identity or tree-exit evidence.
  assert.equal(outcome.evidence.treeExitProven, false); assert.equal(s.budget.snapshot().workers, 1);
  t.diagnostic("Direct exit observed; descendant PID present. Stop acknowledgement proves cooperation only; no OS sandbox or tree cleanup claim.");
});

for (const mode of ["deep", "deep-request", "deep-response", "deep-wrapped-request",
  "startup-timeout", "startup-revoke", "startup-revoke-hello", "startup-late-hello", "startup-late-ready"]) {
  test(`isolated regression ${mode}: coordinator survives and terminal unknown cannot revive`, supported, async () => {
    const root = fs.mkdtempSync(path.join(scratch, mode + "-"));
    const probe = path.join(__dirname, "fixtures/permit-witness-isolated-revise-probe.js");
    const execution = await new Promise(resolve => {
      childProcess.execFile(process.execPath, ["--unhandled-rejections=strict", probe, mode, root],
        { env: environment(root), timeout: 12000, maxBuffer: 65536 },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr }));
    });
    fs.writeFileSync(path.join(root, "execution.json"), JSON.stringify(execution, null, 2));
    assert.equal(execution.code, 0, execution.stderr);
    assert.ok(execution.stdout.trim(), "probe exited without report; evidence retained at " + root);
    const report = JSON.parse(execution.stdout.trim());
    assert.equal(report.result.status, "unknown");
    assert.equal(report.result.code, mode.startsWith("deep") ? "ERR_ISOLATED_MESSAGE_LIMIT"
      : mode.includes("revoke") || mode === "startup-late-ready" ? "ERR_ISOLATED_REVOKED" : "ERR_ISOLATED_TIMEOUT");
    assert.equal(report.retryRejected, true); assert.equal(report.directExitObserved, true);
    assert.equal(report.budget.workers, 1); assert.equal(report.budget.dispatches, 1);
    assert.equal(report.budget.reservedBytes, LIMITS.reservationBytes);
    assert.equal(report.startupBudget.workers, 1); assert.equal(report.startupBudget.dispatches, 1);
    assert.equal(report.result.evidence.treeExitProven, false);
    if (mode.startsWith("startup")) {
      assert.equal(report.providerLoaded, false);
      assert.equal(report.cleanup.startupAbortRequested, true);
      assert.ok(report.elapsedMs < 1000, `startup terminal/cleanup took ${report.elapsedMs}ms`);
      if (mode === "startup-revoke-hello") assert.equal(report.helloSeen, true);
      if (mode === "startup-late-hello") assert.equal(report.lateHelloAttempted, true);
      if (mode === "startup-late-ready") {
        assert.equal(report.lateHelloAttempted, true);
        assert.equal(report.cleanup.sessionClosed, true);
        assert.equal(report.cleanup.directExitObserved, true);
        assert.equal(report.lifecycleExitResolved, true);
        const progress = JSON.parse(fs.readFileSync(path.join(root, "probe-progress.json"), "utf8"));
        const order = name => progress.events.findIndex(event => event.event === name);
        assert.ok(order("hello-held") >= 0);
        assert.ok(order("terminal") > order("hello-held"));
        assert.ok(order("hello-released") > order("terminal"));
        assert.ok(order("child-exit") > order("hello-released"));
      } else {
        // The probe independently saw exit, but the adapter never received the
        // child. Its observation handle must not pretend it confirmed exit.
        assert.ok(["pending", "unverified"].includes(report.cleanup.directExitState));
        assert.equal(report.cleanup.directExitObserved, false);
        assert.equal(report.lifecycleExitResolved, false);
      }
    }
  });
}

test("expired late-ready handshake fails explicitly with retained evidence instead of exit 0 and empty output", supported, async () => {
  const root = fs.mkdtempSync(path.join(scratch, "expired-ready-"));
  const execution = await new Promise(resolve => {
    childProcess.execFile(process.execPath, ["--unhandled-rejections=strict",
      path.join(__dirname, "fixtures/permit-witness-isolated-revise-probe.js"), "startup-expired-ready", root],
    { env: environment(root), timeout: 12000, maxBuffer: 65536 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr }));
  });
  fs.writeFileSync(path.join(root, "execution.json"), JSON.stringify(execution, null, 2));
  assert.equal(execution.code, 1); assert.equal(execution.signal, null);
  assert.match(execution.stderr, /missing lifecycle directExit confirmation/);
  const failure = JSON.parse(fs.readFileSync(path.join(root, "probe-failure.json"), "utf8"));
  assert.equal(failure.directExitObserved, true);
  assert.equal(failure.cleanup.directExitState, "unverified");
  assert.equal(failure.cleanup.directExitObserved, false);
  assert.equal(failure.cleanup.budget.workers, 1);
  assert.ok(failure.events.some(e => e.event === "expire-held-handshake"));
  assert.equal(fs.existsSync(path.join(root, "report.json")), false);
});

function cleanupProbe(t, mode, eventTimeoutMs = 5000) {
  const root = fs.mkdtempSync(path.join(scratch, "cleanup-" + mode + "-"));
  const child = realFork(path.join(__dirname, "fixtures/permit-witness-isolated-cleanup-probe.js"), [mode, root],
    { env: environment(root), execArgv: ["--unhandled-rejections=strict"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "", exit, failure;
  const events = [], waiters = new Set(), commands = [], failures = [];
  const save = () => fs.writeFileSync(path.join(root, "barriers.json"), JSON.stringify({ events, commands, failures, stderr,
    exit, processTreeExitProven: false }, null, 2));
  function rejectWaiters(error) {
    failure ||= error;
    for (const waiter of [...waiters]) waiter.finish(error);
    save();
  }
  child.stderr.on("data", chunk => { stderr += chunk; save(); }); child.stdout.resume();
  child.on("error", error => rejectWaiters(new Error("cleanup probe error: " + error.message)));
  child.on("message", event => {
    events.push(event); save();
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) waiter.finish(null, event);
      else if (waiter.forbidTerminal && event.event === "terminal") waiter.finish(new Error("terminal before " + waiter.label));
    }
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    exit = { code, signal };
    rejectWaiters(new Error("cleanup probe exited before expected event: " + JSON.stringify(exit)));
    resolve(exit);
  }));
  const next = (predicate, label, { forbidTerminal = false } = {}) => {
    const found = events.find(predicate); if (found) return Promise.resolve(found);
    if (failure || exit || (forbidTerminal && events.some(e => e.event === "terminal"))) {
      const error = failure || new Error("terminal before " + label); failures.push(error.message); save();
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = { predicate, label, forbidTerminal, finish(error, event) {
        clearTimeout(timer); waiters.delete(waiter);
        if (error) { failures.push(error.message); save(); reject(error); } else resolve(event);
      } };
      waiters.add(waiter);
      timer = setTimeout(() => waiter.finish(new Error("cleanup probe missing event: " + label)), eventTimeoutMs);
    });
  };
  const command = value => {
    commands.push(value); save();
    if (!child.connected) throw new Error("cleanup probe disconnected before command " + value.command);
    child.send(value, error => { if (error) rejectWaiters(error); });
  };
  async function boundedExit(ms) {
    let timer;
    try { return await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("cleanup probe exit not observed")), ms);
    })]); } finally { clearTimeout(timer); }
  }
  t.after(async () => {
    try {
      if (!exit) {
        // Let the probe reap its real retained worker handle before exiting.
        if (child.connected) child.disconnect();
        try { await boundedExit(2000); }
        catch { child.kill("SIGKILL"); await boundedExit(2000); }
      }
    } finally {
      rejectWaiters(new Error("cleanup probe test finished")); save();
    }
  });
  return { root, events, next, command, waitExit: () => boundedExit(5000) };
}

for (const mode of ["missing-event", "early-exit", "premature-terminal"]) {
  test(`cleanup probe harness ${mode} rejects boundedly and retains evidence`, supported, async t => {
    const probe = cleanupProbe(t, mode, mode === "missing-event" ? 100 : 5000);
    await assert.rejects(mode === "premature-terminal"
      ? probe.next(e => e.event === "provider-loaded", "provider-loaded", { forbidTerminal: true })
      : probe.next(e => e.event === "never", "never"),
    mode === "missing-event" ? /missing event: never/
      : mode === "premature-terminal" ? /terminal before provider-loaded/ : /exited before expected event/);
    const evidence = JSON.parse(fs.readFileSync(path.join(probe.root, "barriers.json"), "utf8"));
    assert.ok(evidence.failures.length > 0);
    if (mode === "early-exit") assert.deepEqual(evidence.exit, { code: 3, signal: null });
  });
}

for (const mode of ["success", "revoke", "timeout", "startup-revoke", "startup-timeout"]) {
  test(`cleanup barrier ${mode}: terminal returns with cleanup pending, later direct exit confirms without releasing tree budget`, supported, async t => {
    const { next, command, waitExit, events } = cleanupProbe(t, mode);
    if (mode.startsWith("startup")) await next(e => e.event === "hello-held", "hello-held");
    else await next(e => e.event === "provider-loaded", "provider-loaded", { forbidTerminal: mode !== "success" });
    if (mode === "timeout") {
      assert.equal(events.some(e => e.event === "terminal"), false);
      command({ command: "timeout" });
    }
    if (mode.includes("revoke")) command({ command: "revoke" });
    const terminal = await next(e => e.event === "terminal", "terminal");
    assert.equal(terminal.result.status, mode === "success" ? "observed" : "unknown");
    if (mode !== "success") assert.equal(terminal.result.code, mode.includes("revoke") ? "ERR_ISOLATED_REVOKED" : "ERR_ISOLATED_TIMEOUT");
    assert.equal(terminal.exitSeen, false);
    assert.equal(terminal.result.evidence.cleanupState, "pending");
    assert.equal(terminal.result.evidence.directExitObserved, false);
    if (mode.startsWith("startup")) command({ command: "hello" });
    // If observeHistory awaited old cleanup, terminal above would never arrive:
    // grace is blocked until THIS command after the result has been asserted.
    await next(e => e.event === "gate" && e.ms === 250, "grace gate");
    command({ command: "release", ms: 250 });
    await next(e => e.event === "kill-held", "kill-held");
    await next(e => e.event === "gate" && e.ms === 3000, "kill wait gate");
    command({ command: "release", ms: 3000 });
    command({ command: "inspect" });
    const pending = await next(e => e.event === "snapshot", "snapshot");
    assert.equal(pending.cleanup.cleanupTimedOut, true);
    assert.equal(pending.cleanup.cleanupState, "pending");
    assert.equal(pending.cleanup.directExitObserved, false); assert.equal(pending.exitSeen, false);
    assert.deepEqual(pending.result, terminal.result);
    assert.equal(pending.cleanup.budget.workers, 1); assert.equal(pending.cleanup.budget.dispatches, 1);
    command({ command: "exit" });
    const confirmed = await next(e => e.event === "confirmed", "confirmed");
    assert.equal(confirmed.exitSeen, true); assert.equal(confirmed.cleanup.cleanupState, "confirmed");
    assert.equal(confirmed.cleanup.directExitState, "confirmed"); assert.equal(confirmed.cleanup.directExit.signal, "SIGKILL");
    assert.equal(confirmed.cleanup.treeExitProven, false); assert.equal(confirmed.cleanup.chargesRetained, true);
    assert.equal(confirmed.cleanup.budget.workers, 1); assert.equal(confirmed.cleanup.budget.reservedBytes, LIMITS.reservationBytes);
    assert.deepEqual(confirmed.result, terminal.result);
    assert.deepEqual(await waitExit(), { code: 0, signal: null });
  });
}
