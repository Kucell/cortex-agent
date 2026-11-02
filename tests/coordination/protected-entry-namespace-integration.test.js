"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

// The store has to judge the COMPLETE protected entry namespace, not only
// the entry name it happens to assemble. A second record of the same
// logical slot under a different name makes the outcome of that slot
// ambiguous, and the store must refuse it.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const anchorModule = require("../../lib/coordination/protected-anchor");

const root = testRuntime("test-tmp");

// The digest an anchor entry carries over its own fields. It is recomputed
// here instead of imported, so the test does not depend on the module
// exporting its own digest helper.
function entryDigest(entry) {
  return crypto.createHash("sha256").update([
    String(entry.schema_version), String(entry.type), String(entry.sequence),
    String(entry.body_digest), String(entry.store_id), String(entry.attempt),
  ].join("\n")).digest("hex");
}

function fixture(t) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-namespace-wire-"));
  // The anchor has to live outside the database rollback domain.
  const anchorDir = path.join(path.dirname(dir), `${path.basename(dir)}-anchor`);
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const file = path.join(dir, "db", "state.sqlite");
  fs.mkdirSync(path.dirname(file));
  let now = 1_000_000;
  const clock = () => now;
  const store = ProtectedPermitStore.initialize(file, {
    decisionId: "D-namespace", clock, anchorDir, anchorMode: anchorModule.ANCHOR_MODE.permissive,
  });
  t.after(() => {
    try { store.close(); } catch { /* the store may already be closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  });
  return { dir, anchorDir, file, store, clock, advance: (ms) => { now += ms; } };
}

// Write a second record of the SAME logical slot under a different file
// name. The store's own writes never produce this shape, so it has to be
// forged to prove that the namespace is really enumerated.
function forgeDuplicateIntent(f, sequence, attempt, bodyDigest) {
  const record = {
    schema_version: 1,
    type: "intent",
    sequence,
    body_digest: bodyDigest,
    store_id: f.store.snapshot().store_id,
    attempt,
  };
  record.entry_digest = entryDigest(record);
  const name = `protected-anchor-entry-${String(sequence).padStart(12, "0")}-${String(attempt).padStart(6, "0")}-intent-forged.json`;
  fs.writeFileSync(path.join(f.anchorDir, name), JSON.stringify(record) + "\n", { mode: 0o600 });
  return name;
}

test("a second intent of the same slot under another name is refused on open", t => {
  const f = fixture(t);
  // The bootstrap wrote the intent and the commit of sequence 1. A second
  // intent of the same slot is ambiguous: the slot has two beginnings.
  const journal = anchorModule.readJournal(anchorModule.journalFileFor(f.anchorDir));
  const intent = journal.entries.find((entry) => entry.type === "intent");
  forgeDuplicateIntent(f, intent.sequence, intent.attempt, intent.body_digest);
  f.store.close();
  assert.throws(() => ProtectedPermitStore.open(f.file, {
    expectedDecisionId: "D-namespace", minimumEpoch: 1, anchorDir: f.anchorDir,
    clock: f.clock, anchorMode: anchorModule.ANCHOR_MODE.permissive,
  }), { code: "ERR_ANCHOR_CORRUPT" });
});

test("a commit and an abort of the same slot are refused on open", t => {
  const f = fixture(t);
  const journal = anchorModule.readJournal(anchorModule.journalFileFor(f.anchorDir));
  const intent = journal.entries.find((entry) => entry.type === "intent");
  const record = {
    schema_version: 1,
    type: "abort",
    sequence: intent.sequence,
    body_digest: intent.body_digest,
    store_id: intent.store_id,
    attempt: intent.attempt,
  };
  record.entry_digest = entryDigest(record);
  const name = `protected-anchor-entry-${String(intent.sequence).padStart(12, "0")}-${String(intent.attempt).padStart(6, "0")}-abort-forged.json`;
  fs.writeFileSync(path.join(f.anchorDir, name), JSON.stringify(record) + "\n", { mode: 0o600 });
  f.store.close();
  assert.throws(() => ProtectedPermitStore.open(f.file, {
    expectedDecisionId: "D-namespace", minimumEpoch: 1, anchorDir: f.anchorDir,
    clock: f.clock, anchorMode: anchorModule.ANCHOR_MODE.permissive,
  }), { code: "ERR_ANCHOR_CORRUPT" });
});

test("a later complete attempt cannot hide an earlier commit and abort", t => {
  const f = fixture(t);
  const journal = anchorModule.readJournal(anchorModule.journalFileFor(f.anchorDir));
  const intent = journal.entries.find(entry => entry.type === "intent");
  for (const [attempt, type] of [[intent.attempt, "abort"], [intent.attempt + 1, "intent"], [intent.attempt + 1, "commit"]]) {
    const record = { schema_version: 1, type, sequence: intent.sequence, body_digest: intent.body_digest, store_id: intent.store_id, attempt };
    record.entry_digest = entryDigest(record);
    const name = `protected-anchor-entry-${String(intent.sequence).padStart(12, "0")}-${String(attempt).padStart(6, "0")}-${type}-forged.json`;
    fs.writeFileSync(path.join(f.anchorDir, name), JSON.stringify(record) + "\n", { mode: 0o600 });
  }
  f.store.close();
  assert.throws(() => ProtectedPermitStore.open(f.file, {
    expectedDecisionId: "D-namespace", minimumEpoch: 1, anchorDir: f.anchorDir,
    clock: f.clock, anchorMode: anchorModule.ANCHOR_MODE.permissive,
  }), { code: "ERR_ANCHOR_CORRUPT" });
});

test("a superseded attempt of an earlier sequence is not a corruption", t => {
  const f = fixture(t);
  const journal = anchorModule.readJournal(anchorModule.journalFileFor(f.anchorDir));
  const commit = journal.entries.find((entry) => entry.type === "commit");
  // A retry of the same sequence is a NEW attempt: it writes its own intent
  // and its own commit, and the earlier attempt stays behind. The earlier
  // attempt is superseded, so it does not make the slot ambiguous -- the
  // namespace is judged on the attempt that decides the fate of the
  // sequence.
  const attempt = commit.attempt + 1;
  for (const type of ["intent", "commit"]) {
    const record = {
      schema_version: 1,
      type,
      sequence: commit.sequence,
      body_digest: commit.body_digest,
      store_id: commit.store_id,
      attempt,
    };
    record.entry_digest = entryDigest(record);
    const name = `protected-anchor-entry-${String(commit.sequence).padStart(12, "0")}-${String(attempt).padStart(6, "0")}-${type}-retry.json`;
    fs.writeFileSync(path.join(f.anchorDir, name), JSON.stringify(record) + "\n", { mode: 0o600 });
  }
  f.store.close();
  const store = ProtectedPermitStore.open(f.file, {
    expectedDecisionId: "D-namespace", minimumEpoch: 1, anchorDir: f.anchorDir,
    clock: f.clock, anchorMode: anchorModule.ANCHOR_MODE.permissive,
  });
  assert.equal(store.snapshot().store_id, commit.store_id);
  store.close();
});

test("a long deployment path does not make the namespace enumeration fail", t => {
  // The domain identifier is a digest of the anchor directory, not the path
  // itself: a path that is longer than the identifier limit must still be
  // enumerable, otherwise a long deployment path would break every open.
  const deep = path.join(root, "d".repeat(160));
  fs.mkdirSync(deep, { recursive: true });
  const anchorDir = path.join(deep, "anchor");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const file = path.join(deep, "db", "state.sqlite");
  fs.mkdirSync(path.dirname(file));
  const store = ProtectedPermitStore.initialize(file, {
    decisionId: "D-long", clock: () => 1000, anchorDir, anchorMode: anchorModule.ANCHOR_MODE.permissive,
  });
  store.close();
  assert.ok(path.resolve(anchorDir).length > 128);
  const reopened = ProtectedPermitStore.open(file, {
    expectedDecisionId: "D-long", minimumEpoch: 1, anchorDir, clock: () => 1000,
    anchorMode: anchorModule.ANCHOR_MODE.permissive,
  });
  assert.equal(reopened.snapshot().decision_id, "D-long");
  reopened.close();
  fs.rmSync(deep, { recursive: true, force: true });
});
