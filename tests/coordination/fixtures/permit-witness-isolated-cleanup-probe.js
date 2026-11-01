"use strict";

// Real managed fork/session with controlled faults at the cleanup boundary.
// The outer test releases explicit barriers; no elapsed-time assertion decides
// whether a business result beat cleanup. No fake identity/fact source/ticket.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const [mode, root] = process.argv.slice(2);
// Harness failure regressions do not start a managed worker.
if (["missing-event", "early-exit", "premature-terminal"].includes(mode)) {
  process.on("disconnect", () => process.exit(0));
  if (mode === "early-exit") setImmediate(() => process.exit(3));
  if (mode === "premature-terminal") setImmediate(() => process.send({ event: "terminal" }));
} else {
const nativeTimeout = setTimeout, nativeClear = clearTimeout;
const gates = new Map();
let triggerDeadline, providerLoaded = false;
// Only the cleanup-ordering timeout probe uses a controlled clock/timer. Its
// purpose is return-before-cleanup ordering AFTER provider entry, not elapsed
// business deadline validation. Other startup/real deadline tests stay real.
let clock = performance.now();
if (mode === "timeout") Object.defineProperty(performance, "now", { value: () => clock });
function send(value) { process.send(value, () => {}); }
global.setTimeout = (callback, ms, ...args) => {
  if (mode === "timeout") {
    const stack = new Error().stack;
    if (ms === 1000 && stack.includes("permit-witness-isolated-adapter.js") &&
        !stack.includes("managed-caller-session.js")) {
      triggerDeadline = () => { clock += 1001; callback(...args); };
      return nativeTimeout(() => {}, 60000);
    }
    if (stack.includes("managed-caller-session.js")) return nativeTimeout(callback, 60000, ...args);
  }
  if (mode.startsWith("startup") && new Error().stack.includes("managed-caller-session.js")) {
    // Hold the real session's HELLO timer too, leaving the adapter deadline
    // active so a late real handshake can complete only after terminal return.
    return nativeTimeout(callback, 60000, ...args);
  }
  if (ms === 250 || ms === 3000) {
    const timer = nativeTimeout(() => {}, 60000);
    gates.set(ms, () => { nativeClear(timer); callback(...args); });
    send({ event: "gate", ms });
    return timer;
  }
  return nativeTimeout(callback, ms, ...args);
};
let child, nativeKill, heldHello, exitSeen = false, closed = false;
const fork = cp.fork;
cp.fork = (...args) => {
  // Hold cancellation too: the adapter must retain a late real runtime.
  if (mode.startsWith("startup")) { args[2] = { ...args[2] }; delete args[2].signal; }
  child = Reflect.apply(fork, cp, args);
  nativeKill = child.kill.bind(child);
  child.kill = () => { send({ event: "kill-held" }); return false; };
  child.once("exit", () => { exitSeen = true; });
  const sendChild = child.send.bind(child);
  child.send = (frame, ...rest) => {
    if (frame.type === "hello" && mode.startsWith("startup")) {
      heldHello = () => sendChild(frame, ...rest); send({ event: "hello-held" }); return true;
    }
    if (frame.type === "bye") { closed = true; send({ event: "bye-held" }); return true; }
    return sendChild(frame, ...rest);
  };
  return child;
};
const { IsolatedHistoryAdapter, IsolationBudget } = require("../../../lib/coordination/permit-witness-isolated-adapter");
cp.fork = fork;
const fixture = require("./permit-witness-v2-history"), budget = new IsolationBudget();
const adapter = new IsolatedHistoryAdapter({ providerPath: path.join(__dirname, "permit-witness-isolated-provider.js"),
  runtimeDirectory: root, budget, timeoutMs: mode.includes("timeout") ? 1000 : 5000 });
const q = fixture.query(); q.issuerStoreId = mode === "success" ? "barrier-success" : "barrier-pending";
const bytes = fixture.request(q), context = adapter.authorizeHistory(bytes);
let result, lifecycle;
const observing = adapter.observeHistory(context, bytes);
lifecycle = adapter.historyLifecycle(context);
void observing.then(value => {
  result = value;
  send({ event: "terminal", result, cleanup: lifecycle.snapshot(), exitSeen });
}).catch(error => { console.error(error); process.exitCode = 1; });
const poll = setInterval(() => {
  if (fs.existsSync(path.join(root, "provider-loaded.jsonl"))) {
    clearInterval(poll); providerLoaded = true; send({ event: "provider-loaded" });
  }
}, 10);
process.on("disconnect", () => {
  if (child && !exitSeen) nativeKill("SIGKILL");
  process.exit(0);
});
nativeTimeout(() => { if (child && !exitSeen) nativeKill("SIGKILL"); process.exit(2); }, 15000).unref();
process.on("message", message => {
  if (message.command === "timeout") {
    if (mode !== "timeout" || !providerLoaded || !triggerDeadline) throw new Error("deadline barrier not ready");
    triggerDeadline(); triggerDeadline = null;
  }
  if (message.command === "revoke") adapter.revokeHistory(context);
  if (message.command === "hello") { heldHello(); heldHello = null; }
  if (message.command === "release") {
    const gate = gates.get(message.ms); gates.delete(message.ms); gate();
  }
  if (message.command === "inspect") send({ event: "snapshot", cleanup: lifecycle.snapshot(), result, exitSeen, closed });
  if (message.command === "exit") {
    clearInterval(poll);
    void lifecycle.directExit.then(cleanup => {
      send({ event: "confirmed", cleanup, result, exitSeen });
      process.disconnect();
    });
    nativeKill("SIGKILL"); // Retained real handle; no PID/file-based signalling.
  }
});
}
