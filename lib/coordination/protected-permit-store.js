"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PROTECTED_SCOPE, PROTECTED_LEASE_PREFIX } = require("./protected-scope");
const anchor = require("./protected-anchor");

const SCHEMA_VERSION = 1;

class ProtectedStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProtectedStoreError";
    this.code = code;
  }
}

function fail(code) { throw new ProtectedStoreError(code); }
function requireText(value) {
  if (typeof value !== "string" || !value) fail("ERR_INVALID_INPUT");
  return value;
}
function requireDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail("ERR_INVALID_INPUT");
  return value.toLowerCase();
}
function requirePositiveMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("ERR_INVALID_INPUT");
  return value;
}
function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function sqliteRuntime() {
  if (Number(process.versions.node.split(".")[0]) < 24) fail("ERR_RUNTIME_UNSUPPORTED");
  try { return require("node:sqlite").DatabaseSync; }
  catch { return fail("ERR_RUNTIME_UNSUPPORTED"); }
}
function checkFile(filePath) {
  const parent = path.dirname(path.resolve(filePath));
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
}
function initialState(now, decisionId, storeId, anchorMode, serviceIdentity) {
  return {
    schema_version: SCHEMA_VERSION, scope: PROTECTED_SCOPE, decision_id: decisionId,
    service_epoch: 1, fencing: 0, lease_seq: 0, permit_seq: 0,
    last_clock_ms: now, lease: null, lease_idempotency: {}, permits: {}, idempotency: {},
    desktop: { status: "free", key: null }, tombstones: {},
    anchor_sequence: 1,
    store_id: storeId || null,
    // The permission mode of the anchor domain is a property of the
    // deployment, not of the caller. It is stored with the state so that the
    // managed recovery entry points, which are invoked long after the store
    // was opened and by a different process, apply the same contract
    // instead of the one their own caller happened to pass.
    anchor_mode: anchorMode || anchor.ANCHOR_MODE.strict,
    // The identity the deployment promises the service runs as. It is part
    // of the committed state, so the managed recovery entry points -- which
    // run long after the store was opened and from a different process --
    // apply the same contract instead of the one their own caller happened
    // to pass. A null value means "not declared", which is only acceptable
    // on the platforms where the calling process identity is the service
    // identity by construction.
    service_identity: serviceIdentity === undefined ? null : serviceIdentity,
  };
}
function assertState(state) {
  if (!state || state.schema_version !== SCHEMA_VERSION || state.scope !== PROTECTED_SCOPE ||
      typeof state.decision_id !== "string" || !state.decision_id ||
      !Number.isSafeInteger(state.service_epoch) || state.service_epoch < 1 ||
      !Number.isSafeInteger(state.fencing) || state.fencing < 0 ||
      !Number.isSafeInteger(state.lease_seq) || state.lease_seq < 0 ||
      !Number.isSafeInteger(state.permit_seq) || state.permit_seq < 0 ||
      !Number.isSafeInteger(state.last_clock_ms) || state.last_clock_ms < 0 ||
      !state.lease_idempotency || Array.isArray(state.lease_idempotency) || typeof state.lease_idempotency !== "object" ||
      !state.permits || Array.isArray(state.permits) || typeof state.permits !== "object" ||
      !state.idempotency || Array.isArray(state.idempotency) || typeof state.idempotency !== "object" ||
      !state.desktop || !["free", "held", "draining"].includes(state.desktop.status) ||
      !(state.desktop.key === null || typeof state.desktop.key === "string") ||
      !Number.isSafeInteger(state.anchor_sequence) || state.anchor_sequence < 0 ||
      (state.store_id !== null && (typeof state.store_id !== "string" || !state.store_id)) ||
      !state.tombstones || Array.isArray(state.tombstones) || typeof state.tombstones !== "object") fail("ERR_STATE_INVALID");
  // The permission mode is part of the committed state, so it has to be a
  // known mode. An unknown value would otherwise be treated as a weaker one
  // by the callers that read it.
  if (!Object.prototype.hasOwnProperty.call(anchor.ANCHOR_MODE_STRENGTH, state.anchor_mode)) {
    fail("ERR_ANCHOR_MODE_INVALID");
  }
  // The declared service identity is part of the committed state, so a
  // tampered or unknown value has to be refused rather than ignored.
  if (state.service_identity !== null && state.service_identity !== undefined &&
      typeof state.service_identity !== "string") {
    fail("ERR_STATE_INVALID");
  }
  if (state.lease !== null && (!state.lease || typeof state.lease !== "object" ||
      typeof state.lease.leaseId !== "string" || !state.lease.leaseId.startsWith(PROTECTED_LEASE_PREFIX) ||
      !["active", "released", "revoked", "expired"].includes(state.lease.status) ||
      !Number.isSafeInteger(state.lease.serviceEpoch) || !Number.isSafeInteger(state.lease.fencing))) fail("ERR_STATE_INVALID");
  for (const permit of Object.values(state.permits)) {
    if (!permit || typeof permit !== "object" || typeof permit.permitId !== "string" ||
        !["reserved", "consumed", "finished", "failed", "unknown", "revoked", "expired"].includes(permit.status) ||
        !Number.isSafeInteger(permit.sequence) || !Number.isSafeInteger(permit.deadline) ||
        !Number.isSafeInteger(permit.serviceEpoch) || !Number.isSafeInteger(permit.fencing)) fail("ERR_STATE_INVALID");
  }
}
function matches(record, fields, names) {
  return names.every((name) => record[name] === fields[name]);
}

// The identity of a dispatched action. Two permits that agree on all four
// fields address the same action on the same desktop, no matter which
// idempotency key they were minted under. The idempotency key identifies one
// *attempt*; the action fingerprint identifies the *work*. A retried attempt
// must read back the original record, and a fresh attempt at an already
// dispatched action must be refused -- otherwise the same operation runs
// twice on one desktop.
function actionFingerprint(permit) {
  return [permit.desktopKey, permit.operation, permit.targetDigest, permit.paramsDigest].join("|");
}

// The permits that still hold the desktop for an action: one that has been
// minted but not yet consumed, and one that is being executed right now.
function isLivePermit(permit) {
  return permit.status === "reserved" || permit.status === "consumed";
}

// The permits that prove the action was already dispatched on this desktop:
// the action either reached the executor or it was explicitly closed out.
// A permit that was revoked or expired before it was ever consumed did not
// dispatch anything, so it does not block a later attempt of the same action.
function isDispatchedPermit(permit) {
  return isLivePermit(permit) || permit.status === "finished" || permit.status === "failed" ||
    permit.status === "unknown";
}
function activeLease(state, fields, now) {
  const lease = state.lease;
  if (!lease || lease.status !== "active" || lease.expiresAt <= now ||
      lease.fencing !== state.fencing || lease.serviceEpoch !== state.service_epoch ||
      !matches(lease, fields, ["leaseId", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"])) {
    fail("ERR_LEASE_NOT_CURRENT");
  }
  if (state.desktop.status !== "held" || state.desktop.key !== lease.desktopKey) fail("ERR_DESKTOP_DRAINING");
  return lease;
}

class ProtectedPermitStore {
  #db;
  #clock;
  #verifyRecovery;
  #anchorFile;
  #anchorDir;
  #storeId;
  #closed = false;
  #poisoned = false;

  constructor(db, options = {}) {
    // A store without an anchor would silently skip the rollback detection,
    // so the anchor is required at construction as well. The public entry
    // points are initialize() and open(); both of them bind the anchor, and
    // this check makes sure that no other construction path can produce a
    // store that runs without one.
    if (!options.anchorFile || !options.anchorDir || !options.storeId) fail("ERR_ANCHOR_REQUIRED");
    this.#db = db;
    this.#clock = options.clock || Date.now;
    this.#verifyRecovery = options.verifyRecovery || null;
    this.#anchorFile = options.anchorFile || null;
    this.#anchorDir = options.anchorDir || null;
    this.#storeId = options.storeId || null;
  }

  static initialize(filePath, options = {}) {
    requireText(options.decisionId);
    // The anchor is mandatory: without it the store cannot detect a
    // same-epoch rollback, which would make VC-044-007 fail open.
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    let anchorDir = null;
    let journalFile = null;
    if (options.anchorDir) {
      anchorDir = anchor.anchorDirFor(options.anchorDir);
      anchor.assertSeparateDomains(options.anchorDir, filePath);
      journalFile = anchor.journalFileFor(anchorDir);
    }
    // The anchor domain is checked before anything is written into it, so a
    // store that records the strict contract cannot be created in a domain
    // that does not satisfy it. Otherwise the store would come up, record a
    // mode it does not honour, and refuse its own first open.
    anchor.assertAnchorPermissionsWithIdentity(anchorDir,
      anchor.assertKnownAnchorMode(options.anchorMode), options.serviceIdentity, options);
    const DatabaseSync = sqliteRuntime();
    const resolved = path.resolve(filePath);
    const parent = path.dirname(resolved);
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(parent).length !== 0) fail("ERR_INIT_PATH_NOT_EMPTY");
    const now = (options.clock || Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) fail("ERR_CLOCK_INVALID");
    const db = new DatabaseSync(resolved, { timeout: 5000 });
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      db.exec("CREATE TABLE protected_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, sha256 TEXT NOT NULL)");
      // The store identity binds the journal to this database instance. It is
      // written into the database body so that a journal copied from another
      // instance is rejected on open, instead of being silently adopted.
      const storeId = crypto.randomBytes(16).toString("hex");
      const body = JSON.stringify(initialState(now, options.decisionId, storeId, options.anchorMode, options.serviceIdentity));
      db.prepare("INSERT INTO protected_state (id, body, sha256) VALUES (1, ?, ?)").run(body, digest(body));
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      if (journalFile) {
        anchor.appendEntry(journalFile, { type: "intent", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
        anchor.appendEntry(journalFile, { type: "commit", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
        anchor.appendHighWater(anchorDir, { sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      }
      return new ProtectedPermitStore(db, { ...options, anchorFile: journalFile, anchorDir, storeId });
    } catch (error) { db.close(); throw error; }
  }

  static open(filePath, options = {}) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!Number.isSafeInteger(options.minimumEpoch) || options.minimumEpoch < 1) fail("ERR_INVALID_INPUT");
    // The anchor is mandatory and there is no opt-out. An earlier design had
    // an allowNoAnchor escape hatch whose validity depended on a flag inside
    // the database body; because the database is exactly what an attacker who
    // can replace it controls, that flag could be rewritten to disable the
    // rollback detection. The escape hatch was therefore removed: the
    // presence of the anchor is decided by the anchor directory, not by the
    // database.
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    let anchorDir = null;
    let journalFile = null;
    try {
      anchorDir = anchor.anchorDirFor(options.anchorDir);
      anchor.assertSeparateDomains(options.anchorDir, filePath);
      journalFile = anchor.journalFileFor(anchorDir);
    }
    catch (error) { fail(error.code || "ERR_STATE_MISSING_OR_UNSAFE"); }
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
          db.prepare("PRAGMA user_version").get().user_version !== SCHEMA_VERSION) fail("ERR_STATE_INVALID");
      // The store identity is bound to the journal on first use and inherited
      // from it on every later open, so entries written by any process share
      // the same identity and a journal from another instance is not adopted.
      let storeId = null;
      const journal = anchor.readJournal(journalFile);
      if (journal.entries.length === 0) fail("ERR_ANCHOR_MISSING");
      if (journal.storeIds.size !== 1) fail("ERR_ANCHOR_CORRUPT");
      storeId = [...journal.storeIds][0];
      const store = new ProtectedPermitStore(db, { ...options, anchorFile: journalFile, anchorDir, storeId });
      const raw = store.#readRaw();
      const snapshot = raw.state;
      if (snapshot.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      if (snapshot.service_epoch < options.minimumEpoch) fail("ERR_EPOCH_ROLLBACK");
      // The recorded permission mode is the contract the store was created
      // under. A caller may not weaken it for a single open: the store was
      // initialised with a mode, and a mode that is weaker than the recorded
      // one would let this open pass while the recorded contract still
      // applies to every other process.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(snapshot.anchor_mode, options.anchorMode),
        snapshot.service_identity, options);
      // The database carries the store identity it was created with. A
      // journal that belongs to a different instance must not be adopted, so
      // the two identities have to agree.
      if (snapshot.store_id !== storeId) fail("ERR_ANCHOR_STORE_MISMATCH");
      // The high-water declaration is the second witness of the mark. It
      // survives the deletion of journal entries, so an attacker who can only
      // write the database cannot lower the mark, and one who deleted journal
      // entries cannot lower it either.
      const declared = anchor.readHighWater(anchorDir);
      if (declared.mark > 0) {
        if (snapshot.anchor_sequence < declared.mark) fail("ERR_STATE_ROLLED_BACK");
        if (snapshot.anchor_sequence === declared.mark && declared.digest !== digest(raw.body)) {
          fail("ERR_STATE_TAMPERED");
        }
      }
      if (journalFile) store.#verifyAnchor(journalFile, snapshot, raw.body);
      const now = (options.clock || Date.now)();
      if (!Number.isSafeInteger(now) || now < snapshot.last_clock_ms) fail("ERR_CLOCK_ROLLBACK");
      return store;
    } catch (error) { db.close(); throw error; }
  }

  #read() {
    return this.#readRaw().state;
  }

  // The raw body string matters: the anchor binds the exact bytes that were
  // committed, so the comparison must not re-serialize a parsed snapshot.
  #readRaw() {
    if (this.#closed) fail("ERR_STORE_CLOSED");
    if (this.#poisoned) fail("ERR_COMMIT_OUTCOME_UNKNOWN");
    let row;
    try { row = this.#db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get(); }
    catch { fail("ERR_STATE_INVALID"); }
    if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
    let state;
    try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
    assertState(state);
    return { state, body: row.body };
  }

  snapshot() { return structuredClone(this.#read()); }

  // The anchor records the high-water mark outside the database rollback
  // domain. A database whose recorded sequence is behind the anchor was
  // replaced by an older snapshot, so the service must refuse to start.
  #verifyAnchor(journalFile, snapshot, rawBody) {
    let journal;
    try { journal = anchor.readJournal(journalFile); }
    catch (error) { fail(error.code || "ERR_ANCHOR_UNREADABLE"); }
    if (journal.committed === 0) fail("ERR_ANCHOR_MISSING");
    const bodyDigest = digest(rawBody);
    // The database is older than the committed high-water mark: the database
    // was rolled back. This is never recoverable.
    if (snapshot.anchor_sequence < journal.committed) fail("ERR_STATE_ROLLED_BACK");
    if (snapshot.anchor_sequence > journal.committed) {
      // The database is ahead of the journal: the crash happened between the
      // database commit and the journal commit entry. This is recoverable
      // only when the dangling intent proves the sequence, because the intent
      // carries the digest the database must now have.
      const intent = journal.intentsBySeq.get(snapshot.anchor_sequence);
      if (!intent || intent.body_digest !== bodyDigest) fail("ERR_STATE_AHEAD_OF_ANCHOR");
      fail("ERR_CRASH_WINDOW_RECOVERABLE");
    }
    // The database matches the high-water mark: the journal's body digest at
    // that sequence must equal the digest of the committed database body.
    // This stops an attacker who only edits the database from forging a
    // matching anchor_sequence and recomputing the body checksum.
    const committed = journal.committedBySeq.get(journal.committed);
    if (!committed || committed.body_digest !== bodyDigest) fail("ERR_STATE_TAMPERED");
  }

  #transaction(change) {
    if (this.#closed) fail("ERR_STORE_CLOSED");
    if (this.#poisoned) fail("ERR_COMMIT_OUTCOME_UNKNOWN");
    this.#db.exec("BEGIN IMMEDIATE");
    let commitAttempted = false;
    let sequence = null;
    let bodyDigest = null;
    let attempt = null;
    try {
      const raw = this.#readRaw();
      const state = raw.state;
      // An already-open store must re-check the journal before it advances
      // it. Otherwise a deleted or rolled-back journal would let the next
      // transaction silently lower the high-water mark.
      // The journal is read once here and reused: it decides the attempt
      // counter for this transaction and avoids a second full directory scan
      // for every entry that is appended.
      let journal = null;
      if (this.#anchorFile) journal = this.#assertJournalStillValid(raw.state, raw.body);
      const now = this.#clock();
      if (!Number.isSafeInteger(now) || now < state.last_clock_ms) fail("ERR_CLOCK_ROLLBACK");
      const result = change(state, now);
      state.last_clock_ms = now;
      state.anchor_sequence += 1;
      assertState(state);
      const body = JSON.stringify(state);
      sequence = state.anchor_sequence;
      bodyDigest = digest(body);
      if (this.#anchorFile) {
        attempt = anchor.nextAttemptFor(journal, sequence);
        // Intent first: it records the digest the database is about to have,
        // so a crash between the database commit and the journal commit entry
        // is provable and not confusable with a rollback.
        anchor.appendEntry(this.#anchorFile, { type: "intent", sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt });
      }
      // The audit record is written before the database commits. Writing it
      // afterwards would leave a committed state without any trace of how it
      // was reached if the process died in between.
      this.#writeAudit({ event: "transaction", sequence, body_digest: bodyDigest });
      this.#db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, bodyDigest);
      commitAttempted = true;
      this.#db.exec("COMMIT");
      if (this.#anchorFile) {
        anchor.appendEntry(this.#anchorFile, { type: "commit", sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt });
        anchor.appendHighWater(this.#anchorDir, { sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt });
      }
      return result;
    } catch (error) {
      if (commitAttempted) this.#poisoned = true;
      try { this.#db.exec("ROLLBACK"); } catch { this.#poisoned = true; }
      // The database transaction did not commit, so the intent is abandoned.
      // Recording the abort keeps the journal explicit about the sequence
      // never having been committed, and keeps the sequence number reusable.
      if (!commitAttempted && this.#anchorFile && sequence !== null) {
        try { anchor.appendEntry(this.#anchorFile, { type: "abort", sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt }); }
        catch { this.#poisoned = true; }
      }
      throw error;
    }
  }

  // The audit trail lives next to the anchor, outside the database rollback
  // domain, so restoring an old database cannot erase it.
  #writeAudit(record) {
    if (!this.#anchorDir) return;
    const entry = {
      schema_version: 1,
      at: new Date().toISOString(),
      store_id: this.#storeId,
      ...record,
    };
    try {
      fs.appendFileSync(path.join(this.#anchorDir, "protected-anchor-audit.log"),
        JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch {
      // The audit is mandatory: a transaction that cannot be recorded must
      // not commit.
      fail("ERR_AUDIT_WRITE_FAILED");
    }
  }

  // Re-check the journal against the committed database body before a
  // transaction advances it. A missing or inconsistent journal is a
  // fail-closed condition, never a reason to recreate the high-water mark.
  #assertJournalStillValid(state, rawBody) {
    let journal;
    try { journal = anchor.readJournal(this.#anchorFile); }
    catch (error) { fail(error.code || "ERR_ANCHOR_UNREADABLE"); }
    if (journal.committed === 0) fail("ERR_ANCHOR_MISSING");
    if (state.anchor_sequence < journal.committed) fail("ERR_STATE_ROLLED_BACK");
    // The database is ahead of the journal only in the crash window between
    // the database commit and the journal commit entry, or while another
    // process holds the database write lock and has written its intent but
    // not yet its commit entry. Either way a dangling intent at the database
    // sequence must exist; otherwise the journal does not explain the
    // database and the state is refused.
    if (state.anchor_sequence > journal.committed) {
      const intent = journal.intentsBySeq.get(state.anchor_sequence);
      // The intent must prove the database: its digest has to equal the
      // committed body digest. Without this comparison a database that was
      // edited to carry a higher anchor_sequence would be accepted, and the
      // high-water mark would be silently rewritten to that forged value.
      if (!intent || intent.body_digest !== digest(rawBody)) fail("ERR_STATE_AHEAD_OF_ANCHOR");
      return journal;
    }
    const committed = journal.committedBySeq.get(journal.committed);
    if (!committed) fail("ERR_ANCHOR_CORRUPT");
    if (state.anchor_sequence === journal.committed && committed.body_digest !== digest(rawBody)) {
      fail("ERR_STATE_TAMPERED");
    }
    return journal;
  }

  acquire(fields) {
    for (const key of ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "idempotencyKey"]) requireText(fields[key]);
    const ttlMs = requirePositiveMs(fields.ttlMs);
    return this.#transaction((state, now) => {
      const old = state.lease_idempotency[fields.idempotencyKey];
      if (old) {
        const names = ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "ttlMs"];
        if (!matches(old, { ...fields, ttlMs }, names)) fail("ERR_IDEMPOTENCY_MISMATCH");
        return structuredClone(state.lease && state.lease.leaseId === old.leaseId ? state.lease : old);
      }
      if (state.desktop.status !== "free") fail("ERR_DESKTOP_NOT_FREE");
      state.fencing += 1;
      state.lease_seq += 1;
      const lease = {
        leaseId: `${PROTECTED_LEASE_PREFIX}${state.lease_seq}`, status: "active",
        owner: fields.owner, sessionId: fields.sessionId, hostId: fields.hostId,
        workerId: fields.workerId, runId: fields.runId, generation: fields.generation,
        desktopKey: fields.desktopKey, ownedAppId: fields.ownedAppId,
        idempotencyKey: fields.idempotencyKey,
        serviceEpoch: state.service_epoch, fencing: state.fencing, expiresAt: now + ttlMs, ttlMs,
      };
      state.lease = lease;
      state.lease_idempotency[fields.idempotencyKey] = structuredClone(lease);
      state.desktop = { status: "held", key: fields.desktopKey };
      return structuredClone(lease);
    });
  }

  renew(fields) {
    const ttlMs = requirePositiveMs(fields.ttlMs);
    return this.#transaction((state, now) => {
      const lease = activeLease(state, fields, now);
      lease.expiresAt = now + ttlMs;
      state.lease_idempotency[lease.idempotencyKey] = structuredClone(lease);
      return structuredClone(lease);
    });
  }

  reserve(fields) {
    for (const key of ["idempotencyKey", "operation", "targetDigest", "paramsDigest"]) requireText(fields[key]);
    const targetDigest = requireDigest(fields.targetDigest);
    const paramsDigest = requireDigest(fields.paramsDigest);
    const ttlMs = requirePositiveMs(fields.ttlMs);
    return this.#transaction((state, now) => {
      const binding = {
        leaseId: fields.leaseId, sessionId: fields.sessionId, hostId: fields.hostId,
        workerId: fields.workerId, runId: fields.runId, generation: fields.generation,
        desktopKey: fields.desktopKey, ownedAppId: fields.ownedAppId,
        serviceEpoch: fields.serviceEpoch,
        fencing: fields.fencing, operation: fields.operation, targetDigest, paramsDigest,
      };
      const oldId = state.idempotency[fields.idempotencyKey];
      if (oldId) {
        const old = state.permits[oldId];
        if (!old || !matches(old, binding, Object.keys(binding))) fail("ERR_IDEMPOTENCY_MISMATCH");
        return structuredClone(old);
      }
      const lease = activeLease(state, fields, now);
      // Action-level deduplication. The idempotency key above only covers a
      // retry of the *same* attempt; a fresh key for the same action would
      // otherwise mint a second permit for work that is already running or has
      // already run, and the same operation would be dispatched twice. The
      // guard therefore looks at the action fingerprint, not at the key.
      const fingerprint = actionFingerprint(binding);
      const sameAction = Object.values(state.permits)
        .filter((permit) => permit.desktopKey === fields.desktopKey)
        .filter((permit) => actionFingerprint(permit) === fingerprint);
      // A permit that is already in flight blocks a second one outright.
      if (sameAction.some(isLivePermit)) fail("ERR_ACTION_IN_FLIGHT");
      // An action that already ran must not be dispatched again, not even
      // after it completed successfully.
      if (sameAction.some(isDispatchedPermit)) fail("ERR_ACTION_ALREADY_DISPATCHED");
      // A different action on the same desktop still needs the desktop to be
      // free of work in flight.
      if (Object.values(state.permits).some((permit) => permit.status === "consumed" && permit.desktopKey === fields.desktopKey)) fail("ERR_ACTION_IN_FLIGHT");
      if (binding.serviceEpoch !== state.service_epoch || binding.fencing !== state.fencing) fail("ERR_BINDING_MISMATCH");
      state.permit_seq += 1;
      const permit = {
        ...binding, permitId: `P-PERMIT-${state.permit_seq}`, status: "reserved",
        idempotencyKey: fields.idempotencyKey, sequence: state.permit_seq,
        deadline: Math.min(now + ttlMs, lease.expiresAt),
      };
      state.permits[permit.permitId] = permit;
      state.idempotency[fields.idempotencyKey] = permit.permitId;
      return structuredClone(permit);
    });
  }

  consume(fields) {
    const result = this.#transaction((state, now) => {
      const permit = state.permits[fields.permitId];
      if (!permit) fail("ERR_PERMIT_NOT_FOUND");
      const names = ["leaseId", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "serviceEpoch", "fencing", "operation", "targetDigest", "paramsDigest", "sequence"];
      if (!matches(permit, fields, names)) fail("ERR_BINDING_MISMATCH");
      if (permit.serviceEpoch !== state.service_epoch || ["unknown", "revoked", "expired"].includes(permit.status)) {
        fail("ERR_PERMIT_NOT_CONSUMABLE");
      }
      if (["consumed", "finished", "failed"].includes(permit.status)) {
        return { status: "already-consumed", permitId: permit.permitId };
      }
      if (permit.status !== "reserved") fail("ERR_PERMIT_NOT_CONSUMABLE");
      // A permit that is consumed is the permission to execute the action
      // once. Two permits for the same action must never both reach that
      // state, and an action that has already run must not be run again.
      // The guard therefore covers the whole dispatched set of the action,
      // not just the permits that happen to be consumed at this instant.
      const fingerprint = actionFingerprint(permit);
      const sameAction = Object.values(state.permits)
        .filter((other) => other.desktopKey === permit.desktopKey)
        .filter((other) => other.permitId !== permit.permitId)
        .filter((other) => actionFingerprint(other) === fingerprint);
      if (sameAction.some(isLivePermit)) fail("ERR_ACTION_IN_FLIGHT");
      if (sameAction.some(isDispatchedPermit)) fail("ERR_ACTION_ALREADY_DISPATCHED");
      if (Object.values(state.permits).some((other) => other.status === "consumed" && other.desktopKey === permit.desktopKey)) fail("ERR_ACTION_IN_FLIGHT");
      if (now > permit.deadline) {
        permit.status = "expired";
        state.tombstones[permit.permitId] = { reason: "deadline", at: now };
        return { status: "expired" };
      }
      activeLease(state, fields, now);
      permit.status = "consumed";
      permit.consumedAt = now;
      return structuredClone(permit);
    });
    if (result.status === "expired") fail("ERR_PERMIT_NOT_CONSUMABLE");
    return result;
  }

  finish(fields) {
    if (!["finished", "failed", "unknown"].includes(fields.outcome)) fail("ERR_INVALID_INPUT");
    return this.#transaction((state, now) => {
      const permit = state.permits[fields.permitId];
      const names = ["leaseId", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "serviceEpoch", "fencing", "operation", "targetDigest", "paramsDigest", "sequence"];
      if (!permit || permit.status !== "consumed" ||
          !matches(permit, fields, names)) fail("ERR_PERMIT_NOT_CONSUMED");
      permit.status = fields.outcome;
      permit.finishedAt = now;
      if (fields.outcome !== "finished") state.desktop.status = "draining";
      return structuredClone(permit);
    });
  }

  #revoke(state, status, now) {
    if (!state.lease || state.lease.status !== "active") fail("ERR_LEASE_NOT_CURRENT");
    state.lease.status = status;
    state.lease.endedAt = now;
    state.lease_idempotency[state.lease.idempotencyKey] = structuredClone(state.lease);
    state.fencing += 1;
    for (const permit of Object.values(state.permits)) {
      if (permit.status === "reserved") {
        permit.status = "revoked";
        state.tombstones[permit.permitId] = { reason: status, at: now };
      }
    }
    state.desktop.status = "draining";
    return structuredClone(state.lease);
  }

  revoke(fields) {
    return this.#transaction((state, now) => {
      activeLease(state, fields, now);
      return this.#revoke(state, "revoked", now);
    });
  }

  release(fields) {
    return this.#transaction((state, now) => {
      activeLease(state, fields, now);
      return this.#revoke(state, "released", now);
    });
  }

  expire() {
    return this.#transaction((state, now) => {
      if (!state.lease || state.lease.status !== "active" || state.lease.expiresAt > now) fail("ERR_LEASE_NOT_EXPIRED");
      return this.#revoke(state, "expired", now);
    });
  }

  restartService() {
    return this.#transaction((state, now) => {
      if (state.lease && state.lease.status === "active") this.#revoke(state, "revoked", now);
      for (const permit of Object.values(state.permits)) {
        if (permit.status === "consumed") permit.status = "unknown";
      }
      state.service_epoch += 1;
      return state.service_epoch;
    });
  }

  recover(proof) {
    return this.#transaction((state, now) => {
      if (state.desktop.status !== "draining") fail("ERR_DESKTOP_NOT_DRAINING");
      if (Object.values(state.permits).some((permit) => permit.status === "consumed")) fail("ERR_ACTION_IN_FLIGHT");
      if (!this.#verifyRecovery || !this.#verifyRecovery(proof, structuredClone(state))) fail("ERR_RECOVERY_NOT_VERIFIED");
      if (state.lease && state.lease.status === "active") this.#revoke(state, "revoked", now);
      state.desktop = { status: "free", key: null };
      return { status: "free" };
    });
  }

  close() {
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }

  // Managed recovery for the crash window between the anchor write and the
  // database commit. It is deliberately narrow: the anchor must be exactly
  // one step ahead of the database and its prev_body_digest must match the
  // committed database body. Anything else is treated as a suspected attack
  // and is refused, because silently recovering a rolled-back database would
  // erase the evidence of the rollback.
  //
  // The caller must supply an explicit audit record. The recovery is not
  // reachable from the normal start path; it is an administrator action.
  static recoverFromAnchorCrash(filePath, options = {}) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    const audit = options.audit;
    if (!audit || typeof audit !== "object" || typeof audit.by !== "string" || !audit.by ||
        typeof audit.reason !== "string" || !audit.reason) fail("ERR_RECOVERY_AUDIT_REQUIRED");
    const anchorDir = anchor.anchorDirFor(options.anchorDir);
    anchor.assertSeparateDomains(options.anchorDir, filePath);
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    const journalFile = anchor.journalFileFor(anchorDir);
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get();
      if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
      let state;
      try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
      assertState(state);
      if (state.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      // The permission mode of the anchor domain is a property of the
      // deployment. The caller may state it explicitly, and otherwise the
      // mode that was recorded with the state is used, so that a recovery
      // run by a different process applies the same contract. A caller may
      // not weaken the recorded contract for a single recovery run.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(state.anchor_mode, options.anchorMode),
        state.service_identity, options);
      const journal = anchor.readJournal(journalFile);
      if (journal.committed === 0) fail("ERR_ANCHOR_MISSING");
      // The only recoverable shape is a database that is exactly one sequence
      // ahead of the committed high-water mark, with a dangling intent at
      // that sequence whose digest equals the committed database body. A
      // rolled-back database is behind the high-water mark and can never
      // satisfy this condition, so the recovery entry point cannot launder a
      // rollback.
      if (state.anchor_sequence !== journal.committed + 1) fail("ERR_RECOVERY_NOT_APPLICABLE");
      const intent = journal.intentsBySeq.get(state.anchor_sequence);
      if (!intent || intent.body_digest !== digest(row.body)) fail("ERR_RECOVERY_NOT_APPLICABLE");
      // Record the commit that the crash skipped. The high-water mark moves
      // forward to the database, never backward.
      anchor.appendEntry(journalFile, {
        type: "commit", sequence: state.anchor_sequence, body_digest: digest(row.body), store_id: intent.store_id,
        attempt: intent.attempt,
      });
      // The recovery is an administrator action and must leave a durable trace.
      // The record is written next to the anchor, outside the database
      // rollback domain, so restoring an old database cannot erase it.
      const auditRecord = {
        schema_version: 1,
        at: new Date().toISOString(),
        by: audit.by,
        reason: audit.reason,
        database: path.resolve(filePath),
        recovered_sequence: state.anchor_sequence,
        anchor_sequence_before: journal.committed,
        body_digest: digest(row.body),
      };
      fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"),
        JSON.stringify(auditRecord) + "\n", { mode: 0o600 });
      db.exec("COMMIT");
      return { recovered: true, sequence: state.anchor_sequence, audit: auditRecord };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may not have started */ }
      // A refused recovery attempt is evidence too: it shows that somebody
      // tried to move the high-water mark. It is recorded next to the anchor
      // so it survives a database rollback.
      try {
        fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"), JSON.stringify({
          schema_version: 1,
          at: new Date().toISOString(),
          by: audit.by,
          reason: audit.reason,
          database: path.resolve(filePath),
          refused: true,
          code: error.code || error.name,
        }) + "\n", { mode: 0o600 });
      } catch { /* the refusal is still reported through the thrown error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  // Managed rebuild of the anchor when the journal itself was lost or rolled
  // back. Without such an entry point the service would be permanently
  // refused after an anchor loss, which is not a usable recovery path.
  //
  // The rebuild never lowers the high-water mark. Every sequence the journal
  // still knows about, including the ones of a partially deleted journal, is
  // carried over. The database must therefore be at least at that sequence,
  // and the caller has to name the database as the truth explicitly.
  static rebuildAnchor(filePath, options = {}) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    const audit = options.audit;
    if (!audit || typeof audit !== "object" || typeof audit.by !== "string" || !audit.by ||
        typeof audit.reason !== "string" || !audit.reason) fail("ERR_RECOVERY_AUDIT_REQUIRED");
    if (options.acceptDatabaseAsTruth !== true) fail("ERR_RECOVERY_NOT_APPLICABLE");
    const anchorDir = anchor.anchorDirFor(options.anchorDir);
    anchor.assertSeparateDomains(options.anchorDir, filePath);
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    const journalFile = anchor.journalFileFor(anchorDir);
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get();
      if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
      let state;
      try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
      assertState(state);
      if (state.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      // The permission mode of the anchor domain is a property of the
      // deployment. The caller may state it explicitly, and otherwise the
      // mode that was recorded with the state is used, so that a recovery
      // run by a different process applies the same contract. A caller may
      // not weaken the recorded contract for a single recovery run.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(state.anchor_mode, options.anchorMode),
        state.service_identity, options);
      // The known high-water mark includes every sequence the journal still
      // records, even when the commit entries were partially removed.
      const journal = anchor.readJournal(journalFile);
      const storeId = state.store_id;
      if (typeof storeId !== "string" || !storeId) fail("ERR_STATE_INVALID");
      // Only the entries that belong to this database count towards its
      // high-water mark. Entries of another instance were never part of this
      // store's history, and keeping them would leave the journal permanently
      // unusable: two store identities in one journal are corruption that no
      // other entry point can repair.
      const ownEntries = journal.entries.filter((entry) => entry.store_id === storeId);
      const known = ownEntries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
      // The declaration is the authoritative mark: it survives the deletion of
      // journal entries. The mark that the rebuild must reproduce is the
      // larger of the two witnesses.
      const declared = anchor.readHighWater(anchorDir);
      const mark = Math.max(known, declared.mark);
      // The database must sit exactly at the known high-water mark. A lower
      // sequence is a rollback and a higher one is either a crash window or a
      // forgery by whoever can write the database. Neither may be turned into
      // a new mark here: accepting a higher sequence would let an attacker who
      // only writes the database raise the mark and revive a one-shot permit,
      // and accepting a lower one would lower the mark.
      if (mark === 0) {
        // No witness of the mark is left at all. There is then nothing this
        // entry point can check the database against, and accepting it would
        // hand an attacker who can write the database a laundering channel:
        // wipe the anchor directory, forge the database, and rebuild. The
        // anchor domain loss is therefore not repairable here. It is handled
        // by resetAfterAnchorLoss(), which discards the database state instead
        // of trusting it.
        fail("ERR_RECOVERY_NOT_APPLICABLE");
      } else if (state.anchor_sequence !== mark) {
        fail("ERR_RECOVERY_NOT_APPLICABLE");
      }
      // The database must be byte-identical to the state the anchor domain
      // witnessed. The sequence alone is not a proof: an attacker who can
      // write the database can also raise its anchor_sequence to whatever
      // value the surviving witness happens to carry, and every sequence
      // check would pass while the body behind it was forged. The witness
      // holds the digest of the body that was actually committed, so the
      // rebuild is only allowed when the database body still hashes to it.
      // This is what makes the rebuild unable to launder a rollback: the
      // attacker can copy the sequence, but not the digest of a body the
      // anchor domain never saw.
      const bodyDigest = digest(row.body);
      // Only the digest that the anchor domain actually committed counts as a
      // witness. The digests of superseded attempts do not: an attempt that
      // was aborted was never committed, and letting its digest authorize a
      // rebuild would let a state that the store never reached be installed.
      const committedWitness = journal.committedBySeq.get(mark);
      const witnessed = new Set();
      if (committedWitness) witnessed.add(committedWitness.body_digest);
      if (declared.mark === mark && declared.digest) witnessed.add(declared.digest);
      if (witnessed.size === 0) fail("ERR_RECOVERY_NOT_APPLICABLE");
      if (!witnessed.has(bodyDigest)) fail("ERR_RECOVERY_NOT_APPLICABLE");
      // The witness for this sequence already describes the database body, so
      // the rebuild must not write a new attempt for it. A second attempt at
      // the same sequence would replace the original witness (the journal
      // keeps the highest attempt) and destroy the evidence of what the
      // anchor domain actually saw.
      const existingWitness = journal.committedBySeq.get(mark) || null;
      if (existingWitness && existingWitness.body_digest !== bodyDigest) {
        fail("ERR_RECOVERY_NOT_APPLICABLE");
      }
      // Entries of a foreign instance are moved aside instead of deleted, so
      // the evidence survives while the journal becomes usable again.
      const quarantined = anchor.quarantineForeignEntries(journalFile, storeId);
      // The rebuilt anchor starts at the database's own sequence, so the
      // high-water mark never moves backwards.
      // The journal is the single source of the attempt counter. The
      // declaration keeps a copy for the sequences it still remembers, but it
      // is compacted and therefore drops the counters of older sequences.
      // Merging both maps would let a number that was already used in the
      // journal be handed out again once the journal entry of that sequence
      // was pruned, and the journal could then no longer tell which attempt
      // of a sequence is the current one.
      const latestAttemptBySeq = new Map();
      for (const entry of ownEntries) {
        const known = latestAttemptBySeq.get(entry.sequence) || 0;
        if (entry.attempt > known) latestAttemptBySeq.set(entry.sequence, entry.attempt);
      }
      for (const [sequence, attempt] of declared.latestAttemptBySeq) {
        const known = latestAttemptBySeq.get(sequence) || 0;
        if (attempt > known) latestAttemptBySeq.set(sequence, attempt);
      }
      // A sequence that the anchor domain already witnessed must not be
      // written again. The journal keeps the highest attempt per sequence, so
      // a second attempt would replace the original witness and destroy the
      // digest of the body that was actually committed. The rebuild therefore
      // only fills a gap: it writes a witness for a sequence that has none.
      const alreadyWitnessed = journal.committedBySeq.has(state.anchor_sequence);
      const rebuildAttempt = anchor.nextAttemptFor({ latestAttemptBySeq }, state.anchor_sequence);
      if (!alreadyWitnessed) {
        anchor.appendEntry(journalFile, {
          type: "intent", sequence: state.anchor_sequence, body_digest: bodyDigest, store_id: storeId,
          attempt: rebuildAttempt,
        });
        anchor.appendEntry(journalFile, {
          type: "commit", sequence: state.anchor_sequence, body_digest: bodyDigest, store_id: storeId,
          attempt: rebuildAttempt,
        });
      }
      if (!alreadyWitnessed && declared.mark < state.anchor_sequence) {
        anchor.appendHighWater(anchorDir, {
          sequence: state.anchor_sequence, body_digest: bodyDigest, store_id: storeId, attempt: rebuildAttempt,
        });
      }
      const auditRecord = {
        schema_version: 1,
        at: new Date().toISOString(),
        by: audit.by,
        reason: audit.reason,
        database: path.resolve(filePath),
        rebuilt: true,
        sequence: state.anchor_sequence,
        known_sequence_before: known,
        quarantined_entries: quarantined,
        body_digest: digest(row.body),
      };
      fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"),
        JSON.stringify(auditRecord) + "\n", { mode: 0o600 });
      db.exec("COMMIT");
      return { rebuilt: true, sequence: state.anchor_sequence, audit: auditRecord };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may not have started */ }
      try {
        fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"), JSON.stringify({
          schema_version: 1,
          at: new Date().toISOString(),
          by: audit.by,
          reason: audit.reason,
          database: path.resolve(filePath),
          refused: true,
          code: error.code || error.name,
        }) + "\n", { mode: 0o600 });
      } catch { /* the refusal is still reported through the thrown error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  // Recovery after the whole anchor domain was lost. The rebuild entry point
  // cannot serve this case: with no witness of the mark left, it would have
  // to trust the database, and the database is exactly what an attacker who
  // can write it controls. This entry point therefore does not trust the
  // database at all. It discards the stored state, issues a new store
  // identity, advances the service epoch so that every old session becomes
  // invalid, and starts a fresh anchor.
  //
  // Nothing is carried over. A permit that existed before the loss does not
  // exist afterwards, so there is nothing that could be consumed twice.
  static resetAfterAnchorLoss(filePath, options = {}) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    const audit = options.audit;
    if (!audit || typeof audit !== "object" || typeof audit.by !== "string" || !audit.by ||
        typeof audit.reason !== "string" || !audit.reason) fail("ERR_RECOVERY_AUDIT_REQUIRED");
    const anchorDir = anchor.anchorDirFor(options.anchorDir);
    anchor.assertSeparateDomains(options.anchorDir, filePath);
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    const journalFile = anchor.journalFileFor(anchorDir);
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get();
      if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
      let state;
      try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
      assertState(state);
      if (state.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      // The permission mode of the anchor domain is a property of the
      // deployment. The caller may state it explicitly, and otherwise the
      // mode that was recorded with the state is used, so that a recovery
      // run by a different process applies the same contract. A caller may
      // not weaken the recorded contract for a single recovery run.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(state.anchor_mode, options.anchorMode),
        state.service_identity, options);
      // The reset must use the same clock the service itself runs on. A reset
      // that stamps the fresh state with the wall clock while the service
      // runs on an injected clock would write a timestamp the service has
      // never seen, and the next open would refuse the store as a clock
      // rollback. The clock is therefore required rather than defaulted.
      //
      // The check has to happen BEFORE the anchor domain is retired. A reset
      // that fails after retiring the anchor leaves the database rolled back
      // but the anchor domain emptied, which is a state that is neither
      // "not reset" nor "reset": the old permit is still in the database
      // while no witness of it is left.
      if (typeof options.clock !== "function") fail("ERR_CLOCK_INVALID");
      const now = options.clock();
      if (!Number.isSafeInteger(now) || now < 0) fail("ERR_CLOCK_INVALID");
      // The whole old anchor domain is retired: its entries belong to the
      // identity that is being replaced, and its high-water declaration
      // would keep the old mark and stop the fresh instance from starting.
      const retiredStoreId = typeof state.store_id === "string" ? state.store_id : null;
      const quarantined = anchor.retireAnchorDomain(anchorDir);
      const storeId = crypto.randomBytes(16).toString("hex");
      // Nothing of the old state survives: no lease, no permit, no idempotency
      // key, and a new service epoch so that every old session is invalid.
      // The declared service identity survives the reset: it is a property of
      // the deployment, not of the state that was lost.
      const fresh = initialState(now, options.expectedDecisionId, storeId, options.anchorMode,
        state.service_identity);
      fresh.service_epoch = state.service_epoch + 1;
      // The clock is taken from the injected clock when one is given. Using
      // the wall clock here would write a timestamp the service's own clock
      // has never seen, and the next open would refuse the store as a clock
      // rollback.
      fresh.last_clock_ms = Math.max(now, state.last_clock_ms);
      const body = JSON.stringify(fresh);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, digest(body));
      db.exec("COMMIT");
      // The fresh anchor starts at sequence 1 with the new identity.
      anchor.appendEntry(journalFile, { type: "intent", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      anchor.appendEntry(journalFile, { type: "commit", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      anchor.appendHighWater(anchorDir, { sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      const auditRecord = {
        schema_version: 1,
        at: new Date().toISOString(),
        by: audit.by,
        reason: audit.reason,
        database: path.resolve(filePath),
        reset: true,
        retired_store_id: retiredStoreId,
        new_store_id: storeId,
        service_epoch: fresh.service_epoch,
        quarantined_entries: quarantined,
      };
      fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"),
        JSON.stringify(auditRecord) + "\n", { mode: 0o600 });
      return { reset: true, storeId, serviceEpoch: fresh.service_epoch, audit: auditRecord };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may not have started */ }
      try {
        fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"), JSON.stringify({
          schema_version: 1,
          at: new Date().toISOString(),
          by: audit.by,
          reason: audit.reason,
          database: path.resolve(filePath),
          refused: true,
          code: error.code || error.name,
        }) + "\n", { mode: 0o600 });
      } catch { /* the refusal is still reported through the thrown error */ }
      throw error;
    } finally {
      db.close();
    }
  }
}

module.exports = { ProtectedPermitStore, ProtectedStoreError, PROTECTED_SCOPE };
