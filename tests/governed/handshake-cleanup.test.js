"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const childProcess = require("node:child_process");

test("a timed-out handshake reaps its child and captures asynchronous cleanup errors", async () => {
  let child;
  let childClosed = false;
  const originalFork = childProcess.fork;
  childProcess.fork = (...args) => {
    childClosed = false;
    child = originalFork(...args);
    child.once("close", () => { childClosed = true; });
    const send = child.send.bind(child);
    child.send = (message, ...rest) => {
      if (message && message.type === "bye") {
        queueMicrotask(() => child.emit("error", new Error("injected cleanup error")));
        return true;
      }
      return send(message, ...rest);
    };
    return child;
  };
  try {
    const { startManagedCallerSession } = require("../../lib/governed/managed-caller-supervisor");
    await assert.rejects(startManagedCallerSession({
      modulePath: path.join(__dirname, "fixtures", "handshake-no-reply.js"),
      handshakeTimeoutMs: 1000,
    }), (error) => /timed out/.test(error.message) && error.cleanupError?.message === "injected cleanup error");
    assert.ok(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "child has not exited");
    assert.equal(childClosed, true, "child streams have not closed");
    await assert.rejects(startManagedCallerSession({
      modulePath: path.join(__dirname, "fixtures", "handshake-no-reply.js"),
      spawnOptions: { execPath: path.join(__dirname, "nonexistent-node-executable") },
      handshakeTimeoutMs: 1000,
    }), { code: "ENOENT" });
    await assert.rejects(startManagedCallerSession({
      modulePath: path.join(__dirname, "fixtures", "m044-ms002-executor.js"),
      args: ["--mode=exit-early"], handshakeTimeoutMs: 1000,
    }), /session|channel|closed|timed out|signature/);
    assert.equal(childClosed, true, "early-exit child streams have not closed");
    await assert.rejects(startManagedCallerSession({
      modulePath: path.join(__dirname, "fixtures", "handshake-no-reply.js"),
      factSource: {}, handshakeTimeoutMs: 1000,
    }), TypeError);
    assert.equal(childClosed, true, "initialization-failure child streams have not closed");
    await assert.rejects(startManagedCallerSession({
      modulePath: path.join(__dirname, "fixtures", "handshake-no-reply.js"),
      args: ["--disconnect"], handshakeTimeoutMs: 300,
    }), /session|channel|closed|timed out/);
    assert.equal(childClosed, true, "disconnected child streams have not closed");
  } finally {
    if (child && child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    childProcess.fork = originalFork;
  }
});
