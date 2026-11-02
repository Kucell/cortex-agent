"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

// Disposable local SQLite/FS only. A simulated throw before close deliberately
// leaves an open resource: production must neither retry its numeric fd nor
// claim it was released. The fixture cleans up its own retained fd afterward.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const delivery = require("../../lib/coordination/permit-delivery");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || !["darwin", "linux"].includes(process.platform) };
const posix = process.platform !== "win32";

function fixture(t, existing = false, onAuthorize = null) {
  const runtime = testRuntime("test-tmp"); fs.mkdirSync(runtime, { recursive: true });
  const dir = fs.mkdtempSync(path.join(runtime, "permit-history-close-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir, { mode: 0o700 });
  const file = path.join(dbDir, "state.sqlite"), log = path.join(anchorDir, "protected-anchor-audit.log");
  let query;
  const options = { decisionId: "D-history-close", anchorDir, anchorMode: "permissive", clock: () => 1000,
    witnessAuthority: { mode: "development-only", authorityId: "history-close", authorize: () => false,
      observeTarget: () => { throw Error("must not observe"); }, signPermit: () => { throw Error("must not sign"); },
      pullRevocation: () => { throw Error("must not pull"); },
      authorizeHistory: () => {
        if (onAuthorize) onAuthorize();
        return { principal: "fixture-reader", resources: query };
      } } };
  const store = Store.initialize(file, options); t.after(() => store.close());
  const publicKey = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" });
  const fingerprint = delivery.publicKeyFingerprint(publicKey), state = store.snapshot();
  query = { operation: "register", decisionId: "D-history-close", authorityId: "history-close", issuerStoreId: state.store_id,
    targetGeneration: null, resources: { fingerprint, lease: null, permit: null },
    request: { targetId: "target", requestId: "registration", checkpoint: null,
      pin: { decision_id: "D-history-close", instance_id: "target", fingerprint, public_key_pem: publicKey,
        source_digest: "synthetic", deployment_digest: "synthetic", run_id: "run", generation: "generation",
        valid_from: 0, valid_until: 10000 } } };
  const prefix = existing ? '{"schema_version":1,"event":"legacy-fixture"}\n' : "";
  if (existing) fs.writeFileSync(log, prefix, { mode: 0o600 });
  return { dir, anchorDir, file, log, store, query, prefix,
    lookup: () => store.queryWitnessHistory({}, query) };
}
function raw(f) {
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(f.file, { readOnly: true });
  try { return db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get(); }
  finally { db.close(); }
}
function probe(f, { kind, timing, syncError = false, reuse = false } = {}) {
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync };
  const tokens = [], current = new Map(), events = [];
  const primary = Object.assign(Error("fixture " + kind + " sync"), { code: "EIO" });
  const closeError = Object.assign(Error("fixture " + kind + " close " + timing), { code: "EIO" });
  let injected = false, victim;
  fs.openSync = function(file, ...args) {
    const fd = original.openSync(file, ...args);
    if (new Error().stack.includes("#writeHistoryAudit")) {
      const type = String(file) === f.log ? "file" : String(file) === f.anchorDir ? "directory" : null;
      if (type) { const token = { fd, kind: type, closes: 0, released: false }; tokens.push(token); current.set(fd, token); events.push(type + ":open"); }
    }
    return fd;
  };
  fs.fsyncSync = function(fd) {
    const token = current.get(fd);
    if (token && new Error().stack.includes("#writeHistoryAudit")) {
      events.push(token.kind + ":sync");
      if (token.kind === kind && syncError) throw primary;
    }
    return original.fsyncSync(fd);
  };
  fs.closeSync = function(fd) {
    const token = current.get(fd);
    if (!token || !new Error().stack.includes("#writeHistoryAudit")) return original.closeSync(fd);
    token.closes++; events.push(token.kind + ":close");
    if (!injected && token.kind === kind) {
      injected = true;
      if (timing === "before") throw closeError;
      original.closeSync(fd); token.released = true;
      if (reuse) {
        // Exercise the real fd reuse hazard: an unrelated resource now owns
        // this integer. A second close by the store would close that resource.
        victim = original.openSync(path.join(f.dir, "reused-fd"), "wx", 0o600);
        assert.equal(victim, fd, "controlled POSIX allocation must reuse the released descriptor");
      }
      throw closeError;
    }
    original.closeSync(fd); token.released = true;
  };
  return { tokens, events, primary, closeError, injected: () => injected, victim: () => victim,
    restore: () => Object.assign(fs, original),
    cleanup: () => {
      for (const token of tokens) {
        if (!token.released) { original.closeSync(token.fd); token.released = true; }
      }
      if (victim !== undefined) {
        try { original.closeSync(victim); }
        // An unsafe implementation may already have closed the victim. Do
        // not mask the assertion that explains that failure with test cleanup.
        catch (error) { if (error.code !== "EBADF") throw error; }
        finally { victim = undefined; }
      }
    } };
}

for (const kind of ["file", "directory"]) {
  for (const timing of ["before", "after"]) {
    for (const syncError of [false, true]) {
      test(`${kind} close throws ${timing} real close${syncError ? " after primary sync failure" : ""}: one attempt, no observation`, supported, t => {
        const f = fixture(t), before = raw(f), io = probe(f, { kind, timing, syncError }); let error, result;
        try { result = f.lookup(); } catch (e) { error = e; } finally { io.restore(); }
        try {
          assert.equal(io.injected(), true); assert.equal(result, undefined);
          assert.equal(error.code, "ERR_AUDIT_WRITE_FAILED");
          assert.equal(error.cause, syncError ? io.primary : io.closeError);
          if (syncError) assert.equal(error.cleanupError, io.closeError);
          else assert.equal(error.cleanupError, undefined);
          for (const token of io.tokens) assert.equal(token.closes, 1, token.kind + " must close only once");
          const affected = io.tokens.find(token => token.kind === kind);
          if (timing === "before") assert.ok(fs.fstatSync(affected.fd), "fixture proves resource remains open, not production cleanup");
          assert.deepEqual(raw(f), before);
          assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
          assert.throws(() => f.lookup(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
          if (kind === "file") assert.ok(!io.events.includes("directory:open"));
          t.diagnostic(JSON.stringify({ kind, timing, syncError, closes: io.tokens.map(token => ({ kind: token.kind, attempts: token.closes })),
            resourceReleaseConfirmed: timing === "after", observationDelivered: false }));
        } finally { io.cleanup(); }
      });
    }
  }
}

for (const kind of ["file", "directory"]) {
  test(`${kind} released fd reused by another file is never closed again`, supported, t => {
    const f = fixture(t), io = probe(f, { kind, timing: "after", reuse: true }); let error;
    try { f.lookup(); } catch (e) { error = e; } finally { io.restore(); }
    try {
      assert.equal(error.code, "ERR_AUDIT_WRITE_FAILED"); assert.equal(error.cause, io.closeError);
      assert.equal(io.tokens.find(token => token.kind === kind).closes, 1);
      assert.ok(fs.fstatSync(io.victim()).isFile(), "unrelated resource still owns reused integer");
      assert.throws(() => f.lookup(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
    } finally { io.cleanup(); }
  });
}

for (const existing of [false, true]) {
  test(`successful history audit retains line format and both barriers (${existing ? "existing" : "first creation"})`, supported, t => {
    const f = fixture(t, existing), before = raw(f), io = probe(f); let result;
    try { result = f.lookup(); } finally { io.restore(); io.cleanup(); }
    assert.equal(result.status, "not-found-at-boundary"); assert.equal(result.originalRequestOutcome, "unknown");
    assert.equal(result.executionAuthorized, false); assert.equal(result.resumeAllowed, false);
    assert.deepEqual(io.events, ["file:open", "file:sync", "file:close", "directory:open", "directory:sync", "directory:close"]);
    for (const token of io.tokens) assert.equal(token.closes, 1);
    const bytes = fs.readFileSync(f.log, "utf8"); assert.ok(bytes.startsWith(f.prefix)); assert.ok(bytes.endsWith("\n"));
    const record = JSON.parse(bytes.slice(f.prefix.length));
    assert.deepEqual(Object.keys(record).sort(), ["schema_version", "at", "store_id", "event", "operation", "query_digest",
      "query_principal_digest", "status", "boundary", "executionAuthorized", "resumeAllowed"].sort());
    assert.equal(record.schema_version, 1); assert.equal(record.event, "witness-history-observation");
    assert.equal(record.executionAuthorized, false); assert.equal(record.resumeAllowed, false);
    assert.deepEqual(raw(f), before); assert.equal(f.store.snapshot().anchor_sequence, result.boundary.anchorSequence);
  });
}

// The history audit and the transaction audit must agree about platforms that
// cannot provide a durable directory barrier. The transaction audit refuses
// before writing; the history audit used to write the file, fail the
// directory fsync, and only then report the failure — so a real Windows host
// read protected history and left no durable audit of it.
//
// This is a simulated-platform test on a POSIX host: it proves the refusal
// happens before any byte is written, not that Windows behaves this way.
test("simulated Windows history audit refuses before writing; not a native Windows test", { skip: !supported || !posix }, t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let error, result, authorizations = 0;
  // The history audit is reached after the third re-authorization: the first
  // authorizes the read, the second runs inside the coordination lock, and
  // the third runs immediately before the audit. Switching the platform
  // there keeps the lock's own Windows permission adapter out of the way, so
  // the assertion is about the audit barrier alone.
  const f = fixture(t, false, () => {
    authorizations++;
    if (authorizations === 3) {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    }
  });
  const before = raw(f);
  try { result = f.lookup(); } catch (e) { error = e; }
  finally {
    Object.defineProperty(process, "platform", platform);
  }
  assert.equal(result, undefined);
  assert.equal(authorizations, 3);
  assert.equal(error.code, "ERR_AUDIT_WRITE_FAILED");
  assert.equal(error.cause.code, "ERR_AUDIT_DURABILITY_UNSUPPORTED");
  // The refusal happens before the audit file is created or opened.
  assert.equal(fs.existsSync(f.log), false);
  assert.deepEqual(raw(f), before);
  // The handle is poisoned, so a second lookup cannot retry the observation.
  assert.throws(() => f.lookup(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});
