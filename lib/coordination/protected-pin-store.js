// The REGISTERED anchor domain (design document section 4.2.1).
//
// This is NOT the witnessing anchor domain. It stores the batch public
// key pin and nothing else: it carries no journal, witnesses no database
// body digest, and takes no part in rollback detection. Reusing
// ProtectedPermitStore for it would graft the "witnesses the database body"
// semantics onto a directory that only has to hold a pin.
//
// What it DOES reuse is the permit store's permission judgement surface: the
// writable-identity set enumeration and comparison, the null-is-fail-closed
// rule, and the mandatory service identity declaration. The contract this
// domain adds is the same one the permit store's own domain carries -- the writable
// set must be EXACTLY the service identity -- and it is checked with the
// same code, so the two cannot drift apart.
//
// The domain lives on the VERIFIER's machine (Windows side). The permit
// database stays on the Mac side. The two are on different machines, so
// their separation is automatic there, but the check is still made
// explicitly: a deployment shape change must not be allowed to quietly
// place the pin inside the permit database's directory.
//
// Two rules govern what may be written here, and they are different in
// kind:
//
//   1. Pin entries only ever GROW. A pin records a registration fact (who
//      was registered as a verifiable key). Revocation does not remove a
//      pin entry -- revocation semantics are carried entirely by the
//      fingerprint-level revoked set (design section 2.3.1 R4-B4 ruling 1).
//      Removing the entry would also deadlock the revocation protocol: a
//      revoked key could then never sign the list that revokes it.
//   2. The revoked fingerprint set also only ever GROWS, and it is a set of
//      facts rather than a list of intentions, so a list that drops a
//      fingerprint is refused.
//
// The state file is the domain's whole content. It is written atomically:
// the bytes go to a temporary file in the same directory, are flushed and
// fsynced, and are then renamed over the target. A reader therefore sees
// either the previous state or the next one, never a half-written file.
// The rename is atomic within a directory on the same filesystem, which is
// why the temporary file is created in the domain itself and not in the
// system temp directory.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const anchor = require("./protected-anchor");
const coordination = require("./protected-store-lock");
const { CoordinationError } = require("./errors");

function fail(code) { throw new CoordinationError(code); }

const STATE_FILE = "pin-state.json";
// Format 3 fences both legacy state readers (formats 1 and 2) and binds the
// fixed SQLite lock inode. Directory separation is NOT rollback protection:
// whole-machine rollback requires the machine-external trusted witness.
const DOMAIN_MARKER_FILE = "pin-domain.json";
const STATE_SCHEMA_VERSION = 3;
const LEGACY_LOCK_FILE = ".pin-critical-section.lock";
// A failed poison write must not make another store handle in this process
// authorize the same domain. Cross-process/restart safety still requires the
// independently witnessed durable state.
const CLOCK_POISONED_DOMAINS = new Set();

// The batch identity is the triple that decides whether an existing pin
// belongs to THIS batch (design section 2.2.3 R3-B3 ruling 1). The fields
// that are deliberately NOT part of it are listed in the design table:
// run_id and generation would kill a legitimate reconnect, and
// valid_from / valid_until / source_digest / deployment_digest do not
// distinguish one batch from another.
const BATCH_IDENTITY_FIELDS = Object.freeze(["decision_id", "instance_id", "fingerprint"]);

// The fields the registration action CARRIES (design section 2.2's field
// table). They are recorded on the pin entry, and they are deliberately
// NOT part of the batch identity:
//
//   run_id / generation  -- participating in the identity comparison would
//                          kill a legitimate reconnect (R3-B3 ruling 1).
//   valid_from / valid_until -- they change on renewal, so they are unstable.
//   source_digest / deployment_digest -- same-batch and cross-batch may
//                          share them, so they do not tell batches apart.
//
// Recording them is a different obligation from comparing them: the
// comparison rule stays the triple, and the entry keeps the record of what
// this registration actually carried.
const REGISTRATION_CARRIED_FIELDS = Object.freeze([
  "source_digest",
  "deployment_digest",
  "run_id",
  "generation",
  "valid_from",
  "valid_until",
]);

// The carried fields must never enter the identity comparison.
//
// This is asserted here rather than left to a comment, because the two
// lists are the whole point of the distinction and a comment cannot
// fail: a later change that added, say, `run_id` to
// BATCH_IDENTITY_FIELDS would compile, pass every existing test that
// only re-registers the same values, and silently start killing
// legitimate reconnects.
//
// The two sets are disjoint by construction: the carried fields are the
// design's section 2.2 field table minus the batch identity triple.
for (const field of REGISTRATION_CARRIED_FIELDS) {
  if (BATCH_IDENTITY_FIELDS.includes(field)) {
    // A carried field that is also an identity criterion is exactly the
    // regression this assertion exists to catch.
    fail("ERR_PERMIT_INPUT_INVALID");
  }
}

function requireText(value, key) {
  if (typeof value !== "string" || !value) fail(key || "ERR_PERMIT_INPUT_INVALID");
  return value;
}

function requireSafeInteger(value, key) {
  if (!Number.isSafeInteger(value)) fail(key || "ERR_PERMIT_INPUT_INVALID");
  return value;
}

// The generation of a run, in the form the SIGNED BINDING LAYER actually
// produces.
//
// The permit store's acquire()/reserve() take `generation` as a TEXT
// value (protected-permit-store.js requires it with requireText), and the
// signature layer carries that value through unchanged: the signed
// message's `generation` is the string the permit store held.
//
// The registration action carries that same binding value through
// unchanged -- it is NOT a new field and NOT a re-typed one. Requiring a
// safe integer here would therefore REJECT the very value the wiring is
// supposed to pass through: an integrator who reads the permit's
// `generation` and hands it to registerOnTarget verbatim would get
// ERR_PERMIT_INPUT_INVALID for a value that is perfectly valid upstream.
//
// So the accepted shape is the upstream one: a non-empty string. A
// number is accepted too and is normalised to its decimal text, because
// the upstream value for a given run is always the same string and the
// entry must record exactly what was carried.
function requireGenerationText(value, key) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && value) return value;
  fail(key || "ERR_PERMIT_INPUT_INVALID");
  return null;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function emptyState() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    // The pins that have been registered on this machine. Each entry is a
    // registration fact and is never removed.
    pins: [],
    // The fingerprints that have been revoked. Only ever grows.
    revoked_fingerprints: [],
    // The revocation sequence that has been APPLIED locally. The revocation
    // list whose sequence is applied+1 is the only one accepted next.
    applied_revocation_sequence: 0,
    // The highest sequence that has been SEEN. This may run ahead of the
    // applied one while a pull is in flight.
    highest_seen_revocation_sequence: 0,
    highest_accepted_permit_sequence: 0,
    last_observed_clock_ms: 0,
    // The clock-poisoning marker. A poisoned domain refuses every new
    // permit until it is cleared by the procedure the design defines.
    clock_poisoned: false,
  };
}

function stateFilePath(pinDir) {
  return path.join(pinDir, STATE_FILE);
}

function domainMarkerPath(pinDir) {
  return path.join(pinDir, DOMAIN_MARKER_FILE);
}

function readDomainMarker(pinDir) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(domainMarkerPath(pinDir), "utf8"));
  } catch { fail("ERR_PIN_STATE_CORRUPT"); }
  if (!marker || marker.domain_schema_version !== STATE_SCHEMA_VERSION ||
      typeof marker.lock_identity !== "string" || !marker.lock_identity ||
      typeof marker.legacy_lock_identity !== "string" || !marker.legacy_lock_identity) {
    fail("ERR_PIN_STATE_CORRUPT");
  }
  return marker;
}

function legacyFenceIdentity(pinDir) {
  let stat;
  try { stat = fs.lstatSync(path.join(pinDir, LEGACY_LOCK_FILE)); }
  catch { fail("ERR_PIN_STATE_CORRUPT"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 ||
       (typeof process.getuid === "function" && stat.uid !== process.getuid())))) {
    fail("ERR_PIN_STATE_CORRUPT");
  }
  if (process.platform === "win32") {
    coordination.assertWindowsFilePermissions(path.join(pinDir, LEGACY_LOCK_FILE));
  }
  return [stat.dev, stat.ino].join(":");
}

// A permanent O_EXCL fence blocks the non-reclaiming legacy implementation.
// Older reclaiming implementations are also fenced by state format 3. Never
// remove this file, including after a failed initialization/migration.
function createLegacyFence(pinDir) {
  const fd = fs.openSync(path.join(pinDir, LEGACY_LOCK_FILE), "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ owner: "pin-format-3", pid: process.pid,
      token: crypto.randomBytes(16).toString("hex") }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return legacyFenceIdentity(pinDir);
}

function readState(pinDir, { legacy = false } = {}) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(stateFilePath(pinDir), "utf8")); }
  catch { fail("ERR_PIN_STATE_CORRUPT"); }
  if (!parsed || typeof parsed !== "object") fail("ERR_PIN_STATE_CORRUPT");
  // Format 1 has no accepted-permit/clock baseline. It cannot be migrated by
  // inventing zeroes; an independently verified recovery procedure is needed.
  if (parsed.schema_version !== (legacy ? 2 : STATE_SCHEMA_VERSION)) fail("ERR_PIN_STATE_CORRUPT");
  if (!Array.isArray(parsed.pins)) fail("ERR_PIN_STATE_CORRUPT");
  if (!Array.isArray(parsed.revoked_fingerprints)) fail("ERR_PIN_STATE_CORRUPT");
  requireSafeInteger(parsed.applied_revocation_sequence, "ERR_PIN_STATE_CORRUPT");
  requireSafeInteger(parsed.highest_seen_revocation_sequence, "ERR_PIN_STATE_CORRUPT");
  if (!Number.isSafeInteger(parsed.highest_accepted_permit_sequence) || parsed.highest_accepted_permit_sequence < 0 ||
      !Number.isSafeInteger(parsed.last_observed_clock_ms) || parsed.last_observed_clock_ms < 0) {
    fail("ERR_PIN_STATE_CORRUPT");
  }
  if (typeof parsed.clock_poisoned !== "boolean") fail("ERR_PIN_STATE_CORRUPT");
  for (const pin of parsed.pins) {
    if (!pin || typeof pin !== "object") fail("ERR_PIN_STATE_CORRUPT");
    for (const field of BATCH_IDENTITY_FIELDS) requireText(pin[field], "ERR_PIN_STATE_CORRUPT");
    requireText(pin.public_key_pem, "ERR_PIN_STATE_CORRUPT");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pin.public_key_pem)) fail("ERR_PIN_STATE_CORRUPT");
  }
  return parsed;
}

// The state is written atomically: a temporary file in the same directory,
// then a rename over the target. The temporary file carries a name that no
// reader looks at, and it is removed if the write fails, so a crashed
// write leaves the previous state intact rather than a truncated one.
function writeState(pinDir, state) {
  writeJson(pinDir, STATE_FILE, state);
}

function writeJson(pinDir, name, value) {
  const body = JSON.stringify(value);
  const target = path.join(pinDir, name);
  const temporary = path.join(pinDir, "." + name + ".tmp-" + process.pid + "-" + crypto.randomBytes(12).toString("hex"));
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(handle, body);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw error;
  }
}

// The public key fingerprint is derived from the key material itself, so a
// pin entry cannot claim a fingerprint that does not belong to the key it
// carries. The fingerprint is what the design compares, so it has to be
// the derived one and not a value the caller supplied.
function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" });
  return sha256Hex(der);
}

function findPin(state, fingerprint) {
  return state.pins.find((pin) => pin.fingerprint === fingerprint) || null;
}

// The batch identity comparison is field-by-field equality on the triple
// (design section 2.2.3 R3-B3 ruling 1). A pin that is missing or
// unreadable is "undecidable", and an undecidable fact is handled as NOT
// satisfied -- the route stops. It is never treated as "different batch
// but harmless", because the two would lead to the same action here.
function sameBatchIdentity(pin, batchIdentity) {
  if (!pin) return false;
  for (const field of BATCH_IDENTITY_FIELDS) {
    if (pin[field] !== batchIdentity[field]) return false;
  }
  return true;
}

class ProtectedPinStore {
  #pinDir;
  #options;
  #lockIdentity = null;
  #lockDepth = 0;

  constructor(pinDir, options = {}) {
    this.#pinDir = pinDir;
    this.#options = { ...options };
  }

  static #directory(pinDir, options, { requireEmpty = false } = {}) {
    requireText(options.decisionId, "ERR_PERMIT_INPUT_INVALID");
    if (!pinDir) fail("ERR_PERMIT_INPUT_INVALID");
    const resolved = path.resolve(pinDir);
    // Reject redirected Windows ancestors before the permission check can
    // write an audit record, or provisioning can create the legacy fence.
    if (process.platform === "win32") coordination.assertAnchorPathIsNotRedirected(resolved);
    // The pin directory must exist, must not be a symlink, and must not be
    // a file. anchorDirFor checks exactly those properties and normalises
    // the canonical path.
    const anchorDir = anchor.anchorDirFor(resolved);
    // The strict Windows ancestor check can create its audit log. Establish
    // freshness first; pre-existing audit files are not an empty domain.
    if (requireEmpty && fs.readdirSync(anchorDir).length !== 0) fail("ERR_PIN_STATE_CORRUPT");
    // Production Windows always uses native evidence and the strict contract,
    // including the declared service identity and ancestor audit. Callers may
    // not turn an adapter/platform override or permissive mode into evidence.
    // Other hosts retain the existing development/simulation surface.
    const nativeWindows = process.platform === "win32";
    const permissionOptions = nativeWindows
      ? { platform: "windows", controlledAncestorPath: options.controlledAncestorPath }
      : options;
    const mode = anchor.assertKnownAnchorMode(options.anchorMode);
    anchor.assertAnchorPermissionsWithIdentity(
      anchorDir,
      nativeWindows ? anchor.ANCHOR_MODE.strict : mode,
      options.serviceIdentity,
      permissionOptions,
    );
    return anchorDir;
  }

  // Explicit provisioning only, in an empty directory isolated from legacy
  // services until this call completes. open() never provisions or repairs.
  static initialize(pinDir, options = {}) {
    const dir = this.#directory(pinDir, options, { requireEmpty: true });
    return this.#provision(dir, options, emptyState());
  }

  // This is an OFFLINE deployment operation, not rolling-upgrade support.
  // The operator must stop/disable all old services and drain their handles
  // before asserting offline:true, and deploy only format-3 readers afterward.
  // PID inspection cannot prove that precondition. Existing legacy locks,
  // partial migrations and format-1 state are refused without cleanup/reset.
  static migrateOffline(pinDir, options = {}) {
    if (options.offline !== true) fail("ERR_PERMIT_INPUT_INVALID");
    const dir = this.#directory(pinDir, options);
    let marker;
    try { marker = JSON.parse(fs.readFileSync(domainMarkerPath(dir), "utf8")); }
    catch { fail("ERR_PIN_STATE_CORRUPT"); }
    if (!marker || marker.domain_schema_version !== 2 ||
        fs.existsSync(path.join(dir, coordination.FILE))) fail("ERR_PIN_STATE_CORRUPT");
    const state = readState(dir, { legacy: true });
    return this.#provision(dir, options, { ...state, schema_version: STATE_SCHEMA_VERSION }, marker);
  }

  static #provision(dir, options, state, legacyMarker = null) {
    const fenceIdentity = createLegacyFence(dir);
    return coordination.withLock(dir, (identity) => {
      // Re-read after taking the legacy namespace and the stable lock. No
      // cached legacy state is allowed to overwrite a completed old write.
      if (legacyMarker) state = { ...readState(dir, { legacy: true }), schema_version: STATE_SCHEMA_VERSION };
      const marker = { ...legacyMarker, domain_schema_version: STATE_SCHEMA_VERSION,
        initialised_at_ms: legacyMarker ? legacyMarker.initialised_at_ms : Date.now(),
        lock_identity: identity, legacy_lock_identity: fenceIdentity };
      writeJson(dir, DOMAIN_MARKER_FILE, marker);
      writeState(dir, state);
      const store = new ProtectedPinStore(dir, options);
      store.#lockIdentity = identity;
      return store;
    }, { create: true });
  }

  static open(pinDir, options = {}) {
    const dir = this.#directory(pinDir, options);
    const marker = readDomainMarker(dir);
    return coordination.withLock(dir, (identity) => {
      const store = new ProtectedPinStore(dir, options);
      store.#lockIdentity = identity;
      store.#assertDomain();
      readState(dir);
      return store;
    }, { expectedIdentity: marker.lock_identity });
  }

  #assertDomain() {
    ProtectedPinStore.#directory(this.#pinDir, this.#options);
    const marker = readDomainMarker(this.#pinDir);
    if (this.#lockIdentity === null || marker.lock_identity !== this.#lockIdentity ||
        legacyFenceIdentity(this.#pinDir) !== marker.legacy_lock_identity) fail("ERR_PIN_STATE_CORRUPT");
    // withLock checks around the outer action; nested calls must also refuse
    // replacement before doing any work under the previously acquired lock.
    const dir = fs.lstatSync(this.#pinDir);
    const lock = fs.lstatSync(path.join(this.#pinDir, coordination.FILE));
    if ([dir.dev, dir.ino, lock.dev, lock.ino].join(":") !== this.#lockIdentity) {
      throw Object.assign(new Error("ERR_COORDINATION_LOCK_REPLACED"), { code: "ERR_COORDINATION_LOCK_REPLACED" });
    }
  }

  #readState() {
    return this.criticalSection(() => readState(this.#pinDir));
  }

  // The permit database's directory must not contain this domain and this
  // domain must not contain it. On the two-machine deployment the two are
  // on different hosts and the constraint holds automatically; the check is
  // made explicitly so that a deployment change cannot quietly violate it.
  assertSeparateFromPermitDatabase(databasePath) {
    anchor.assertSeparateDomains(this.#pinDir, databasePath);
  }

  get pinDir() { return this.#pinDir; }

  // The local critical section.
  //
  // "A transaction" in this design means the LOCAL critical section on the
  // registered anchor domain on the verifier's machine (design section
  // 2.3.1 R3-B2 ruling 1). It does NOT cover the Mac-side permit store and
  // it does NOT cover the network connection.
  //
  // The lock is a fixed SQLite transaction taken on the domain itself. It is deliberately
  // not shared with the permit store's SQLite transaction: those are two separate
  // locks on two separate machines, and the only thing that passes between
  // them is a signed revocation list.
  //
  // The caller injects the body; the body runs with the lock held, and the
  // lock is released whether the body returns or throws.
  //
  // The section is REENTRANT on this handle. The cross-machine path
  // takes the section around the whole registration -- the exclusivity
  // check, the pin write and the snapshot advance are one atomic step --
  // and that path calls into the store's own registerPin, which takes the
  // section again. A non-reentrant lock would make the outer section fail
  // against its own inner call, and the fix for that must NOT be "take the
  // lock less often": the outer section is what makes the three steps one
  // step.
  //
  // Callbacks must be synchronous. Another handle, even in this process,
  // acquires the SQLite lock independently and receives bounded contention.
  criticalSection(body) {
    if (typeof body !== "function") fail("ERR_PERMIT_INPUT_INVALID");
    if (body.constructor.name === "AsyncFunction") fail("ERR_PERMIT_INPUT_INVALID");
    this.#assertDomain();
    if (this.#lockDepth > 0) {
      return body();
    }
    return coordination.withLock(this.#pinDir, () => {
      this.#assertDomain();
      readState(this.#pinDir);
      this.#lockDepth = 1;
      try {
        const result = body();
        if (result && typeof result.then === "function") fail("ERR_PERMIT_INPUT_INVALID");
        return result;
      }
      finally { this.#lockDepth = 0; }
    }, { expectedIdentity: this.#lockIdentity });
  }

  // Register a pin.
  //
  // The write is atomic create-if-absent with O_EXCL semantics: of two
  // concurrent registrants only the first succeeds, the second gets EEXIST
  // and does NOT overwrite (design section 2.2.3). That property is what
  // makes the registration exclusive without a separate check-then-act
  // window.
  //
  // The caller supplies the write as a function, and the whole
  // decision-and-write runs inside the protected critical section, so the
  // "there is no existing pin" half of the exclusivity guarantee is not a
  // window between a check and a write.
  registerPin(options) {
    const { batchIdentity, publicKeyPem, write } = options;
    for (const field of BATCH_IDENTITY_FIELDS) requireText(batchIdentity[field], "ERR_PERMIT_INPUT_INVALID");
    requireText(publicKeyPem, "ERR_PERMIT_INPUT_INVALID");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(publicKeyPem)) fail("ERR_PERMIT_INPUT_INVALID");
    if (typeof write !== "function") fail("ERR_PERMIT_INPUT_INVALID");
    // The registration action carries the design's field table (section
    // 2.2). All six are required here: a registration that cannot say what
    // it carried cannot be audited later, and the design lists them as
    // part of the registration action, not as optional annotations.
    //
    // This is a CARRIED obligation, not an identity criterion. The batch
    // comparison below still uses the triple; see
    // REGISTRATION_CARRIED_FIELDS for why those two are different things.
    requireText(options.sourceDigest, "ERR_PERMIT_INPUT_INVALID");
    requireText(options.deploymentDigest, "ERR_PERMIT_INPUT_INVALID");
    // The string conversion is only for the numeric-looking run ids. It is
    // applied AFTER the presence check: String(undefined) is the string
    // "undefined", which would sail through a text check and record a
    // run id that was never supplied.
    if (options.runId === undefined || options.runId === null) {
      fail("ERR_PERMIT_INPUT_INVALID");
    }
    requireText(String(options.runId), "ERR_PERMIT_INPUT_INVALID");
    // The generation is the signed binding value, in the form the
    // upstream permit store holds it (a text value). See
    // requireGenerationText for why an integer requirement here would
    // reject the very value the wiring is supposed to pass through.
    const generation = requireGenerationText(options.generation, "ERR_PERMIT_INPUT_INVALID");
    requireSafeInteger(options.validFrom, "ERR_PERMIT_INPUT_INVALID");
    requireSafeInteger(options.validUntil, "ERR_PERMIT_INPUT_INVALID");
    const fingerprint = publicKeyFingerprint(publicKeyPem);
    if (batchIdentity.fingerprint !== fingerprint) fail("ERR_PIN_FINGERPRINT_MISMATCH");
    return this.criticalSection(() => {
      const state = this.#readState();
      const existing = findPin(state, fingerprint);
      if (existing) {
        // A pin for this key already exists. If it belongs to THIS batch
        // the route is a reconnect: the pin is reused, not rewritten.
        // If it belongs to a DIFFERENT batch the route stops -- the pin is
        // never overwritten with a new batch.
        if (sameBatchIdentity(existing, batchIdentity)) {
          return { registered: false, reused: true, fingerprint, pin: existing };
        }
        fail("ERR_PIN_BATCH_MISMATCH");
      }
      const entry = {
        decision_id: batchIdentity.decision_id,
        instance_id: batchIdentity.instance_id,
        fingerprint,
        public_key_pem: publicKeyPem,
        registered_at_ms: requireSafeInteger(options.nowMs, "ERR_PERMIT_INPUT_INVALID"),
        // The carried fields are recorded on the entry. They are not read
        // back for the batch comparison -- that stays the triple -- so a
        // renewal that changes valid_until does not change the batch.
        source_digest: options.sourceDigest,
        deployment_digest: options.deploymentDigest,
        run_id: String(options.runId),
        generation,
        valid_from: options.validFrom,
        valid_until: options.validUntil,
      };
      // The create-if-absent write is the atomicity guarantee. A concurrent
      // creator that loses the race gets EEXIST and does not overwrite.
      const created = write(entry, fingerprint);
      if (created === false) fail("ERR_PIN_ALREADY_EXISTS");
      state.pins.push(entry);
      writeState(this.#pinDir, state);
      return { registered: true, reused: false, fingerprint, pin: entry };
    });
  }

  // The pins that are registered on this machine. This is the ONLY source
  // of public keys the verification path accepts.
  listPins() {
    const state = this.#readState();
    return state.pins.map((pin) => ({ ...pin }));
  }

  // The fingerprint set of the registered pins. A revocation list is
  // refused unless the key that signed it is in this set.
  pinnedFingerprints() {
    const state = this.#readState();
    return new Set(state.pins.map((pin) => pin.fingerprint));
  }

  // The public key for a fingerprint, or null. Null means "not registered
  // here", which the verification path treats as a refusal -- it never
  // falls back to a key carried by the list itself.
  publicKeyFor(fingerprint) {
    const state = this.#readState();
    const pin = findPin(state, fingerprint);
    return pin ? pin.public_key_pem : null;
  }

  // The local revocation state, as the verification path consumes it.
  revocationState() {
    const state = this.#readState();
    return {
      appliedRevocationSequence: state.applied_revocation_sequence,
      highestSeenRevocationSequence: state.highest_seen_revocation_sequence,
      revokedFingerprints: new Set(state.revoked_fingerprints),
    };
  }

  // A legacy domain has no trustworthy history of accepted permits. It may
  // retain and update revocations, but cannot accept permits until recovered
  // from an independently verified baseline.
  assertPermitReplayState() {
    const state = this.#readState();
    if (state.schema_version !== STATE_SCHEMA_VERSION) fail("ERR_PIN_STATE_CORRUPT");
    return state.highest_accepted_permit_sequence;
  }

  // A clock rollback poisons the target domain persistently before refusing
  // verification. A trusted host must govern any subsequent marker clearing.
  observePermitClock(nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("ERR_CLOCK_INVALID");
    return this.criticalSection(() => {
      const state = this.#readState();
      if (state.schema_version !== STATE_SCHEMA_VERSION || state.clock_poisoned ||
          CLOCK_POISONED_DOMAINS.has(this.#pinDir)) fail("ERR_CLOCK_INVALID");
      if (nowMs < state.last_observed_clock_ms) {
        CLOCK_POISONED_DOMAINS.add(this.#pinDir);
        state.clock_poisoned = true;
        writeState(this.#pinDir, state);
        fail("ERR_CLOCK_INVALID");
      }
      if (nowMs > state.last_observed_clock_ms) {
        state.last_observed_clock_ms = nowMs;
        writeState(this.#pinDir, state);
      }
      return nowMs;
    });
  }

  // Commit an applied revocation list.
  //
  // The revoked set and the applied high-water mark advance TOGETHER. The
  // design's local invariant B is exactly that: on exit from the critical
  // section, either both advanced or neither did (design section 2.3.1
  // R3-B2 ruling 3).
  //
  // The caller has already verified the list -- the signature, the chain
  // position, the signer's presence in the pin and the signer's absence
  // from the revoked set. This function only commits what passed those
  // checks; it never decides whether a list is acceptable.
  commitRevocation(options) {
    const { revokedFingerprints, sequence, permitSequence } = options;
    requireSafeInteger(sequence, "ERR_PERMIT_INPUT_INVALID");
    if (!Array.isArray(revokedFingerprints)) fail("ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = this.#readState();
      if (!Number.isSafeInteger(state.applied_revocation_sequence + 1) ||
          sequence !== state.applied_revocation_sequence + 1) fail("ERR_REVOCATION_SEQUENCE_BROKEN");
      if (permitSequence !== undefined) {
        if (state.schema_version !== STATE_SCHEMA_VERSION) fail("ERR_PIN_STATE_CORRUPT");
        requireSafeInteger(permitSequence, "ERR_PERMIT_INPUT_INVALID");
        if (permitSequence <= state.highest_accepted_permit_sequence) fail("ERR_PERMIT_SEQUENCE_REPLAY");
        state.highest_accepted_permit_sequence = permitSequence;
      }
      // The applied set only grows. A commit that would drop a fingerprint
      // is refused and nothing advances.
      const incoming = new Set(revokedFingerprints);
      for (const known of state.revoked_fingerprints) {
        if (!incoming.has(known)) fail("ERR_REVOCATION_SET_NOT_MONOTONIC");
      }
      state.revoked_fingerprints = Array.from(incoming).sort();
      state.applied_revocation_sequence = sequence;
      if (sequence > state.highest_seen_revocation_sequence) {
        state.highest_seen_revocation_sequence = sequence;
      }
      writeState(this.#pinDir, state);
      return {
        appliedRevocationSequence: state.applied_revocation_sequence,
        revokedFingerprints: state.revoked_fingerprints.length,
      };
    });
  }

  // Record that a revocation list was SEEN, without applying it. The seen
  // mark may run ahead of the applied one while a pull is in flight.
  noteRevocationSeen(sequence) {
    requireSafeInteger(sequence, "ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = this.#readState();
      if (sequence > state.highest_seen_revocation_sequence) {
        state.highest_seen_revocation_sequence = sequence;
        writeState(this.#pinDir, state);
      }
      return { highestSeenRevocationSequence: state.highest_seen_revocation_sequence };
    });
  }

  // The direct revocation registration (design section 2.3.1 R4-B4
  // ruling 5).
  //
  // This is the ONE exception path that does not depend on a cross-machine
  // signature: it is how a batch's revocation is conveyed when no valid
  // batch key is left to sign a list with. It writes the revoked
  // fingerprint set directly, and it advances the revocation sequence by
  // one so the chain does not break.
  //
  // It does NOT relax the rule that the signer of a list must still be
  // valid -- this path never verifies a signature at all, so that rule does
  // not apply to it.
  registerDirectRevocation(options) {
    const { fingerprint, sequence } = options;
    requireText(fingerprint, "ERR_PERMIT_INPUT_INVALID");
    requireSafeInteger(sequence, "ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = this.#readState();
      if (!Number.isSafeInteger(state.applied_revocation_sequence + 1) ||
          sequence !== state.applied_revocation_sequence + 1) {
        fail("ERR_REVOCATION_SEQUENCE_BROKEN");
      }
      const incoming = new Set(state.revoked_fingerprints);
      incoming.add(fingerprint);
      state.revoked_fingerprints = Array.from(incoming).sort();
      state.applied_revocation_sequence = sequence;
      if (sequence > state.highest_seen_revocation_sequence) {
        state.highest_seen_revocation_sequence = sequence;
      }
      writeState(this.#pinDir, state);
      return {
        appliedRevocationSequence: state.applied_revocation_sequence,
        revokedFingerprints: state.revoked_fingerprints.length,
      };
    });
  }

  // The clock-poisoning marker. A poisoned domain refuses every new
  // permit until the clearing procedure the design defines has run.
  isClockPoisoned() {
    return CLOCK_POISONED_DOMAINS.has(this.#pinDir) || this.#readState().clock_poisoned;
  }

  setClockPoisoned(poisoned) {
    if (typeof poisoned !== "boolean") fail("ERR_PERMIT_INPUT_INVALID");
    return this.criticalSection(() => {
      const state = this.#readState();
      state.clock_poisoned = poisoned;
      writeState(this.#pinDir, state);
      return { clockPoisoned: state.clock_poisoned };
    });
  }

  // The batch identity of a registered pin, for the reconnect comparison.
  // An unregistered or unreadable pin yields null, which the reconnect
  // logic treats as undecidable -- and undecidable means the route stops.
  batchIdentityFor(fingerprint) {
    const pin = findPin(this.#readState(), fingerprint);
    if (!pin) return null;
    return {
      decision_id: pin.decision_id,
      instance_id: pin.instance_id,
      fingerprint: pin.fingerprint,
    };
  }
}

module.exports = {
  ProtectedPinStore,
  STATE_FILE,
  DOMAIN_MARKER_FILE,
  LEGACY_LOCK_FILE,
  STATE_SCHEMA_VERSION,
  BATCH_IDENTITY_FIELDS,
  REGISTRATION_CARRIED_FIELDS,
  publicKeyFingerprint,
  sameBatchIdentity,
};
