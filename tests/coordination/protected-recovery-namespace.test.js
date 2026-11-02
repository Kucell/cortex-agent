"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const anchor = require("../../lib/coordination/protected-anchor");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");

function fixture(t, crash = false) {
  const root = testRuntime("test-tmp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "recovery-namespace-"));
  const anchorDir = path.join(dir, "anchor"), dbDir = path.join(dir, "db");
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  fs.mkdirSync(dbDir);
  const file = path.join(dbDir, "state.sqlite");
  const options = { decisionId: "D-namespace-recovery", expectedDecisionId: "D-namespace-recovery",
    anchorDir, anchorMode: "permissive", minimumEpoch: 1, clock: () => 1000,
    audit: { by: "fixture", reason: "namespace regression" }, acceptDatabaseAsTruth: true };
  const store = Store.initialize(file, options);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = anchor.readJournal(anchor.journalFileFor(anchorDir)).entries.find(entry => entry.type === "intent");
  const append = anchor.appendEntry;
  if (crash) anchor.appendEntry = function(journal, entry, ...args) {
    // Fail the real transaction after SQLite COMMIT and before its external
    // commit witness/high-water, rather than manufacturing the database body.
    if (entry.type === "commit" && entry.sequence === 2) throw Object.assign(Error("commit witness failed"), { code: "EIO" });
    return append.call(this, journal, entry, ...args);
  };
  try {
    if (crash) assert.throws(() => store.restartService(), { code: "EIO" });
    else store.restartService();
  } finally { anchor.appendEntry = append; }
  store.close();
  if (crash) assert.throws(() => Store.open(file, options), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
  return { anchorDir, file, options, first };
}

function writeEntry(f, base, type, attempt, suffix) {
  const entry = { schema_version: 1, type, sequence: base.sequence,
    body_digest: base.body_digest, store_id: base.store_id, attempt };
  entry.entry_digest = crypto.createHash("sha256").update([entry.schema_version, entry.type,
    entry.sequence, entry.body_digest, entry.store_id, entry.attempt].join("\n")).digest("hex");
  const name = `protected-anchor-entry-${String(entry.sequence).padStart(12, "0")}-${String(attempt).padStart(6, "0")}-${type}-${suffix}.json`;
  fs.writeFileSync(path.join(f.anchorDir, name), JSON.stringify(entry) + "\n", { mode: 0o600 });
}

function entries(f) {
  return fs.readdirSync(f.anchorDir).filter(name => name.startsWith("protected-anchor-entry-") ||
    name === anchor.HIGH_WATER_FILE).sort().map(name => [name, fs.readFileSync(path.join(f.anchorDir, name), "hex")]);
}

for (const method of ["recoverFromAnchorCrash", "rebuildAnchor"]) {
  for (const conflict of ["duplicate-intent", "commit-and-abort"]) {
    test(`${method} refuses own ${conflict} before changing witnesses or quarantining foreign entries`, t => {
      const f = fixture(t, method === "recoverFromAnchorCrash");
      writeEntry(f, f.first, conflict === "duplicate-intent" ? "intent" : "abort", f.first.attempt, "conflict");
      for (const type of ["intent", "commit"]) writeEntry(f, f.first, type, f.first.attempt + 1, "newer");
      writeEntry(f, { ...f.first, store_id: "f".repeat(32) }, "commit", 1, "foreign");
      const before = entries(f);
      assert.throws(() => Store.open(f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
      assert.throws(() => Store[method](f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
      assert.deepEqual(entries(f), before);
      assert.equal(fs.existsSync(path.join(f.anchorDir, "quarantine")), false);
      const audit = fs.readFileSync(path.join(f.anchorDir, "protected-anchor-recovery.log"), "utf8")
        .trim().split("\n").map(line => JSON.parse(line));
      assert.ok(audit.every(record => record.refused === true && record.code === "ERR_ANCHOR_CORRUPT"));
      assert.throws(() => Store.open(f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
    });
  }
}

test("rebuild quarantines a foreign orphan commit without weakening the own namespace", t => {
  const f = fixture(t);
  const ownBefore = entries(f);
  // A canonical orphan commit at an unused attempt of an independently
  // witnessed sequence is isolatable; a collision with the own slot is not.
  const beforeNames = new Set(fs.readdirSync(f.anchorDir));
  anchor.appendEntry(anchor.journalFileFor(f.anchorDir), {
    ...f.first, type: "commit", store_id: "f".repeat(32), attempt: f.first.attempt + 1,
  });
  const foreignName = fs.readdirSync(f.anchorDir).find(name => !beforeNames.has(name));
  const foreignBytes = fs.readFileSync(path.join(f.anchorDir, foreignName));
  assert.throws(() => Store.open(f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
  const rebuilt = Store.rebuildAnchor(f.file, f.options);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.audit.quarantined_entries, 1);
  assert.deepEqual(entries(f), ownBefore);
  const quarantine = path.join(f.anchorDir, "quarantine");
  assert.ok(fs.readdirSync(quarantine).some(name => fs.readFileSync(path.join(quarantine, name)).equals(foreignBytes)));
  const reopened = Store.open(f.file, f.options);
  try { assert.equal(reopened.snapshot().store_id, f.first.store_id); }
  finally { reopened.close(); }
});

for (const method of ["recoverFromAnchorCrash", "rebuildAnchor"]) {
  for (const conflict of ["intent", "abort", "commit"]) {
    for (const rename of [false, true]) {
      test(`R4(a) ${method} refuses relabelled own ${conflict} (renamed=${rename})`, t => {
        const f = fixture(t, method === "recoverFromAnchorCrash");
        const entry = { ...f.first, store_id: "f".repeat(32) };
        if (rename) {
          anchor.appendEntry(anchor.journalFileFor(f.anchorDir), { ...entry, type: conflict });
        } else {
          // Preserve the pathname of the original own record, changing only
          // store_id and its freely recomputable self-digest.
          let name;
          if (conflict === "abort") {
            anchor.appendEntry(anchor.journalFileFor(f.anchorDir), { ...f.first, type: conflict });
            name = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000001-") && name.includes("-abort-"));
          } else {
            writeEntry(f, f.first, conflict, entry.attempt, "duplicate");
            name = fs.readdirSync(f.anchorDir).find(name => name.endsWith("-duplicate.json"));
          }
          const full = path.join(f.anchorDir, name);
          const changed = JSON.parse(fs.readFileSync(full, "utf8"));
          changed.store_id = entry.store_id;
          changed.entry_digest = crypto.createHash("sha256").update([changed.schema_version, changed.type,
            changed.sequence, changed.body_digest, changed.store_id, changed.attempt].join("\n")).digest("hex");
          fs.writeFileSync(full, JSON.stringify(changed) + "\n", { mode: 0o600 });
        }
        const before = entries(f);
        assert.throws(() => Store[method](f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
        assert.deepEqual(entries(f), before);
        assert.equal(fs.existsSync(path.join(f.anchorDir, "quarantine")), false);
      });
    }
  }
}

test("R4(b) a foreign higher-attempt commit cannot hide a missing own commit during rebuild", t => {
  const f = fixture(t);
  const journalFile = anchor.journalFileFor(f.anchorDir);
  const own = anchor.readJournal(journalFile).entries.find(entry => entry.sequence === 2 && entry.type === "commit");
  const name = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000002-") && name.includes("-commit-"));
  fs.unlinkSync(path.join(f.anchorDir, name));
  anchor.appendEntry(journalFile, { ...own, store_id: "f".repeat(32), attempt: own.attempt + 1 });
  assert.equal(Store.rebuildAnchor(f.file, f.options).rebuilt, true);
  const final = anchor.readJournal(journalFile);
  assert.equal(final.committedBySeq.get(2).store_id, f.first.store_id);
  const reopened = Store.open(f.file, f.options);
  reopened.close();
});

for (const replace of [false, true]) {
  test(`R4(c) foreign intent cannot authorize crash recovery (replaces own=${replace})`, t => {
    const f = fixture(t, true);
    const journalFile = anchor.journalFileFor(f.anchorDir);
    const intent = anchor.readJournal(journalFile).intentsBySeq.get(2);
    if (replace) {
      const name = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000002-") && name.includes("-intent-"));
      fs.unlinkSync(path.join(f.anchorDir, name));
    }
    anchor.appendEntry(journalFile, { ...intent, store_id: "f".repeat(32), attempt: intent.attempt + (replace ? 0 : 1) });
    const before = entries(f);
    assert.throws(() => Store.recoverFromAnchorCrash(f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
    assert.deepEqual(entries(f), before);
    assert.equal(anchor.readJournal(journalFile).entries.some(entry => entry.sequence === 2 && entry.type === "commit"), false);
  });
}

test("R4(c) successful crash recovery publishes only the database store identity and reopens", t => {
  const f = fixture(t, true);
  assert.equal(Store.recoverFromAnchorCrash(f.file, f.options).recovered, true);
  const final = anchor.readJournal(anchor.journalFileFor(f.anchorDir));
  assert.equal(final.committedBySeq.get(2).store_id, f.first.store_id);
  const reopened = Store.open(f.file, f.options);
  reopened.close();
});

for (const method of ["recoverFromAnchorCrash", "rebuildAnchor"]) {
  test(`R4 postcondition: ${method} cannot report success when commit publication leaves no witness`, t => {
    const f = fixture(t, method === "recoverFromAnchorCrash");
    if (method === "rebuildAnchor") {
      const name = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000002-") && name.includes("-commit-"));
      fs.unlinkSync(path.join(f.anchorDir, name));
    }
    const append = anchor.appendEntry;
    anchor.appendEntry = function(file, entry, ...args) {
      if (entry.type === "commit" && entry.sequence === 2) return;
      return append.call(this, file, entry, ...args);
    };
    try { assert.throws(() => Store[method](f.file, f.options), { code: "ERR_RECOVERY_NOT_APPLICABLE" }); }
    finally { anchor.appendEntry = append; }
    const audit = fs.readFileSync(path.join(f.anchorDir, "protected-anchor-recovery.log"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    assert.ok(audit.every(record => record.refused === true));
  });
}

test("R4 rebuild fails closed when quarantine leaves a foreign commit behind", t => {
  const f = fixture(t);
  anchor.appendEntry(anchor.journalFileFor(f.anchorDir), {
    ...f.first, type: "commit", store_id: "f".repeat(32), attempt: f.first.attempt + 1,
  });
  const before = entries(f);
  const quarantine = anchor.quarantineForeignEntries;
  anchor.quarantineForeignEntries = () => 0;
  try { assert.throws(() => Store.rebuildAnchor(f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" }); }
  finally { anchor.quarantineForeignEntries = quarantine; }
  assert.deepEqual(entries(f), before);
});

for (const method of ["recoverFromAnchorCrash", "rebuildAnchor"]) {
  test(`R4 ${method} rechecks the entire final namespace after publication`, t => {
    const f = fixture(t, method === "recoverFromAnchorCrash");
    if (method === "rebuildAnchor") {
      const name = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000002-") && name.includes("-commit-"));
      fs.unlinkSync(path.join(f.anchorDir, name));
    }
    const append = anchor.appendEntry;
    anchor.appendEntry = function(file, entry, ...args) {
      const result = append.call(this, file, entry, ...args);
      if (entry.type === "commit" && entry.sequence === 2) {
        writeEntry(f, f.first, "abort", f.first.attempt, "late-conflict");
      }
      return result;
    };
    try { assert.throws(() => Store[method](f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" }); }
    finally { anchor.appendEntry = append; }
  });
}

test("R4 rebuild cannot isolate a foreign commit without the independent own declaration slot", t => {
  const f = fixture(t);
  const beforeNames = new Set(fs.readdirSync(f.anchorDir));
  anchor.appendEntry(anchor.journalFileFor(f.anchorDir), {
    ...f.first, type: "commit", sequence: 3, store_id: "f".repeat(32), attempt: 2,
  });
  assert.equal(fs.readdirSync(f.anchorDir).length, beforeNames.size + 1);
  const before = entries(f);
  assert.throws(() => Store.rebuildAnchor(f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
  assert.deepEqual(entries(f), before);
  assert.equal(fs.existsSync(path.join(f.anchorDir, "quarantine")), false);
});

for (const method of ["recoverFromAnchorCrash", "rebuildAnchor"]) {
  test(`R4(a) ${method} blocks a relabelled digest conflict even with a canonical foreign name`, t => {
    const f = fixture(t, method === "recoverFromAnchorCrash");
    anchor.appendEntry(anchor.journalFileFor(f.anchorDir), {
      ...f.first, type: "commit", store_id: "f".repeat(32), body_digest: "a".repeat(64),
    });
    const before = entries(f);
    assert.throws(() => Store[method](f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
    assert.deepEqual(entries(f), before);
    assert.equal(fs.existsSync(path.join(f.anchorDir, "quarantine")), false);
  });
}

test("R4 canonical foreign filename alone does not authorize isolation without the own witness pathname", t => {
  const f = fixture(t);
  const ownName = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000001-") && name.includes("-intent-"));
  fs.renameSync(path.join(f.anchorDir, ownName), path.join(f.anchorDir, ownName.replace(/-[a-f0-9]{16}\.json$/, "-unbound.json")));
  anchor.appendEntry(anchor.journalFileFor(f.anchorDir), {
    ...f.first, type: "commit", store_id: "f".repeat(32), attempt: f.first.attempt + 1,
  });
  const before = entries(f);
  assert.throws(() => Store.rebuildAnchor(f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
  assert.deepEqual(entries(f), before);
  assert.equal(fs.existsSync(path.join(f.anchorDir, "quarantine")), false);
});

for (const method of ["recoverFromAnchorCrash", "rebuildAnchor"]) {
  test(`F4: ${method} refuses a canonical intent pathname containing another sequence's commit`, t => {
    const f = fixture(t);
    const ownIntent = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000001-") && name.includes("-intent-"));
    const otherCommit = fs.readdirSync(f.anchorDir).find(name => name.includes("000000000002-") && name.includes("-commit-"));
    const water = path.join(f.anchorDir, anchor.HIGH_WATER_FILE);
    const waterBefore = fs.readFileSync(water);
    fs.renameSync(path.join(f.anchorDir, ownIntent), path.join(f.anchorDir, ownIntent.replace(/-[a-f0-9]{16}\.json$/, "-noncanonical.json")));
    fs.renameSync(path.join(f.anchorDir, otherCommit), path.join(f.anchorDir, ownIntent));
    anchor.appendEntry(anchor.journalFileFor(f.anchorDir), {
      ...f.first, type: "commit", store_id: "f".repeat(32), attempt: f.first.attempt + 1,
    });
    const before = entries(f);
    assert.throws(() => Store[method](f.file, f.options), { code: "ERR_ANCHOR_CORRUPT" });
    assert.deepEqual(entries(f), before);
    assert.deepEqual(fs.readFileSync(water), waterBefore);
    assert.equal(fs.existsSync(path.join(f.anchorDir, "quarantine")), false);
    const audit = fs.readFileSync(path.join(f.anchorDir, "protected-anchor-recovery.log"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    assert.ok(audit.every(record => record.refused === true));
  });
}
