"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConsumerCursorStore } = require("../lib/coordination/consumer-cursor");
const { Journal } = require("../lib/coordination/journal");
const { LeaseManager, createManualClock } = require("../lib/coordination/lease");
const { writeLeaseState } = require("../lib/coordination/lease-store");

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("journal renews a live lock before its TTL expires", async (t) => {
  const dir = freshDir("cortex-journal-renew-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = Journal.open(dir, { lockTtlMs: 45, fsync: false });
  t.after(() => journal.close());

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.throws(
    () => Journal.open(dir, { lockTtlMs: 45, fsync: false }),
    { key: "ERR_LEASE_CONFLICT" }
  );
  const lock = JSON.parse(fs.readFileSync(path.join(dir, "journal.lock"), "utf8"));
  assert.ok(Date.parse(lock.expiresAt) > Date.now());
});

test("journal rejects stale-lock reclaim when the observed owner changes before rename", (t) => {
  const dir = freshDir("cortex-journal-reclaim-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockFile = path.join(dir, "journal.lock");
  fs.writeFileSync(lockFile, JSON.stringify({
    owner: "observed-stale",
    acquiredAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:01:00.000Z",
    pid: 1,
  }));
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && source === lockFile) {
      injected = true;
      fs.writeFileSync(lockFile, JSON.stringify({
        owner: "replacement-owner",
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pid: process.pid,
      }));
    }
    return originalRename(source, target);
  };
  t.after(() => { fs.renameSync = originalRename; });

  assert.throws(
    () => Journal.open(dir, { fsync: false }),
    (error) => error && error.key === "ERR_LEASE_CONFLICT" &&
      error.details && error.details.reason === "reclaim_raced"
  );
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).owner, "replacement-owner");
});

test("consumer cursor rejects stale-lock reclaim when the observed token changes", (t) => {
  const dir = freshDir("cortex-cursor-reclaim-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursor = new ConsumerCursorStore(dir, "consumer-a", {
    clock: () => 10_000,
    lockTtlMs: 100,
  });
  fs.writeFileSync(cursor.lockFile, JSON.stringify({ token: "observed", expiresAt: 1 }));
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && source === cursor.lockFile) {
      injected = true;
      fs.writeFileSync(cursor.lockFile, JSON.stringify({
        token: "replacement",
        expiresAt: 20_000,
      }));
    }
    return originalRename(source, target);
  };
  t.after(() => { fs.renameSync = originalRename; });

  assert.throws(
    () => cursor.advanceHighWater(1),
    (error) => error && error.code === "ERR_CURSOR_LOCKED" &&
      error.details && error.details.reason === "reclaim_raced"
  );
  assert.equal(JSON.parse(fs.readFileSync(cursor.lockFile, "utf8")).token, "replacement");
});

test("lease store closes and fsyncs the temporary file before rename", (t) => {
  const dir = freshDir("cortex-lease-persist-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new LeaseManager({ clock: createManualClock(0) });
  manager.acquire("src/**", "agent-a");

  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRename = fs.renameSync;
  let tempFd;
  const closed = new Set();
  fs.openSync = (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (String(file).includes("state.json.tmp.")) tempFd = fd;
    return fd;
  };
  fs.closeSync = (fd) => {
    closed.add(fd);
    return originalClose(fd);
  };
  fs.renameSync = (source, target) => {
    if (String(source).includes("state.json.tmp.")) {
      assert.ok(closed.has(tempFd), "temporary lease-state fd must be closed before rename");
    }
    return originalRename(source, target);
  };
  t.after(() => {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.renameSync = originalRename;
  });

  writeLeaseState(dir, manager);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).version, 1);
});
