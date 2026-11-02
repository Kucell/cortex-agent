"use strict";

// Disposable coordinating process: an uncaught IPC callback in the adapter
// must fail this probe, not kill the outer node:test runner. All children are
// real fork handles; no managed identity/session/fact source is substituted.
const fs = require("node:fs"), path = require("node:path");
const cp = require("node:child_process");
const [mode, root] = process.argv.slice(2);
const readyBarrier = ["startup-late-ready", "startup-expired-ready"].includes(mode);
const nativeTimeout = setTimeout;
let expireHello, releaseHello;
if (readyBarrier) global.setTimeout = (callback, ms, ...args) => {
  if (new Error().stack.includes("managed-caller-session.js")) {
    // Only the late-runtime adoption fixture holds the HELLO timer. The real
    // startup-timeout/revoke probes keep their original wall clock timers.
    const timer = nativeTimeout(callback, 60000, ...args);
    expireHello = () => { clearTimeout(timer); callback(...args); };
    return timer;
  }
  return nativeTimeout(callback, ms, ...args);
};
let directExitObserved = false, child, killChild, helloSeen = false, revokeAfterHello, lateHelloAttempted = false, exited;
let lifecycle, result, completed = false, watchdog;
const events = [];
function record(event) {
  events.push(event);
  fs.writeFileSync(path.join(root, "probe-progress.json"), JSON.stringify({ mode, events, result,
    directExitObserved, helloSeen, lateHelloAttempted, cleanup: lifecycle?.snapshot() }, null, 2));
}
function failed(error) {
  if (completed) return;
  completed = true; clearTimeout(watchdog);
  record({ event: "failure", message: error.message });
  fs.writeFileSync(path.join(root, "probe-failure.json"), JSON.stringify({ message: error.message,
    directExitObserved, cleanup: lifecycle?.snapshot(), events }, null, 2));
  console.error("isolated revise probe failed: " + error.message);
  process.exitCode = 1;
  if (child && !directExitObserved) killChild("SIGKILL");
}
process.on("beforeExit", () => {
  if (!completed) failed(new Error("probe ended before report; awaited Promise had no live event source"));
});
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = nativeTimeout(() => reject(new Error("missing " + label + "; cleanup=" +
        JSON.stringify(lifecycle?.snapshot()))), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
const original = cp.fork;
cp.fork = (...args) => {
  if (readyBarrier) {
    // Controlled cancellation fault: retain the real child/session/channel,
    // but remove fork's signal once so HELLO can really complete after revoke.
    args[2] = { ...args[2] }; delete args[2].signal;
  }
  child = Reflect.apply(original, cp, args);
  killChild = child.kill.bind(child);
  child.on("error", error => record({ event: "child-error", code: error.code }));
  exited = new Promise(resolve => child.once("exit", (code, signal) => {
    directExitObserved = true; record({ event: "child-exit", code, signal }); resolve();
  }));
  if (mode.startsWith("startup")) {
    const send = child.send.bind(child);
    child.send = (message, ...rest) => {
      if (message?.type === "hello") {
        helloSeen = true;
        record({ event: "hello-held" });
        if (mode === "startup-revoke-hello" || readyBarrier) setImmediate(() => revokeAfterHello());
        if (readyBarrier) releaseHello = () => {
          lateHelloAttempted = true;
          record({ event: "hello-released" });
          try { send(message, () => {}); } catch (error) { record({ event: "late-send-failed", code: error.code }); }
        };
        if (mode === "startup-late-hello") setTimeout(() => {
          lateHelloAttempted = true;
          try { send(message, () => {}); } catch { /* Already aborted: no revival. */ }
        }, 200);
        return true;
      }
      return send(message, ...rest);
    };
  }
  return child;
};
const { IsolatedHistoryAdapter, IsolationBudget } = require("../../../lib/coordination/permit-witness-isolated-adapter");
cp.fork = original;
const fixture = require("./permit-witness-v2-history");
const budget = new IsolationBudget();
const adapter = new IsolatedHistoryAdapter({ providerPath: path.join(__dirname, "permit-witness-isolated-provider.js"),
  runtimeDirectory: root, budget, timeoutMs: mode.startsWith("startup") ? 150 : 5000 });
const q = fixture.query(); q.issuerStoreId = mode;
const bytes = fixture.request(q), context = adapter.authorizeHistory(bytes);
revokeAfterHello = () => adapter.revokeHistory(context);
const start = performance.now();
const pending = adapter.observeHistory(context, bytes);
lifecycle = adapter.historyLifecycle(context);
watchdog = nativeTimeout(() => failed(new Error("probe watchdog; report not completed")), 8000);
const startupBudget = budget.snapshot();
if (mode === "startup-revoke") adapter.revokeHistory(context);
void pending.then(async value => {
  result = value;
  record({ event: "terminal", status: result.status, code: result.code });
  const elapsedMs = performance.now() - start;
  let retryRejected = false;
  try { await adapter.observeHistory(context, bytes); } catch { retryRejected = true; }
  if (readyBarrier) {
    if (!releaseHello || !expireHello) throw new Error("HELLO barrier unavailable after terminal");
    // The business result is already delivered. Let the scheduled abort run,
    // then release the authentic HELLO; no 40ms-vs-150ms scheduling race.
    await new Promise(resolve => setImmediate(resolve));
    if (mode === "startup-expired-ready") {
      record({ event: "expire-held-handshake" }); expireHello();
    } else releaseHello();
  }
  await bounded(exited, "direct child exit");
  if (mode === "startup-expired-ready") releaseHello();
  if (!mode.startsWith("startup") || readyBarrier) await bounded(lifecycle.directExit, "lifecycle directExit confirmation");
  let lifecycleExitResolved = false;
  void lifecycle.directExit.then(() => { lifecycleExitResolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  // Only the deliberate late HELLO attempt needs this existing scheduling
  // wait; new cleanup ordering tests use explicit barriers instead.
  if (mode === "startup-late-hello") await new Promise(resolve => setTimeout(resolve, 250));
  const report = { elapsedMs, helloSeen, lateHelloAttempted, directExitObserved, retryRejected, startupBudget, result,
    cleanup: lifecycle.snapshot(), lifecycleExitResolved,
    providerLoaded: fs.existsSync(path.join(root, "provider-loaded.jsonl")), budget: budget.snapshot() };
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  completed = true; clearTimeout(watchdog);
  console.log(JSON.stringify(report));
}).catch(failed);
