"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  collectProcessFacts,
  readProcessStartToken,
  readSocketHolders,
  readIpcSocketAddress,
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
    assert.deepEqual(readSocketHolders("0x0000000000000000"), []);
    assert.deepEqual(readSocketHolders(""), []);
    assert.deepEqual(readSocketHolders(null), []);
  });

  test("an invalid pid has no IPC socket address", () => {
    assert.equal(readIpcSocketAddress(0), null);
    assert.equal(readIpcSocketAddress(999_999_999), null);
  });
});

describe("governed/managed-caller-identity - fact collection", () => {
  test("collecting facts for a missing child yields empty values, not a throw", () => {
    const facts = collectProcessFacts(null);
    assert.equal(facts.pid, 0);
    assert.equal(facts.startToken, null);
    assert.equal(facts.commandDigest, null);
    assert.equal(facts.socketAddress, null);
    assert.deepEqual(facts.holders, []);
  });

  test("collecting facts for a live process yields a pid and a start token", () => {
    const facts = collectProcessFacts({ pid: process.pid });
    assert.equal(facts.pid, process.pid);
    assert.ok(facts.startToken);
    assert.ok(facts.commandDigest);
  });
});
