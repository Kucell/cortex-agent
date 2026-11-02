"use strict";

// CANDIDATE bootstrap protocol. NOT an authority, NOT production wiring.
//
// The current `initialize` path creates the business database and writes its
// first state BEFORE it publishes anything into the anchor domain. A crash in
// that window leaves a database that exists but was never bound to an anchor
// record, and the next open cannot tell a fresh domain from a half-built one.
//
// This module implements the ordering the publication proposal requires
// (section 4.1): a bootstrap registration is persisted BEFORE the first side
// effect of the bootstrap, and it is only retired after the database and the
// first anchor records are confirmed. A bootstrap identity is separate from
// the ordinary owner generation, so a bootstrap cannot be mistaken for a
// normal transaction.
//
// The registration lives in the anchor domain. That is a deliberate,
// bounded limitation, and it is why this module cannot claim the independent
// control domain of proposal section 4.3: the anchor domain and the business
// database are separated by `assertSeparateDomains`, but they are not proven
// to have independent rollback domains. The registration is a
// *bootstrap-ordering* guarantee, not an anti-rollback guarantee.
//
// Concurrency: all claim mutations share an exclusive directory name in the
// protected anchor domain. It is not stolen after a crash: uncertainty blocks
// further writes until administrative recovery proves the old owner drained.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const anchor = require("./protected-anchor");

// The single active claim and the common exclusion name for its writers.
const CLAIM_FILE = "protected-bootstrap-claim.json";
const MUTATION_LOCK = "protected-bootstrap-mutation.lock";
const COMPLETE_PREFIX = "protected-bootstrap-complete-";
const BOOTSTRAP_SCHEMA_VERSION = 1;
const MAX_BOOTSTRAP_BYTES = 64 * 1024;

// The phases of a bootstrap claim.
//
// `registered` means the claim was written and no object of the bootstrap
// was observed yet. `publishing` means the bootstrap produced objects (the
// database and/or the anchor entries), so the bootstrap is no longer
// provably untouched and the claim must not be released. The distinction is
// what lets a failed bootstrap be classified without guessing: a claim in
// `registered` may be released when the observation proves emptiness, a
// claim in `publishing` may not. `settling` binds an accepted recovery plan
// to the original claim and the exact lock/database/evidence for replay.
const PHASES = Object.freeze({
  REGISTERED: "registered",
  PUBLISHING: "publishing",
  SETTLING: "settling",
  COMPLETE: "complete",
  RETIRED: "retired",
});

class BootstrapError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "BootstrapError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, details) { throw new BootstrapError(code, details); }

// The bootstrap identity is fixed for one bootstrap attempt and never reused.
// It is generated before any side effect so the registration can name the
// exact object that will be created.
function newBootstrapId() {
  return crypto.randomBytes(16).toString("hex");
}

// The plan names what the bootstrap will create. The expected store identity
// and the expected body digest are part of the plan: without them a
// recovering process could not tell whether the object it finds is the one
// this bootstrap was supposed to create.
function bootstrapPlan(input) {
  if (!input || typeof input !== "object") fail("ERR_BOOTSTRAP_INPUT");
  const { bootstrap_id, domain, store_id, body_digest, sequence, attempt, database_path, owner } = input;
  if (typeof bootstrap_id !== "string" || !/^[a-f0-9]{32}$/.test(bootstrap_id)) fail("ERR_BOOTSTRAP_INPUT");
  if (typeof domain !== "string" || domain.length === 0 || domain.length > 128) fail("ERR_BOOTSTRAP_INPUT");
  if (typeof store_id !== "string" || store_id.length === 0 || store_id.length > 128) fail("ERR_BOOTSTRAP_INPUT");
  if (typeof body_digest !== "string" || !/^[a-f0-9]{64}$/.test(body_digest)) fail("ERR_BOOTSTRAP_INPUT");
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail("ERR_BOOTSTRAP_INPUT");
  if (!Number.isSafeInteger(attempt) || attempt < 1) fail("ERR_BOOTSTRAP_INPUT");
  // The database path is part of the plan because the release decision is
  // made by observing that path. Without it the module could not tell an
  // untouched domain from one whose database already exists.
  if (typeof database_path !== "string" || database_path.length === 0 || database_path.length > 1024) {
    fail("ERR_BOOTSTRAP_INPUT");
  }
  // The bootstrap registration names the owner and the fence that hold the
  // domain while the bootstrap runs. Without them a registration cannot say
  // WHO is bootstrapping, so a later bootstrap could not tell whether it is
  // continuing the same attempt or taking over from an owner that is no
  // longer entitled to the domain.
  const bound = bootstrapOwner(owner);
  return Object.freeze({ bootstrap_id, domain, store_id, body_digest, sequence, attempt, database_path, owner: bound });
}

// The owner binding of a bootstrap: the identity, the generation that owns
// the domain and the fence that proves the owner is still current. The
// fields are validated the same way the control ledger validates them, so
// the two domains describe an owner in one way only.
function bootstrapOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ERR_BOOTSTRAP_INPUT");
  const { owner_id, owner_generation, fence } = value;
  if (typeof owner_id !== "string" || owner_id.length === 0 || owner_id.length > 128) fail("ERR_BOOTSTRAP_INPUT");
  if (!Number.isSafeInteger(owner_generation) || owner_generation < 1) fail("ERR_BOOTSTRAP_INPUT");
  if (!Number.isSafeInteger(fence) || fence < 1) fail("ERR_BOOTSTRAP_INPUT");
  return Object.freeze({ owner_id, owner_generation, fence });
}

function completeName(bootstrapId) {
  return `${COMPLETE_PREFIX}${bootstrapId}.json`;
}

function claimPath(anchorDir) {
  return path.join(anchor.anchorDirFor(anchorDir), CLAIM_FILE);
}

// Directory sync. The result is NOT swallowed: a registration whose name is
// not durable is not a registration, and continuing to write business objects
// after a failed barrier would turn a possibly-lost pending into a lost
// pending.
//
// The platform rule is the one the anchor domain already follows: a
// platform that cannot flush a directory is NOT silently downgraded to a
// best-effort sync. Windows cannot fsync a directory through Node (`EPERM`),
// and the native publication backend has no Node binding yet.
//
// Unsupported platforms refuse registration; native publication is required.
function syncDirectory(dir) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    fail("ERR_BOOTSTRAP_SYNC_UNSUPPORTED_PLATFORM");
  }
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
  } catch (error) {
    return { synced: false, code: error.code || "ERR_BOOTSTRAP_SYNC_FAILED" };
  }
  try {
    fs.fsyncSync(fd);
    return { synced: true, code: null };
  } catch (error) {
    return { synced: false, code: error.code || "ERR_BOOTSTRAP_SYNC_FAILED" };
  } finally {
    try { fs.closeSync(fd); } catch { /* the close error does not change the sync result */ }
  }
}

// Write the record into a temporary file and publish it with an exclusive
// link. `link` fails when the destination exists, so a claim can never be
// overwritten by a racing bootstrap, and a partially written claim can never
// be observed as a valid registration.
function writeExclusive(target, bytes) {
  if (bytes.length > MAX_BOOTSTRAP_BYTES) fail("ERR_BOOTSTRAP_LIMIT");
  const dir = path.dirname(target);
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  let handle;
  try {
    handle = fs.openSync(temp, "wx", 0o600);
    if (fs.writeSync(handle, bytes) !== bytes.length) fail("ERR_BOOTSTRAP_WRITE_INCOMPLETE");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    try {
      fs.linkSync(temp, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // EEXIST says nothing about a previous attempt's durability. Reflush
      // the actual destination and its name before reporting a durable retry.
      const current = fs.lstatSync(target);
      if (!current.isFile() || current.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
      const existing = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(existing);
        if (opened.dev !== current.dev || opened.ino !== current.ino) fail("ERR_BOOTSTRAP_CLAIM_CHANGED");
        fs.fsyncSync(existing);
      } finally { fs.closeSync(existing); }
      const after = fs.lstatSync(target);
      if (after.dev !== current.dev || after.ino !== current.ino) fail("ERR_BOOTSTRAP_CLAIM_CHANGED");
      const sync = syncDirectory(dir);
      if (!sync.synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
      fs.unlinkSync(temp);
      if (!syncDirectory(dir).synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
      return { created: false, synced: true, temp: null };
    }
    const sync = syncDirectory(dir);
    if (!sync.synced) {
      // The name is published but the directory entry may not be durable. The
      // registration is reported as unknown rather than as registered, and the
      // caller must not continue writing business objects.
      return { created: true, synced: false, syncCode: sync.code, temp };
    }
    // The published name is durable and carries the same bytes, so the
    // temporary file is redundant once the link and the directory sync have
    // succeeded. It is removed here for two reasons: a leftover temporary
    // file would make a cleanly released domain look occupied, and the
    // bootstrap observation treats any unexpected object as a side effect.
    // The removal is a side effect of its own, so it is only done after the
    // published name is durable, and the directory is synced again.
    try { fs.unlinkSync(temp); }
    catch { /* the published name is already durable; the leftover is evidence, not a risk */ }
    const after = syncDirectory(dir);
    if (!after.synced) return { created: true, synced: false, syncCode: after.code, temp: null };
    return { created: true, synced: true, temp: null };
  } catch (error) {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* ignore */ } }
    if (error instanceof BootstrapError) throw error;
    fail("ERR_BOOTSTRAP_IO");
  }
}

function parseRecord(content, code) {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { fail(code); }
  if (!parsed || typeof parsed !== "object" || parsed.schema_version !== BOOTSTRAP_SCHEMA_VERSION) fail(code);
  let plan;
  try { plan = bootstrapPlan(parsed.plan); }
  catch { fail(code); }
  const phase = parsed.phase === undefined ? PHASES.REGISTERED : parsed.phase;
  if (!Object.values(PHASES).includes(phase)) fail(code);
  const recovery = parsed.recovery;
  if (phase === PHASES.SETTLING && (!recovery || typeof recovery !== "object" || Array.isArray(recovery) ||
      ["claim_identity", "lock_identity", "database_identity", "evidence_digest"].some(key =>
        typeof recovery[key] !== "string" || !recovery[key]) || !/^[a-f0-9]{64}$/.test(recovery.evidence_digest) ||
        !Number.isSafeInteger(parsed.at_ms) || parsed.at_ms < 0)) fail(code);
  return { plan, at_ms: parsed.at_ms, phase, recovery };
}

// Read the active claim. A missing claim means no bootstrap is in flight. A
// damaged claim is a blocking condition: it must not be skipped, because
// skipping it would let a newer bootstrap proceed on top of an unresolved
// earlier one.
function readClaim(anchorDir) {
  const target = claimPath(anchorDir);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    fail("ERR_BOOTSTRAP_UNREADABLE");
  }
  if (stat.isDirectory()) fail("ERR_UNSAFE_PATH");
  if (!stat.isFile() || stat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
  let content;
  try { content = fs.readFileSync(target, "utf8"); }
  catch { fail("ERR_BOOTSTRAP_UNREADABLE"); }
  const after = fs.lstatSync(target);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("ERR_BOOTSTRAP_CLAIM_CHANGED");
  const record = parseRecord(content, "ERR_BOOTSTRAP_CORRUPT");
  return { path: target, plan: record.plan, at_ms: record.at_ms, phase: record.phase, recovery: record.recovery,
    identity: `${stat.dev}:${stat.ino}:${crypto.createHash("sha256").update(content).digest("hex")}` };
}

// Enumerate the completed bootstraps of a domain. The completion files are
// the durable evidence that a bootstrap finished; they are never deleted.
function readCompletions(anchorDir) {
  const dir = anchor.anchorDirFor(anchorDir);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    fail("ERR_BOOTSTRAP_UNREADABLE");
  }
  const completed = [];
  for (const name of names.sort()) {
    if (!name.startsWith(COMPLETE_PREFIX)) continue;
    if (name.includes(".tmp-")) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(full); }
    catch { fail("ERR_BOOTSTRAP_UNREADABLE"); }
    if (stat.isDirectory()) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
    let content;
    try { content = fs.readFileSync(full, "utf8"); }
    catch { fail("ERR_BOOTSTRAP_UNREADABLE"); }
    const record = parseRecord(content, "ERR_BOOTSTRAP_CORRUPT");
    completed.push({ path: full, plan: record.plan, at_ms: record.at_ms, phase: record.phase });
  }
  return completed;
}

// Every claim writer uses this exclusive domain, including registration.
// It is never stolen based on age/PID. A crash leaves a blocking artifact.
// The locked facade lets settlement retain exclusivity across its lock drain
// and completion without allowing a second public mutation to re-enter.
function withBootstrapLock(anchorDir, action) {
  if (process.platform !== "darwin" && process.platform !== "linux") fail("ERR_BOOTSTRAP_SYNC_UNSUPPORTED_PLATFORM");
  const dir = anchor.anchorDirFor(anchorDir);
  require("./protected-store-lock").assertAnchorPathIsNotRedirected(dir);
  const lock = path.join(dir, MUTATION_LOCK);
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") fail("ERR_BOOTSTRAP_BUSY");
    fail("ERR_BOOTSTRAP_IO");
  }
  const held = fs.lstatSync(lock);
  function assertHeld() {
    const now = fs.lstatSync(lock);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== held.dev || now.ino !== held.ino) {
      fail("ERR_BOOTSTRAP_CLAIM_CHANGED");
    }
  }
  try {
    assertHeld();
    return action(Object.freeze({
      readClaim: () => { assertHeld(); return readClaim(dir); },
      classify: (plan) => { assertHeld(); return classifyFailedBootstrap(dir, plan); },
      advance: (plan, phase, options) => { assertHeld(); return advanceBootstrapPhaseLocked(dir, plan, phase, options); },
      complete: (plan, options) => { assertHeld(); return completeBootstrapLocked(dir, plan, options); },
      release: (plan, options) => { assertHeld(); return releaseUnattemptedBootstrapLocked(dir, plan, options); },
      inspectPublication: (key) => { assertHeld(); return inspectSettlementPublication(dir, readClaim(dir), key); },
      publishSettlement: (plan, key, bytes) => {
        assertHeld(); return publishSettlementLocked(dir, plan, key, bytes);
      },
    }));
  } finally {
    assertHeld();
    fs.rmdirSync(lock);
  }
}

function assertSameClaim(anchorDir, expected) {
  const current = readClaim(anchorDir);
  if (!current || current.identity !== expected.identity || !samePlan(current.plan, expected.plan)) {
    fail("ERR_BOOTSTRAP_CLAIM_CHANGED");
  }
}

// Register the bootstrap before any business side effect. The caller must
// invoke this before it creates the coordination file, the database, the
// anchor entries or the audit records.
function registerBootstrapLocked(anchorDir, planValue, options = {}) {
  const plan = bootstrapPlan(planValue);
  const at = Number.isSafeInteger(options.at_ms) ? options.at_ms : Date.now();
  const record = {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    plan,
    at_ms: at,
    // The registration states that nothing has been created yet. It is the
    // evidence that the ordering was respected, and it is what a recovering
    // process reads to decide that the domain may still be empty.
    phase: "registered",
  };
  const bytes = Buffer.from(JSON.stringify(record) + "\n");
  const target = claimPath(anchorDir);
  const written = writeExclusive(target, bytes);
  if (!written.created) {
    // Another bootstrap holds the claim. Only the same bootstrap may proceed;
    // a different one must not overwrite the winner's registration. The
    // comparison covers the WHOLE immutable plan, not only the identity: a
    // same-identity registration with a different store or digest would let a
    // recovery act on the wrong object.
    const existing = readClaim(anchorDir);
    if (!existing || !samePlan(existing.plan, plan)) fail("ERR_BOOTSTRAP_PENDING");
    return Object.freeze({ plan, path: target, phase: existing.phase, reused: true, durability: "durable" });
  }
  if (!written.synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
  return Object.freeze({ plan, path: target, phase: "registered", reused: false, durability: "durable" });
}

// Advance the phase of the active claim.
//
// The phase is advanced under the common exclusion domain by atomically
// replacing the claim (write/fsync a temporary file, then rename). It only
// succeeds when the claim still carries THIS plan and object identity: a claim that was replaced in the meantime is not
// touched, because advancing it would let this bootstrap mark a foreign
// claim as publishing.
//
// The phase may only move forward. A claim that was already retired cannot
// be advanced again, and a publishing claim cannot go back to registered,
// because the phase is the record of what the bootstrap already did.
function advanceBootstrapPhaseLocked(anchorDir, planValue, phase, options = {}) {
  const plan = bootstrapPlan(planValue);
  if (!Object.values(PHASES).includes(phase)) fail("ERR_BOOTSTRAP_INPUT");
  const at = Number.isSafeInteger(options.at_ms) ? options.at_ms : Date.now();
  const dir = anchor.anchorDirFor(anchorDir);
  const target = claimPath(anchorDir);
  const current = readClaim(anchorDir);
  if (!current) fail("ERR_BOOTSTRAP_NOT_PENDING");
  if (!samePlan(current.plan, plan)) fail("ERR_BOOTSTRAP_PENDING");
  const order = [PHASES.REGISTERED, PHASES.PUBLISHING, PHASES.SETTLING, PHASES.COMPLETE, PHASES.RETIRED];
  if (order.indexOf(phase) <= order.indexOf(current.phase)) {
    // Advancing to the phase the claim already carries is idempotent, so a
    // retry of the same step does not fail. Moving backwards is refused.
    if (phase === current.phase) {
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      assertSameClaim(anchorDir, current);
      if (!syncDirectory(dir).synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
      return Object.freeze({ plan, path: target, phase: current.phase, durability: "durable" });
    }
    fail("ERR_BOOTSTRAP_PHASE_INVALID");
  }
  const record = {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    plan,
    at_ms: at,
    phase,
    ...(phase === PHASES.SETTLING ? { recovery: options.recovery || current.recovery } : {}),
  };
  parseRecord(JSON.stringify(record), "ERR_BOOTSTRAP_INPUT");
  return replaceClaimRecord(dir, current, record);
}

function replaceClaimRecord(dir, current, record) {
  const target = claimPath(dir);
  const bytes = Buffer.from(JSON.stringify(record) + "\n");
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  let handle;
  try {
    handle = fs.openSync(temp, "wx", 0o600);
    if (fs.writeSync(handle, bytes) !== bytes.length) fail("ERR_BOOTSTRAP_WRITE_INCOMPLETE");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    assertSameClaim(dir, current);
    const published = fs.lstatSync(temp);
    fs.renameSync(temp, target);
    const after = fs.lstatSync(target);
    if (after.dev !== published.dev || after.ino !== published.ino) fail("ERR_BOOTSTRAP_CLAIM_CHANGED");
  } catch (error) {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* ignore */ } }
    if (error instanceof BootstrapError) throw error;
    fail("ERR_BOOTSTRAP_IO");
  }
  const sync = syncDirectory(dir);
  if (!sync.synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
  return Object.freeze({ plan: record.plan, path: target, phase: record.phase, durability: "durable" });
}

const SETTLEMENT_TARGETS = Object.freeze({
  "high-water": anchor.HIGH_WATER_FILE,
  "audit-attempt": "protected-anchor-recovery.log",
  "audit-final": "protected-anchor-recovery.log",
});

// A settlement owns an interrupted object only if its inode AND exact expected
// bytes were durably bound to the settling claim before the first data write.
// Partial bytes are confined to that temporary inode, never the public log.
function readPublicationObject(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("ERR_UNSAFE_PATH");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
    return { object: `${stat.dev}:${stat.ino}`, hex: bytes.toString("hex") };
  } finally { fs.closeSync(fd); }
}

function publicationFor(claim, key) {
  const publication = claim?.recovery?.publications?.[key];
  if (!publication) return null;
  const prefix = `${SETTLEMENT_TARGETS[key]}.tmp-bootstrap-${claim.plan.bootstrap_id}-${key}-`;
  if (!SETTLEMENT_TARGETS[key] || publication.target !== SETTLEMENT_TARGETS[key] ||
      typeof publication.temporary !== "string" || !publication.temporary.startsWith(prefix) ||
      !/^[a-f0-9]{24}$/.test(publication.temporary.slice(prefix.length)) ||
      typeof publication.object !== "string" || !/^\d+:\d+$/.test(publication.object) ||
      typeof publication.hex !== "string" || !/^(?:[a-f0-9]{2})+$/.test(publication.hex) ||
      (publication.previous !== null && (!publication.previous ||
        typeof publication.previous.object !== "string" || !/^\d+:\d+$/.test(publication.previous.object) ||
        typeof publication.previous.hex !== "string" || !/^(?:[a-f0-9]{2})*$/.test(publication.previous.hex)))) {
    fail("ERR_BOOTSTRAP_PUBLICATION_UNKNOWN");
  }
  return publication;
}

function inspectSettlementPublication(dir, claim, key) {
  const publication = publicationFor(claim, key);
  if (!publication) return null;
  if (claim.phase !== PHASES.SETTLING) fail("ERR_BOOTSTRAP_PUBLICATION_UNKNOWN");
  const temporary = readPublicationObject(path.join(dir, publication.temporary));
  const target = readPublicationObject(path.join(dir, publication.target));
  if (temporary && (temporary.object !== publication.object || !publication.hex.startsWith(temporary.hex))) {
    fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  const published = target?.object === publication.object && target.hex === publication.hex;
  // rename consumes the temporary name. A missing object or a changed target
  // is never interpreted as permission to recreate/overwrite unknown evidence.
  if (published ? temporary !== null : !temporary || JSON.stringify(target) !== JSON.stringify(publication.previous)) {
    fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  return { ...publication, published };
}

function publishSettlementLocked(dir, planValue, key, bytes) {
  const plan = bootstrapPlan(planValue);
  let current = readClaim(dir);
  if (!current || !samePlan(current.plan, plan)) fail("ERR_BOOTSTRAP_PENDING");
  if (current.phase !== PHASES.SETTLING || !SETTLEMENT_TARGETS[key] || !Buffer.isBuffer(bytes)) fail("ERR_BOOTSTRAP_INPUT");
  const known = Object.keys(SETTLEMENT_TARGETS).map(name => publicationFor(current, name)?.temporary);
  for (const name of fs.readdirSync(dir)) {
    if (Object.values(SETTLEMENT_TARGETS).some(target => name.startsWith(target + ".tmp-")) && !known.includes(name)) {
      fail("ERR_BOOTSTRAP_PUBLICATION_UNKNOWN");
    }
  }
  let publication = publicationFor(current, key);
  if (publication && publication.hex !== (publication.previous?.hex || "") + bytes.toString("hex")) {
    fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  // The final audit snapshot contains the already published attempt snapshot.
  // A replay after final publication must not roll the log back to the attempt.
  if (key === "audit-attempt" && publicationFor(current, "audit-final")) {
    const final = inspectSettlementPublication(dir, current, "audit-final");
    if (final.published) return current;
  }
  if (!publication) {
    const target = SETTLEMENT_TARGETS[key];
    const previous = readPublicationObject(path.join(dir, target));
    if (key === "high-water" && previous) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
    if (previous) {
      const text = Buffer.from(previous.hex, "hex").toString("utf8");
      if (text && !text.endsWith("\n")) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
      for (const line of text.split("\n").filter(Boolean)) {
        try { JSON.parse(line); } catch { fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED"); }
      }
    }
    const hex = (previous?.hex || "") + bytes.toString("hex");
    const temporary = `${target}.tmp-bootstrap-${plan.bootstrap_id}-${key}-${crypto.randomBytes(12).toString("hex")}`;
    const temp = path.join(dir, temporary);
    const fd = fs.openSync(temp, "wx", 0o600);
    const opened = fs.fstatSync(fd);
    publication = { target, temporary, object: `${opened.dev}:${opened.ino}`, hex, previous };
    try {
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (!syncDirectory(dir).synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
      replaceClaimRecord(dir, current, { schema_version: BOOTSTRAP_SCHEMA_VERSION,
        plan: current.plan, phase: current.phase, at_ms: current.at_ms,
        recovery: { ...current.recovery, publications: { ...current.recovery.publications, [key]: publication } } });
    } catch (error) {
      // An exception before claim publication may remove only our own empty,
      // unbound inode. A published descriptor is retained for exact replay.
      const latest = readClaim(dir);
      const unbound = readPublicationObject(temp);
      if (!publicationFor(latest, key) && unbound?.object === publication.object && unbound.hex === "") fs.unlinkSync(temp);
      throw error;
    }
    current = readClaim(dir);
  }
  let state = inspectSettlementPublication(dir, current, key);
  const file = path.join(dir, state.published ? state.target : state.temporary);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (`${opened.dev}:${opened.ino}` !== state.object) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
    if (!state.published) {
      const existing = Buffer.alloc(fs.fstatSync(fd).size), expected = Buffer.from(state.hex, "hex");
      if (fs.readSync(fd, existing, 0, existing.length, 0) !== existing.length) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
      if (!expected.subarray(0, existing.length).equals(existing)) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
      const remainder = expected.subarray(existing.length);
      if (remainder.length && fs.writeSync(fd, remainder, 0, remainder.length, existing.length) !== remainder.length) {
        fail("ERR_BOOTSTRAP_WRITE_INCOMPLETE");
      }
      const written = Buffer.alloc(fs.fstatSync(fd).size);
      if (fs.readSync(fd, written, 0, written.length, 0) !== written.length || !written.equals(expected)) {
        fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
      }
    }
    fs.fsyncSync(fd);
    assertSameClaim(dir, current);
    state = inspectSettlementPublication(dir, current, key);
    if (!state.published) fs.renameSync(path.join(dir, state.temporary), path.join(dir, state.target));
    if (!inspectSettlementPublication(dir, current, key).published) fail("ERR_BOOTSTRAP_EVIDENCE_CHANGED");
    if (!syncDirectory(dir).synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
  } finally { fs.closeSync(fd); }
  return current;
}

// Two plans are the same only when every immutable field matches. The
// bootstrap identity alone is not enough: a retry must describe the same
// store, the same body digest and the same sequence.
function samePlan(left, right) {
  return left.bootstrap_id === right.bootstrap_id &&
    left.domain === right.domain &&
    left.store_id === right.store_id &&
    left.body_digest === right.body_digest &&
    left.sequence === right.sequence &&
    left.attempt === right.attempt &&
    left.database_path === right.database_path &&
    left.owner.owner_id === right.owner.owner_id &&
    left.owner.owner_generation === right.owner.owner_generation &&
    left.owner.fence === right.owner.fence;
}

// Retire the bootstrap after the database and the first anchor records are
// confirmed. The completion file is the evidence that the bootstrap
// happened; it is never deleted, and the claim name becomes free for a later
// bootstrap.
function completeBootstrapLocked(anchorDir, planValue, options = {}) {
  const plan = bootstrapPlan(planValue);
  const current = readClaim(anchorDir);
  if (!current) fail("ERR_BOOTSTRAP_NOT_PENDING");
  if (!samePlan(current.plan, plan)) fail("ERR_BOOTSTRAP_PENDING");
  if (![PHASES.REGISTERED, PHASES.PUBLISHING, PHASES.SETTLING, PHASES.COMPLETE].includes(current.phase)) fail("ERR_BOOTSTRAP_PHASE_INVALID");
  const at = Number.isSafeInteger(options.at_ms) ? options.at_ms : Date.now();
  const record = {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    plan,
    at_ms: at,
    phase: "complete",
  };
  const bytes = Buffer.from(JSON.stringify(record) + "\n");
  const dir = anchor.anchorDirFor(anchorDir);
  const target = path.join(dir, completeName(plan.bootstrap_id));
  const written = writeExclusive(target, bytes);
  if (!written.created) {
    // An existing completion with different bytes is a conflict.
    const existing = fs.readFileSync(target);
    if (!existing.equals(bytes)) fail("ERR_BOOTSTRAP_CONFLICT");
  }
  if (!written.synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
  // The same claim object must still be current after publishing completion.
  assertSameClaim(anchorDir, current);
  fs.unlinkSync(current.path);
  const sync = syncDirectory(dir);
  if (!sync.synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
  return Object.freeze({ plan, path: target, phase: "complete",
    durability: "durable" });
}

// The state a recovering process sees. It distinguishes an empty domain from
// a domain with an unresolved bootstrap, and it never decides that a
// bootstrap succeeded on its own.
function bootstrapState(anchorDir) {
  const claim = readClaim(anchorDir);
  const completed = readCompletions(anchorDir);
  return Object.freeze({
    empty: claim === null && completed.length === 0,
    // The pending entry carries the phase of the claim as well as its plan:
    // the phase is what tells a recovering process whether the bootstrap may
    // still be released (registered) or produced objects already (publishing).
    pending: Object.freeze(claim ? [{ ...claim.plan, phase: claim.phase }] : []),
    completed: Object.freeze(completed.map((entry) => entry.plan)),
    // The phase of the active claim, or null when there is none.
    phase: claim === null ? null : claim.phase,
    // A claim means the domain is not empty in the sense that matters: a
    // bootstrap was started and its outcome is not settled. Recovery must not
    // treat this as an uninitialised domain.
    started: claim !== null || completed.length > 0,
  });
}

// Assert that the domain may start a new bootstrap. An unresolved claim
// blocks it: the earlier bootstrap may have created objects that this process
// cannot see, and overwriting them would destroy the evidence.
function assertBootstrapAllowed(anchorDir, planValue) {
  const plan = bootstrapPlan(planValue);
  const state = bootstrapState(anchorDir);
  if (state.pending.length > 0) {
    const existing = state.pending[0];
    // The same bootstrap may be re-asserted (an idempotent retry of the
    // registration itself), but a different bootstrap may not start.
    if (existing.bootstrap_id !== plan.bootstrap_id) fail("ERR_BOOTSTRAP_PENDING");
  }
  return state;
}

// Classify a failed bootstrap that already entered the `publishing` phase.
//
// The function never decides on its own that the bootstrap succeeded. It
// reports what the evidence shows, and it distinguishes the two outcomes
// that matter:
//
// - `objects-present`: the database and/or the anchor entries exist. The
//   bootstrap DID produce objects, so the domain must be settled by a
//   forward recovery, not by a retry.
// - `no-objects`: nothing of the bootstrap exists. The bootstrap can be
//   released and retried.
//
// The evidence is what the module itself observes. A caller may add its own
// observation, but it cannot replace this one.
function classifyFailedBootstrap(anchorDir, planValue) {
  const plan = bootstrapPlan(planValue);
  const claim = readClaim(anchorDir);
  if (!claim) fail("ERR_BOOTSTRAP_NOT_PENDING");
  if (!samePlan(claim.plan, plan)) fail("ERR_BOOTSTRAP_PENDING");
  const observed = observeBootstrapSideEffects(anchorDir, plan, claim);
  return Object.freeze({
    plan,
    phase: claim.phase,
    // A claim that never entered the publishing phase produced no object by
    // construction: the phase is advanced before the first side effect.
    settled: claim.phase === PHASES.REGISTERED || observed.clean,
    clean: observed.clean,
    reason: observed.reason,
    candidate: observed.candidate,
  });
}

// Release a claim that provably never produced a side effect.
//
// This is NOT an automatic abort and it is NOT a caller-supplied boolean.
// A caller that returns `true` from its own probe proves nothing: it could
// simply return true. The release is therefore decided from observations the
// module makes itself:
//
// - the claim must still carry exactly this plan (a replaced claim is not
//   touched),
// - the database path, its SQLite sidecars and the anchor domain must hold
//   no object of this bootstrap,
// - the observation and the removal happen under the same exclusive claim.
//
// If the observations cannot prove that nothing happened, the claim stays
// and the domain stays blocked.
function releaseUnattemptedBootstrapLocked(anchorDir, planValue, options = {}) {
  const plan = bootstrapPlan(planValue);
  const claim = readClaim(anchorDir);
  if (!claim) fail("ERR_BOOTSTRAP_NOT_PENDING");
  if (!samePlan(claim.plan, plan)) fail("ERR_BOOTSTRAP_PENDING");
  // The observation is made by the module. The caller may only ADD evidence
  // through a check that returns a boolean about a named object; it cannot
  // replace the observation.
  const observer = options.observe;
  if (observer !== undefined && typeof observer !== "function") fail("ERR_BOOTSTRAP_INPUT");
  const observed = observeBootstrapSideEffects(anchorDir, plan, claim);
  if (!observed.clean) fail("ERR_BOOTSTRAP_NOT_UNATTEMPTED");
  if (typeof observer === "function") {
    let extra;
    try { extra = observer(observed); }
    catch { fail("ERR_BOOTSTRAP_INPUT"); }
    if (extra !== true) fail("ERR_BOOTSTRAP_NOT_UNATTEMPTED");
  }
  if (!observeBootstrapSideEffects(anchorDir, plan, claim).clean) fail("ERR_BOOTSTRAP_NOT_UNATTEMPTED");
  const dir = anchor.anchorDirFor(anchorDir);
  // Re-read the claim immediately before the removal and compare the whole
  // plan again, so a claim that was replaced in the meantime is not removed.
  assertSameClaim(anchorDir, claim);
  // Only redundant registration artifacts with the exact claim bytes are
  // removable. A foreign/partial temp remains evidence and blocks release.
  const claimBytes = fs.readFileSync(claim.path);
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${CLAIM_FILE}.tmp-`)) continue;
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(full).equals(claimBytes)) {
      fail("ERR_BOOTSTRAP_NOT_UNATTEMPTED");
    }
    assertSameClaim(anchorDir, claim);
    const current = fs.lstatSync(full);
    if (current.dev !== stat.dev || current.ino !== stat.ino) fail("ERR_BOOTSTRAP_CLAIM_CHANGED");
    fs.unlinkSync(full);
  }
  assertSameClaim(anchorDir, claim);
  fs.unlinkSync(claim.path);
  const sync = syncDirectory(dir);
  if (!sync.synced) fail("ERR_BOOTSTRAP_SYNC_FAILED");
  return Object.freeze({ plan, released: true, durability: "durable" });
}

// Observe whether the bootstrap produced any object. The anchor domain must
// hold nothing but the claim itself, and the database path must not exist.
// The observation is a point-in-time view; it is not a proof that nothing
// ever happened, which is why the claim is only released for a registration
// that was made before the first side effect.
function observeBootstrapSideEffects(anchorDir, plan, claim) {
  const dir = anchor.anchorDirFor(anchorDir);
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return { clean: false, reason: "anchor-unreadable" }; }
  for (const name of names) {
    if (name === CLAIM_FILE || name === MUTATION_LOCK) continue;
    // A temporary file is evidence of an attempted write, so it is not
    // ignored. The one exception is the temporary file of THIS claim: it
    // carries the same bytes as the published claim and is the artifact of
    // this registration's own write, not a foreign object.
    if (name.startsWith(`${CLAIM_FILE}.tmp-`)) {
      let content;
      try { content = fs.readFileSync(path.join(dir, name)); }
      catch { return { clean: false, reason: "anchor-unreadable", name }; }
      let expected;
      try { expected = fs.readFileSync(claim.path); }
      catch { return { clean: false, reason: "anchor-unreadable", name }; }
      if (!content.equals(expected)) return { clean: false, reason: "anchor-object-present", name };
      continue;
    }
    return { clean: false, reason: "anchor-object-present", name };
  }
  const databasePath = options_databasePath(plan);
  if (databasePath) {
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
      try {
        fs.lstatSync(candidate);
        return { clean: false, reason: "database-object-present", candidate };
      } catch (error) {
        // ENOENT is the only accepted answer. Anything else (a permission
        // error, a dangling link reported as EACCES) is not proof of absence.
        if (error.code !== "ENOENT") return { clean: false, reason: "database-unverifiable", candidate };
      }
    }
  }
  return { clean: true, reason: null };
}

function options_databasePath(plan) {
  return plan && plan.database_path ? plan.database_path : null;
}

function registerBootstrap(dir, plan, options) {
  return withBootstrapLock(dir, () => registerBootstrapLocked(dir, plan, options));
}
function advanceBootstrapPhase(dir, plan, phase, options) {
  return withBootstrapLock(dir, () => advanceBootstrapPhaseLocked(dir, plan, phase, options));
}
function completeBootstrap(dir, plan, options) {
  return withBootstrapLock(dir, (locked) => locked.complete(plan, options));
}
function releaseUnattemptedBootstrap(dir, plan, options) {
  return withBootstrapLock(dir, (locked) => locked.release(plan, options));
}

module.exports = {
  withBootstrapLock,
  CLAIM_FILE,
  COMPLETE_PREFIX,
  BOOTSTRAP_SCHEMA_VERSION,
  PHASES,
  BootstrapError,
  newBootstrapId,
  bootstrapPlan,
  registerBootstrap,
  advanceBootstrapPhase,
  completeBootstrap,
  bootstrapState,
  assertBootstrapAllowed,
  classifyFailedBootstrap,
  releaseUnattemptedBootstrap,
};
