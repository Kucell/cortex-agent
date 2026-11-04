"use strict";

const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const childProcess = require("node:child_process"), { EventEmitter } = require("node:events");
const { testRuntime } = require("../helpers/runtime-sandbox");
const { SessionBudget, startBoundedSession } = require("../../lib/coordination/permit-witness-bounded-session");
const root = testRuntime("bounded-session-cleanup-race");
fs.mkdirSync(root, { recursive: true });
const supported = { skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) !== 24, timeout: 15000 };
const deadline = () => process.hrtime.bigint() + 4000000000n;
const modulePath = path.join(__dirname, "fixtures/permit-witness-bounded-session-cleanup-peer.js");
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("missing completion")), 6000); })]); }
  finally { clearTimeout(timer); }
}
for (const mode of ["copy", "post-copy", "established"]) {
  test(`EOF barrier (${mode}): fail-closed parent preserves child zeroization and proof`, supported, async t => {
    const directory = fs.mkdtempSync(path.join(root, mode + "-")), budget = new SessionBudget();
    const parentSecrets = [], random = crypto.randomBytes, alloc = Buffer.alloc;
    t.mock.method(crypto, "randomBytes", size => {
      const bytes = random(size);
      // The first two allocations are key/session; HELLO's public challenge
      // is not a secret copy and is deliberately outside this assertion.
      if (parentSecrets.length < 2) parentSecrets.push(bytes);
      return bytes;
    });
    t.mock.method(Buffer, "alloc", (size, ...args) => {
      const bytes = alloc(size, ...args); if (size === 56) parentSecrets.push(bytes); return bytes;
    });
    const ticket = startBoundedSession({ modulePath, args: [mode], runtimeDirectory: directory,
      budget, deadlineNs: deadline(), allowedOperations: [1] });
    t.after(async () => { ticket.terminate(); await bounded(ticket.directExit); });
    if (mode === "established") {
      await bounded(ticket.ready); fs.writeFileSync(path.join(directory, "abort-session"), "abort");
    } else await assert.rejects(bounded(ticket.ready), { code: "ERR_BOUNDED_SESSION_DISCONNECTED" });
    const closed = await bounded(ticket.session.closed);
    // Run the ticket's closed observer before sampling lifecycle state.
    await Promise.resolve();
    const beforeRelease = ticket.snapshot();
    const atEOF = JSON.parse(fs.readFileSync(path.join(directory, "cleanup-at-eof.json"), "utf8"));
    // The child cannot write proof until AFTER this parent has failed closed.
    assert.equal(fs.existsSync(path.join(directory, "key-cleanup.json")), false);
    fs.writeFileSync(path.join(directory, "release-cleanup"), "release");
    const exited = await bounded(ticket.directExit);
    const proofExists = fs.existsSync(path.join(directory, "key-cleanup.json"));
    t.diagnostic(JSON.stringify({ mode, atEOF, terminationAttempted: beforeRelease.terminationAttempted, exited, proofExists }));
    assert.equal(exited.signal, null, "SIGKILL must not interrupt the EOF cleanup barrier");
    assert.equal(exited.code, 0); assert.equal(proofExists, true);
    const expected = { copies: mode === "copy" ? 2 : 3, cleared: true };
    assert.deepEqual(atEOF, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "key-cleanup.json"), "utf8")), { rejected: mode !== "established", ...expected });
    assert.equal(closed.state, "ERR_BOUNDED_SESSION_DISCONNECTED");
    assert.equal(beforeRelease.directExitObserved, false); assert.equal(beforeRelease.terminationAttempted, false);
    assert.equal(parentSecrets.length, 3);
    for (const bytes of parentSecrets) assert.ok(bytes.every(byte => byte === 0));
    assert.deepEqual(ticket.session.snapshot(), closed);
    assert.equal(budget.snapshot().directExits, 1); assert.equal(budget.snapshot().chargesRetained, true);
    assert.equal(budget.snapshot().sessions, 1); assert.ok(budget.snapshot().capacityBytes > 0);
  });
}

// Lifecycle stubs below deliberately do not claim to prove native child exit.
// A fake clock makes the grace bound, deadline cap and cancellation exact.
async function eofLifecycle(t, remainingMs = 4000) {
  const child = new EventEmitter(), kills = [], sample = process.hrtime.bigint();
  let now = sample;
  child.pid = 123456;
  child.kill = signal => { kills.push(signal); return true; };
  t.mock.method(childProcess, "spawn", () => { queueMicrotask(() => child.emit("spawn")); return child; });
  t.mock.method(process.hrtime, "bigint", () => now);
  t.mock.method(fs, "writeSync", (fd, bytes) => bytes.length);
  t.mock.method(fs, "readSync", () => { now = sample + BigInt(4000 - remainingMs) * 1000000n; return 0; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const budget = new SessionBudget(), ticket = startBoundedSession({ modulePath, runtimeDirectory: root,
    budget, deadlineNs: sample + 4000000000n, allowedOperations: [1] });
  t.after(() => { if (!ticket.snapshot().directExitObserved) child.emit("exit", null, "SIGKILL"); });
  await assert.rejects(ticket.ready, { code: "ERR_BOUNDED_SESSION_DISCONNECTED" });
  return { child, kills, budget, ticket };
}
for (const remainingMs of [4000, 50]) {
  test(`EOF grace is bounded by ${Math.min(300, remainingMs)}ms and kill/close are not exit proof`, supported, async t => {
    const { child, kills, budget, ticket } = await eofLifecycle(t, remainingMs);
    const grace = Math.min(300, remainingMs);
    assert.equal(ticket.snapshot().terminationAttempted, false);
    t.mock.timers.tick(grace - 1); assert.deepEqual(kills, []);
    t.mock.timers.tick(1); assert.deepEqual(kills, ["SIGKILL"]);
    assert.equal(ticket.snapshot().terminationAttempted, true);
    assert.equal(ticket.snapshot().directExitObserved, false); assert.equal(budget.snapshot().directExits, 0);
    let exited = false; void ticket.directExit.then(() => { exited = true; });
    child.emit("close", 0, null); await Promise.resolve(); assert.equal(exited, false);
    child.emit("exit", null, "SIGKILL");
    assert.deepEqual(await ticket.directExit, { kind: "exited", code: null, signal: "SIGKILL" });
    assert.equal(budget.snapshot().directExits, 1); assert.equal(budget.snapshot().chargesRetained, true);
    t.mock.timers.tick(4000); assert.deepEqual(kills, ["SIGKILL"]);
  });
}
test("natural exit cancels EOF grace without a later kill", supported, async t => {
  const { child, kills, ticket } = await eofLifecycle(t);
  child.emit("exit", 0, null); await ticket.directExit;
  t.mock.timers.tick(4000); assert.deepEqual(kills, []);
});
test("parent spawn error during EOF grace still kills immediately", supported, async t => {
  const { child, kills } = await eofLifecycle(t);
  child.emit("error", new Error("injected parent-side launch error"));
  assert.deepEqual(kills, ["SIGKILL"]);
  t.mock.timers.tick(4000); assert.deepEqual(kills, ["SIGKILL"]);
});
test("explicit termination during EOF grace kills immediately and cancels the timer", supported, async t => {
  const { kills, ticket } = await eofLifecycle(t);
  assert.equal(ticket.terminate(), true); assert.deepEqual(kills, ["SIGKILL"]);
  t.mock.timers.tick(4000); assert.deepEqual(kills, ["SIGKILL"]);
});
