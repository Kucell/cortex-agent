"use strict";

// Isolated lifecycle probes. Only real children owned by this process are reaped.
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");
const { beginManagedCallerSession, startManagedCallerSession } = require("../../../lib/governed/managed-caller-supervisor");

async function main() {
  const mode = process.argv[2];
  if (mode === "child") {
    process.stdout.write(JSON.stringify({ pid: process.pid }) + "\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "legacy-ignored-preflight") {
    startManagedCallerSession({}); // Intentionally unobserved: strict must fail.
    setImmediate(() => process.stdout.write("survived\n"));
    return;
  }
  if (mode === "legacy-ignored-handshake") {
    startManagedCallerSession({ modulePath: path.join(__dirname, "handshake-no-reply.js"), handshakeTimeoutMs: 100 });
    return;
  }
  if (mode === "legacy-caught") {
    await assert.rejects(startManagedCallerSession({}), { name: "TypeError", message: "modulePath is required" });
    const original = new Error("original preflight rejection");
    await assert.rejects(startManagedCallerSession({ get modulePath() { throw original; } }), error => error === original);
    process.stdout.write("caught original rejection\n");
    return;
  }
  assert.equal(mode, "postspawn-signal-throw");
  const spawn = cp.ChildProcess.prototype.spawn;
  let child, closed, actualExit, started;
  // Observation only: never throws, never substitutes fork/spawn/exit results.
  cp.ChildProcess.prototype.spawn = function (...args) {
    const result = spawn.apply(this, args);
    child = this;
    child.on("error", () => {});
    actualExit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    closed = new Promise(resolve => child.once("close", resolve));
    started = new Promise(resolve => {
      let output = "";
      child.stdout.on("data", data => {
        output += data.toString();
        if (output.includes("\n")) resolve(JSON.parse(output.slice(0, output.indexOf("\n"))));
      });
    });
    child.stderr.resume();
    return result;
  };
  const controller = new AbortController();
  controller.signal.addEventListener = () => { throw new Error("subscription failed after spawn"); };
  let ticket;
  try {
    ticket = beginManagedCallerSession({ modulePath: __filename, args: ["child"],
      spawnOptions: { signal: controller.signal } });
  } finally { cp.ChildProcess.prototype.spawn = spawn; }
  // A safety kill is scoped to this observed handle, never a process-name sweep.
  const safety = setTimeout(() => { if (child) child.kill("SIGKILL"); }, 5000);
  try {
    await assert.rejects(ticket.ready, /subscription failed after spawn/);
    const marker = await started;
    assert.equal(marker.pid, child.pid);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    let state = "pending";
    ticket.directExit.then(result => { state = result.kind; });
    await new Promise(setImmediate);
    const beforeKill = state;
    assert.equal(child.kill("SIGKILL"), true);
    const exit = await actualExit;
    await closed;
    await new Promise(setImmediate);
    process.stdout.write(JSON.stringify({ beforeKill, afterActualExit: state, exit, observedLiveChild: true }));
  } finally {
    clearTimeout(safety);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (closed) await closed;
  }
}

main().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
