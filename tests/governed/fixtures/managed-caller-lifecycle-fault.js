"use strict";

// Exercise a real child whose first cleanup kill fails. No PID sweep is used.
const cp = require("node:child_process");
const path = require("node:path");
const fork = cp.fork;
let child, kill;
cp.fork = (...args) => {
  child = fork(...args);
  kill = child.kill.bind(child);
  child.kill = () => false;
  return child;
};
const { beginManagedCallerSession } = require("../../../lib/governed/managed-caller-supervisor");

async function main() {
  const lease = beginManagedCallerSession({
    modulePath: path.join(__dirname, "handshake-no-reply.js"), handshakeTimeoutMs: 100,
  });
  let exited = false;
  lease.directExit.then(() => { exited = true; });
  const safety = setTimeout(() => { if (child) kill("SIGKILL"); }, 8000);
  try {
    let failure;
    try { await lease.ready; } catch (error) { failure = error; }
    if (!failure || !/timed out/.test(failure.message) || !failure.cleanupError || exited) throw new Error("incorrect failed cleanup state");
    // The retained guards must tolerate late asynchronous process/channel errors.
    child.emit("error", new Error("synthetic late child error"));
    if (child.channel) child.channel.emit("error", new Error("synthetic late channel error"));
    if (!kill("SIGKILL")) throw new Error("real kill failed");
    const result = await lease.directExit;
    if (result.kind !== "exited" || result.signal !== "SIGKILL") throw new Error("exit was not observed");
    process.stdout.write(JSON.stringify({ timedOutBeforeExit: true, cleanupError: failure.cleanupError.message, result }));
  } finally { clearTimeout(safety); if (child && child.exitCode === null && child.signalCode === null) kill("SIGKILL"); }
}
main().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
