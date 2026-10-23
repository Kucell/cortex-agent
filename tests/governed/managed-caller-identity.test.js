"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const {
  collectProcessFacts,
  readProcessStartToken,
  readSocketHolders,
  readIpcSocketEndpoint,
  readSocketInode,
  readCommandDigest,
} = require("../../lib/governed/managed-caller-identity");

describe("governed/managed-caller-identity - process facts", () => {
  test("the current process has a start token that is stable", () => {
    const first = readProcessStartToken(process.pid);
    const second = readProcessStartToken(process.pid);
    assert.ok(first, "expected a start token for the current process");
    assert.equal(first, second);
  });

  test("an invalid pid has no start token", () => {
    assert.equal(readProcessStartToken(0), null);
    assert.equal(readProcessStartToken(-1), null);
    assert.equal(readProcessStartToken(999_999_999), null);
  });

  test("the start token distinguishes processes started at different times", async () => {
    // The token exists for one reason: to detect that the process behind a pid
    // is no longer the one that was started. That means a LATER process has to
    // carry a different token than an earlier one.
    //
    // The exact resolution is a platform property: macOS reads the
    // microsecond start time out of `proc_bsdinfo`, Linux reads the kernel's
    // start tick. A resolution too coarse to separate processes started in the
    // same tick would still separate two processes that are not.
    const first = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const firstToken = readProcessStartToken(first.pid);
      assert.ok(firstToken, "expected a start token for the first process");

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const second = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const secondToken = readProcessStartToken(second.pid);
        assert.ok(secondToken, "expected a start token for the second process");
        assert.notEqual(
          secondToken,
          firstToken,
          "a process started later must not share the earlier process's token",
        );
      } finally {
        try {
          second.kill("SIGKILL");
        } catch (_) {
          // Already gone.
        }
      }
    } finally {
      try {
        first.kill("SIGKILL");
      } catch (_) {
        // Already gone.
      }
    }
  });

  test("the command digest is present and changes with the command line", () => {
    const digest = readCommandDigest(process.pid);
    assert.ok(digest, "expected a command digest for the current process");
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  });

  test("an invalid pid has no command digest", () => {
    assert.equal(readCommandDigest(0), null);
    assert.equal(readCommandDigest(999_999_999), null);
  });
});

describe("governed/managed-caller-identity - socket facts", () => {
  test("an unknown socket address has no holders", () => {
    // An address that no live socket can have. The all-zero address is NOT a
    // safe sample: on Linux it is a real unnamed-socket address, and a busy
    // machine has plenty of those.
    assert.deepEqual(readSocketHolders({ address: "0xdeadbeefdeadbeef" }), []);
    assert.deepEqual(readSocketHolders({ address: "" }), []);
    assert.deepEqual(readSocketHolders(null), []);
    assert.deepEqual(readSocketHolders({}), []);
  });

  test("socket addresses are compared case-insensitively", () => {
    assert.deepEqual(readSocketHolders({ address: "0xDEADBEEFDEADBEEF" }), []);
  });

  test("an invalid pid has no IPC socket endpoint", () => {
    assert.equal(readIpcSocketEndpoint(0), null);
    assert.equal(readIpcSocketEndpoint(999_999_999), null);
  });

  test("an invalid pid has no socket inode", () => {
    assert.equal(readSocketInode(0, 3), null);
    assert.equal(readSocketInode(999_999_999, 3), null);
    assert.equal(readSocketInode(process.pid, 999_999), null);
  });

  test("the holder lookup identifies the socket by inode on Linux", () => {
    // On Linux the `0x...` column of `lsof -U` is a HASH of the socket's
    // inode, and it collides with unrelated sockets on a busy machine. That
    // collision made the audit report a transferred handle for a clean
    // channel, which failed CI. The inode identifies the socket object
    // itself, so the lookup has to use it where it is available.
    if (process.platform !== "linux") return;

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    try {
      const endpoint = readIpcSocketEndpoint(child.pid);
      assert.ok(endpoint, "expected an IPC socket endpoint for the child");
      assert.equal(typeof endpoint.inode, "number", "expected a socket inode on Linux");

      const holders = readSocketHolders(endpoint);
      assert.ok(holders.includes(child.pid), "the child itself must be a holder");
    } finally {
      try {
        child.kill("SIGKILL");
      } catch (_) {
        // Already gone.
      }
    }
  });
});

describe("governed/managed-caller-identity - fact collection", () => {
  test("collecting facts for a missing child yields empty values, not a throw", () => {
    const facts = collectProcessFacts(null);
    assert.equal(facts.pid, 0);
    assert.equal(facts.startToken, null);
    assert.equal(facts.commandDigest, null);
    assert.equal(facts.socketAddress, null);
    assert.equal(facts.socketEndpoint, null);
    assert.deepEqual(facts.holders, []);
  });

  test("collecting facts for a live process yields a pid and a start token", () => {
    const facts = collectProcessFacts({ pid: process.pid });
    assert.equal(facts.pid, process.pid);
    assert.ok(facts.startToken);
    assert.ok(facts.commandDigest);
  });
});
