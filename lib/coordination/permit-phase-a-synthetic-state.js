"use strict";

// PURELY SYNTHETIC / NO AUTHORITY / NO EXECUTION.
// R2 transaction-boundary model only. No store/provider/signing/IPC imports.
// Synchronous steps simulate serial ordering; neither JS memory nor exported
// event images prove fsync, OS identity, distributed CAS, freshness or recovery.
// Inputs must be inert local data, never arbitrary untrusted JS code. Proxies,
// accessors and exotic objects are rejected without invoking their hooks.
// One instance models one fixed target with controlled global binding advances,
// not multiple concurrent live owners or authenticated control-plane writers.
// Its checkpoint hashes only the synthetic business baseline below, NOT a
// production checkpoint or the attempt/event ledger. Both lanes are fixtures:
// consumption-fixture starts from an assumed baseline; registration-only can
// never activate or be promoted into consumption-fixture.
// Limits bound retained records/serialized images, not V8 RSS or allocations
// already made by callers. Crash replay assumes the old instance is abandoned;
// it cannot fence another JS instance, authenticate images or prevent rollback.
const crypto = require("node:crypto");
const { types: { isProxy } } = require("node:util");
const LIMITS = Object.freeze({ attempts: 8, events: 128, imageBytes: 131072, revoked: 32 });
const machines = new WeakMap(), handles = new WeakMap();
const FLAGS = Object.freeze({ mode: "purely-synthetic", authority: false, executionAuthorized: false,
  osIdentity: false, durable: false, crossMachine: false });
// Pure simulator command-replay semantics, NOT a product/schema version or an
// automatic upgrade protocol. v1 lacked separate clocks/control versions; v2
// predates atomic retention of a legal safety increment alongside clock failure.
// Replaying either under v3 would reinterpret history, so reject, never migrate.
const FORMAT = 3;
class SyntheticStateError extends Error {
  constructor(code) { super("ERR_SYNTHETIC_" + code); this.name = "SyntheticStateError"; this.code = "ERR_SYNTHETIC_" + code; }
}
function fail(code) { throw new SyntheticStateError(code); }
function record(value, keys) {
  if (!value || typeof value !== "object" || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) fail("INPUT");
  const out = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (!d || !Object.hasOwn(d, "value") || !d.enumerable) fail("INPUT");
    Object.defineProperty(out, key, { value: d.value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
function text(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) fail("INPUT"); return value; }
function integer(value, min = 0) { if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min) fail("INPUT"); return value; }
function hash(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("INPUT"); return value; }
function next(value) { if (value === Number.MAX_SAFE_INTEGER) fail("OVERFLOW"); return value + 1; }
function list(value, validate, limit) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit) fail("INPUT");
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(d).length !== value.length + 1) fail("INPUT");
  const out = [];
  for (let i = 0; i < value.length; i++) {
    if (!d[i] || !Object.hasOwn(d[i], "value") || !d[i].enumerable) fail("INPUT");
    out.push(validate(d[i].value));
  }
  return out;
}
function sortedHashes(value) {
  const out = list(value, hash, LIMITS.revoked);
  if (out.some((s, i) => i && out[i - 1] >= s)) fail("INPUT");
  return out;
}
function copy(value) { return JSON.parse(JSON.stringify(value)); } // internal validated data only
function freeze(value) { if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
function digest(value) { return crypto.createHash("sha256").update("permit-phase-a-purely-synthetic-v1\n" + JSON.stringify(value)).digest("hex"); }
const CP = ["authorityId", "targetId", "storeGeneration", "revision", "digest"];
function checkpoint(value) {
  const cp = record(value, CP);
  text(cp.authorityId); text(cp.targetId); text(cp.storeGeneration); integer(cp.revision, 1); hash(cp.digest);
  return cp;
}
const CONFIG = ["mode", "lane", "authorityId", "targetId", "storeGeneration", "runGeneration",
  "ownerIncarnation", "ownerVersion", "grantId", "grantVersion", "lifecycleVersion"];
function config(value) {
  const c = record(value, CONFIG);
  if (c.mode !== FLAGS.mode || !["registration-only", "consumption-fixture"].includes(c.lane)) fail("INPUT");
  for (const name of CONFIG.filter(k => !["mode", "lane", "ownerVersion", "grantVersion", "lifecycleVersion"].includes(k))) text(c[name]);
  for (const name of ["ownerVersion", "grantVersion", "lifecycleVersion"]) integer(c[name], 1);
  return c;
}
const REQUEST = ["attemptId", "kind", "checkpoint", "principal", "requestDigest", "runGeneration",
  "ownerIncarnation", "ownerVersion", "grantId", "grantVersion", "lifecycleVersion",
  "monotonicDeadline", "wallClockDeadline", "permitId", "fingerprint"];
function request(value) {
  const r = record(value, REQUEST);
  if (!["register", "consume"].includes(r.kind)) fail("INPUT");
  for (const k of ["attemptId", "principal", "runGeneration", "ownerIncarnation", "grantId"]) text(r[k]);
  for (const k of ["ownerVersion", "grantVersion", "lifecycleVersion", "monotonicDeadline", "wallClockDeadline"]) integer(r[k], 1);
  hash(r.requestDigest); r.checkpoint = checkpoint(r.checkpoint);
  if (r.kind === "register") { if (r.permitId !== null || r.fingerprint !== null) fail("INPUT"); }
  else { text(r.permitId); hash(r.fingerprint); }
  return r;
}
function observation(value) {
  const o = record(value, ["sequence", "previous", "revoked", "clockPoisoned"]);
  integer(o.sequence, 1); integer(o.previous); o.revoked = sortedHashes(o.revoked);
  if (typeof o.clockPoisoned !== "boolean") fail("INPUT"); return o;
}
function stateOf(machine) { const m = machines.get(machine); if (!m || m.closed) fail("CLOSED"); return m; }
function attempt(m, id, version) {
  text(id); integer(version, 1); const a = m.attempts.find(a => a.request.attemptId === id);
  if (!a) fail("ATTEMPT"); if (a.version !== version) fail("CAS"); return a;
}
function mark(a) { a.version = next(a.version); }
function current(m) {
  return { authorityId: m.config.authorityId, targetId: m.config.targetId, storeGeneration: m.config.storeGeneration,
    revision: m.revision, digest: digest({ config: m.config, control: m.control, sequence: m.sequence, revoked: m.revoked,
      clockPoisoned: m.clockPoisoned, consumed: m.consumed, registrations: m.registrations }) };
}
const BINDING = ["ownerIncarnation", "ownerVersion", "grantId", "grantVersion", "lifecycleVersion"];
function bindingFailure(m, r) {
  if (["owner", "grant", "lifecycle"].some(axis => m.control[axis + "Revoked"])) return "CONTROL_REVOKED";
  if (r.runGeneration !== m.config.runGeneration || BINDING.some(k => r[k] !== m.control[k])) return "BINDING";
  return null;
}
function invalidateAttempt(a, reason) {
  if (a.invalidation) return;
  a.invalidation = reason;
  if (["admitted", "reserved"].includes(a.status)) terminal(a, "invalidated", reason);
  else {
    if (["pending", "pending-registration"].includes(a.clientOutcome)) a.clientOutcome = "unknown";
    if (!a.reason) a.reason = reason; mark(a);
  }
}
function clocks(value) {
  const c = record(value, ["monotonicNow", "wallClockNow"]);
  integer(c.monotonicNow); integer(c.wallClockNow); return c;
}
// Samples are controlled fixtures, NOT actual trusted time. Monotonic time is
// process-epoch local; a backwards sample invalidates this attempt, not the
// wall-clock domain. Wall time has a replayed high-water; rollback latches a
// safety fact even when business/observation validation would otherwise fail.
function sampleClocks(m, c) {
  const monoBack = c.monotonicNow < m.monotonicNow;
  const wallBack = c.wallClockNow < m.wallClockHighWater;
  m.monotonicNow = Math.max(m.monotonicNow, c.monotonicNow);
  m.wallClockHighWater = Math.max(m.wallClockHighWater, c.wallClockNow);
  if (wallBack) m.clockPoisoned = true;
  return wallBack ? "WALL_CLOCK_ROLLBACK" : monoBack ? "MONOTONIC_ROLLBACK" : m.clockPoisoned ? "CLOCK_POISONED" : null;
}
function deadlineFailure(r, c) {
  return c.monotonicNow >= r.monotonicDeadline ? "MONOTONIC_DEADLINE" :
    c.wallClockNow >= r.wallClockDeadline ? "WALL_CLOCK_DEADLINE" : null;
}
// Independent chain validation: never let an invalid suffix suppress a clock
// safety fact, nor trust its revoked/clockPoisoned fields. This is only fixture
// consistency, not source authentication or a real freshness proof.
function validNextSafety(m, o) {
  return !!o && m.sequence < Number.MAX_SAFE_INTEGER && o.previous === m.sequence &&
    o.sequence === m.sequence + 1 && m.revoked.every(f => o.revoked.includes(f));
}
function mergeSafety(m, o) {
  m.sequence = o.sequence; m.revoked = o.revoked; m.clockPoisoned ||= o.clockPoisoned;
}
function rejectClock(m, a, reason, baseMatch, committing, o, poisonChanged) {
  const merge = a.request.kind === "consume" && validNextSafety(m, o);
  if (merge) mergeSafety(m, o);
  // One revision for the entire safety-only transition, including both the
  // legal next increment and independently observed wall rollback poison.
  if (merge || poisonChanged) m.revision = next(m.revision);
  if (!committing) terminal(a, "invalidated", reason);
  else {
    a.status = a.request.kind === "consume" ? "safety-only" : "rejected"; a.reason = reason;
    a.clientOutcome = a.cancelRequested || a.invalidation ? "unknown" : "rejected";
    a.commitOutcome = { baseMatch, status: a.status, checkpoint: current(m) }; mark(a);
  }
  a.staged = null; // no reusable observation/handle, reservation remains held
}
function sameCheckpoint(a, b) { return CP.every(k => a[k] === b[k]); }
function terminal(a, status, reason) {
  a.status = status; a.reason = reason; a.clientOutcome = status === "cancelled" ? "cancelled" : "unknown"; mark(a);
}

// All mutations run on a clone and publish once. Schema/CAS errors leave state
// unchanged; business rejection is data. In particular, clock rollback must
// publish its safety-only result/event, not throw and roll back the poison.
function apply(m, command) {
  const { type, data } = command;
  if (type === "advanceControl" || type === "revokeControl") {
    const { axis, expectedVersion } = data, key = axis + "Version";
    if (m.control[key] !== expectedVersion) fail("CAS");
    m.control[key] = next(m.control[key]);
    if (type === "advanceControl" && axis !== "lifecycle") {
      const history = m.control[axis + "History"];
      if (history.includes(data.identity)) fail("REPLAY");
      if (history.length === LIMITS.events) fail("LIMIT");
      history.push(data.identity);
      m.control[axis === "owner" ? "ownerIncarnation" : "grantId"] = data.identity;
    }
    m.control[axis + "Revoked"] = type === "revokeControl";
    for (const a of m.attempts) invalidateAttempt(a, type === "revokeControl" ? "CONTROL_REVOKED" : "CONTROL_CHANGED");
    m.revision = next(m.revision); return;
  }
  if (type === "admit") {
    const r = request(data);
    if ((r.kind === "register") !== (m.config.lane === "registration-only")) fail("LANE");
    if (m.attempts.length >= LIMITS.attempts) fail("LIMIT");
    if (m.attempts.some(a => a.request.attemptId === r.attemptId)) fail("REPLAY");
    if (m.clockPoisoned) fail("CLOCK_POISONED");
    if (r.monotonicDeadline <= m.monotonicNow) fail("MONOTONIC_DEADLINE");
    if (r.wallClockDeadline <= m.wallClockHighWater) fail("WALL_CLOCK_DEADLINE");
    // Fixed one-target model: wrong domain is input refusal, not a way to
    // inject safety facts into a different authority/store generation.
    const cp = current(m);
    if (["authorityId", "targetId", "storeGeneration"].some(k => r.checkpoint[k] !== cp[k])) fail("BINDING");
    const reason = bindingFailure(m, r); if (reason) fail(reason);
    m.attempts.push({ request: r, version: 1, status: "admitted", reservation: null, invalidation: null,
      cancelRequested: false, clientOutcome: "pending", commitOutcome: null, reason: null, staged: null });
    return;
  }
  if (type === "reserve") {
    const a = attempt(m, data.attemptId, data.version);
    if (a.status !== "admitted") fail("STATE");
    const reason = bindingFailure(m, a.request); if (reason) fail(reason);
    if (m.attempts.some(x => x.reservation && x.reservation.tokenId === data.tokenId)) fail("REPLAY");
    if (m.attempts.some(x => x !== a && x.reservation && x.reservation.held)) fail("RESERVATION");
    a.reservation = { tokenId: data.tokenId, held: true, tombstone: false }; a.status = "reserved"; mark(a); return;
  }
  if (type === "invalidate") {
    const a = m.attempts.find(a => a.reservation && a.reservation.tokenId === data.tokenId);
    if (!a) fail("TOKEN");
    invalidateAttempt(a, data.reason); // duplicate evidence cannot resurrect or release
    // No release evidence: invalidation retains the reservation, even pending.
    return;
  }
  if (type === "cancel") {
    const a = attempt(m, data.attemptId, data.version); a.cancelRequested = true;
    if (["admitted", "reserved"].includes(a.status)) {
      terminal(a, "cancelled", "CANCELLED");
      if (a.reservation) { a.reservation.held = false; a.reservation.tombstone = true; }
    } else if (a.status === "commit-possible") { a.clientOutcome = "unknown"; a.reason = "CANCEL_AFTER_BOUNDARY"; mark(a); }
    else if (["registration-pending", "consumed-synthetic", "safety-only", "rejected"].includes(a.status)) {
      if (["pending", "pending-registration"].includes(a.clientOutcome)) a.clientOutcome = "unknown";
      if (!a.reason) a.reason = "CANCEL_AFTER_COMMIT"; mark(a);
    } else fail("STATE");
    return;
  }
  if (type === "enter") {
    const a = attempt(m, data.attemptId, data.version);
    if (a.status !== "reserved" || a.invalidation) fail("STATE");
    if ((a.request.kind === "register") !== (data.observation === null)) fail("INPUT");
    const wasPoisoned = m.clockPoisoned;
    const clockReason = sampleClocks(m, data.clocks) || deadlineFailure(a.request, data.clocks);
    if (clockReason) {
      rejectClock(m, a, clockReason, false, false, data.observation, !wasPoisoned && m.clockPoisoned); return;
    }
    const reason = bindingFailure(m, a.request) || deadlineFailure(a.request, data.clocks);
    if (reason) {
      rejectClock(m, a, reason, false, false, data.observation, false); return;
    }
    a.status = "commit-possible"; a.staged = data.observation; mark(a); return;
  }
  if (type === "commit") {
    const a = m.attempts.find(a => a.request.attemptId === data.attemptId);
    if (!a || a.status !== "commit-possible") fail("STATE");
    // C0 comparison is fixed BEFORE this command's safety transition.
    const c0 = current(m), baseMatch = sameCheckpoint(a.request.checkpoint, c0);
    const wasPoisoned = m.clockPoisoned;
    const clockReason = sampleClocks(m, data.clocks) || deadlineFailure(a.request, data.clocks);
    if (clockReason) {
      rejectClock(m, a, clockReason, baseMatch, true, a.staged, !wasPoisoned && m.clockPoisoned); return;
    }
    let reason = !baseMatch ? "CHECKPOINT_CONFLICT" : a.invalidation ? "TOKEN_INVALID" :
      bindingFailure(m, a.request) || deadlineFailure(a.request, data.clocks);
    if (a.request.kind === "register") {
      if (a.staged !== null) fail("INPUT");
      // Even perfect synthetic tokens cannot establish a live OS gate.
      a.status = reason ? "rejected" : "registration-pending";
      if (!reason) { m.registrations.push(a.request.attemptId); m.revision = next(m.revision); }
    } else {
      const o = a.staged;
      if (!validNextSafety(m, o)) fail("CHAIN");
      mergeSafety(m, o);
      if (!reason && m.clockPoisoned) reason = "CLOCK_POISONED";
      if (!reason && m.revoked.includes(a.request.fingerprint)) reason = "REVOKED";
      if (!reason && m.consumed.some(p => p.permitId === a.request.permitId)) reason = "PERMIT_REPLAY";
      if (!reason) m.consumed.push({ permitId: a.request.permitId, requestDigest: a.request.requestDigest });
      // Legal next increment and consume share ONE final revision; no C1 check
      // against the original C0, no duplicate apply_revocation/accept_permit.
      m.revision = next(m.revision); a.status = reason ? "safety-only" : "consumed-synthetic";
    }
    a.reason = reason; a.commitOutcome = { baseMatch, status: a.status, checkpoint: current(m) };
    if (!a.cancelRequested && !a.invalidation) a.clientOutcome = reason ? "rejected" :
      a.request.kind === "register" ? "pending-registration" : "synthetic-committed";
    else a.clientOutcome = "unknown";
    a.staged = null; mark(a);
    // Completed synthetic consumption frees the model reservation only. A
    // pending registration or uncertain/invalidation path remains held.
    if (a.request.kind === "consume" && !a.cancelRequested && !a.invalidation && !deadlineFailure(a.request, data.clocks)) {
      a.reservation.held = false; a.reservation.tombstone = true;
    }
    return;
  }
  if (type === "recover") {
    // Monotonic readings do not survive a process epoch. Historical wall-clock
    // high-water/poison and all global revocations DO survive simulated replay.
    // Recovery itself is not authority to resume the prior owner's binding.
    m.monotonicNow = 0;
    m.control.ownerVersion = next(m.control.ownerVersion); m.control.ownerRevoked = true;
    m.revision = next(m.revision);
    for (const a of m.attempts) {
      if (["admitted", "reserved", "commit-possible"].includes(a.status)) {
        a.staged = null; terminal(a, "unknown", "RECOVERY_UNCERTAIN");
      } else if (a.status === "registration-pending") {
        a.clientOutcome = "unknown"; a.reason = "RECOVERY_PENDING"; mark(a);
      }
    }
    return;
  }
  fail("INPUT");
}
function mutate(machine, command) {
  const m = stateOf(machine);
  if (m.events.length === LIMITS.events) fail("LIMIT");
  const candidate = transition(m, command);
  candidate.events.push(command);
  if (Buffer.byteLength(JSON.stringify({ format: FORMAT, config: candidate.config, events: candidate.events })) > LIMITS.imageBytes) fail("LIMIT");
  machines.set(machine, candidate);
}
function transition(m, command) { const candidate = copy(m); apply(candidate, command); return candidate; }
// SQLite fixture admission conflict: expected SQL rowVersion is a business
// precondition, not the CAS operand for storing independently accepted safety.
// Preserve the actual request/C0; never rewrite it to manufacture a conflict.
function safetyOnly(m, input, reason) {
  const c = typedCommand(input);
  if (!["ROW_VERSION_CONFLICT", "CHECKPOINT_CONFLICT"].includes(reason) || !["enter", "commit"].includes(c.type)) fail("INPUT");
  const candidate = copy(m), a = attempt(candidate, c.data.attemptId,
    c.type === "enter" ? c.data.version : candidate.attempts.find(a => a.request.attemptId === c.data.attemptId)?.version);
  if (a.status !== (c.type === "enter" ? "reserved" : "commit-possible")) fail("STATE");
  const baseMatch = sameCheckpoint(a.request.checkpoint, current(candidate));
  const wasPoisoned = candidate.clockPoisoned;
  const clockReason = sampleClocks(candidate, c.data.clocks) || deadlineFailure(a.request, c.data.clocks);
  const o = c.type === "enter" ? c.data.observation : a.staged;
  // rejectClock already validates the chain separately from wall poison. A bad
  // chain cannot inject its own poison or discard independently sampled poison.
  rejectClock(candidate, a, clockReason || reason, baseMatch, true, o, !wasPoisoned && candidate.clockPoisoned);
  return candidate;
}
function typedCommand(value) {
  const c = record(value, ["type", "data"]); text(c.type);
  if (c.type === "admit") return { type: c.type, data: request(c.data) };
  if (c.type === "advanceControl" || c.type === "revokeControl") {
    const d = record(c.data, c.type === "advanceControl" ? ["axis", "expectedVersion", "identity"] : ["axis", "expectedVersion"]);
    if (!["owner", "grant", "lifecycle"].includes(d.axis)) fail("INPUT");
    integer(d.expectedVersion, 1);
    if (c.type === "advanceControl") { if (d.axis === "lifecycle") { if (d.identity !== null) fail("INPUT"); } else text(d.identity); }
    return { type: c.type, data: d };
  }
  let d;
  if (c.type === "reserve") { d = record(c.data, ["attemptId", "version", "tokenId"]); text(d.tokenId); }
  else if (c.type === "cancel") d = record(c.data, ["attemptId", "version"]);
  else if (c.type === "enter") {
    d = record(c.data, ["attemptId", "version", "clocks", "observation"]); d.clocks = clocks(d.clocks);
    d.observation = d.observation === null ? null : observation(d.observation);
  } else if (c.type === "commit") { d = record(c.data, ["attemptId", "clocks"]); text(d.attemptId); d.clocks = clocks(d.clocks); return { type: c.type, data: d }; }
  else if (c.type === "invalidate") {
    d = record(c.data, ["tokenId", "reason"]); text(d.tokenId);
    if (!["owner-dead", "owner-restarted", "token-expired", "grant-revoked", "lifecycle-changed"].includes(d.reason)) fail("INPUT");
    return { type: c.type, data: d };
  } else if (c.type === "recover") { record(c.data, []); return { type: c.type, data: {} }; }
  else fail("INPUT");
  text(d.attemptId); integer(d.version, 1); return { type: c.type, data: d };
}
function initial(input) {
  const c = config(input);
  return { config: c, revision: 1, sequence: 0, revoked: [], clockPoisoned: false,
      monotonicNow: 0, wallClockHighWater: 0,
      control: { ownerIncarnation: c.ownerIncarnation, ownerVersion: c.ownerVersion,
        grantId: c.grantId, grantVersion: c.grantVersion, lifecycleVersion: c.lifecycleVersion,
        ownerRevoked: false, grantRevoked: false, lifecycleRevoked: false,
        ownerHistory: [c.ownerIncarnation], grantHistory: [c.grantId] },
      consumed: [], registrations: [], attempts: [], events: [], closed: false };
}
function project(m) {
  return freeze({ ...FLAGS, registrationActive: false, publishable: false, dispatchAllowed: false,
    checkpoint: current(m), revocationSequence: m.sequence, revoked: [...m.revoked], clockPoisoned: m.clockPoisoned,
    clocks: { monotonicNow: m.monotonicNow, wallClockHighWater: m.wallClockHighWater }, control: copy(m.control),
    consumed: copy(m.consumed), attempts: copy(m.attempts), retainedEvents: m.events.length });
}

// Developer fixture-only materialized FACTS codec. It deliberately contains no
// commands/events and never calls restore()/replays history. Checksums and this
// structural validation do not authenticate a DB or establish rollback safety.
// semanticFormat is independent of any real product/store schema or migration.
function encodeFacts(m) {
  const { events, closed, ...state } = m;
  const body = JSON.stringify({ kind: "purely-synthetic-state-facts", semanticFormat: FORMAT, state });
  if (Buffer.byteLength(body) > LIMITS.imageBytes) fail("LIMIT");
  return body;
}
function unique(values) { if (new Set(values).size !== values.length) fail("FACTS"); }
function decodeFacts(body) {
  if (typeof body !== "string" || Buffer.byteLength(body) > LIMITS.imageBytes) fail("FACTS");
  let parsed; try { parsed = JSON.parse(body); } catch { fail("FACTS"); }
  const envelope = record(parsed, ["kind", "semanticFormat", "state"]);
  if (envelope.kind !== "purely-synthetic-state-facts" || envelope.semanticFormat !== FORMAT) fail("IMAGE_FORMAT");
  const m = record(envelope.state, ["config", "revision", "sequence", "revoked", "clockPoisoned", "monotonicNow",
    "wallClockHighWater", "control", "consumed", "registrations", "attempts"]);
  m.config = config(m.config); integer(m.revision, 1); integer(m.sequence);
  m.revoked = sortedHashes(m.revoked); integer(m.monotonicNow); integer(m.wallClockHighWater);
  if (typeof m.clockPoisoned !== "boolean") fail("FACTS");
  const c = record(m.control, ["ownerIncarnation", "ownerVersion", "grantId", "grantVersion", "lifecycleVersion",
    "ownerRevoked", "grantRevoked", "lifecycleRevoked", "ownerHistory", "grantHistory"]);
  for (const key of ["ownerVersion", "grantVersion", "lifecycleVersion"]) integer(c[key], m.config[key]);
  for (const axis of ["owner", "grant", "lifecycle"]) if (typeof c[axis + "Revoked"] !== "boolean") fail("FACTS");
  for (const axis of ["owner", "grant"]) {
    const key = axis === "owner" ? "ownerIncarnation" : "grantId";
    text(c[key]); c[axis + "History"] = list(c[axis + "History"], text, LIMITS.events); unique(c[axis + "History"]);
    if (c[axis + "History"][0] !== m.config[key] || c[axis + "History"].at(-1) !== c[key]) fail("FACTS");
  }
  m.control = c;
  m.consumed = list(m.consumed, v => { const p = record(v, ["permitId", "requestDigest"]); text(p.permitId); hash(p.requestDigest); return p; }, LIMITS.attempts);
  unique(m.consumed.map(p => p.permitId));
  m.registrations = list(m.registrations, text, LIMITS.attempts); unique(m.registrations);
  m.attempts = list(m.attempts, v => {
    const a = record(v, ["request", "version", "status", "reservation", "invalidation", "cancelRequested", "clientOutcome", "commitOutcome", "reason", "staged"]);
    a.request = request(a.request); integer(a.version, 1);
    if (!["admitted", "reserved", "invalidated", "cancelled", "commit-possible", "unknown", "registration-pending", "consumed-synthetic", "safety-only", "rejected"].includes(a.status) ||
        !["pending", "unknown", "cancelled", "rejected", "pending-registration", "synthetic-committed"].includes(a.clientOutcome) || typeof a.cancelRequested !== "boolean") fail("FACTS");
    for (const key of ["invalidation", "reason"]) if (a[key] !== null) text(a[key]);
    if (a.reservation !== null) {
      a.reservation = record(a.reservation, ["tokenId", "held", "tombstone"]); text(a.reservation.tokenId);
      if (typeof a.reservation.held !== "boolean" || typeof a.reservation.tombstone !== "boolean" || a.reservation.held === a.reservation.tombstone) fail("FACTS");
    }
    if (a.staged !== null) a.staged = observation(a.staged);
    if (a.status !== "commit-possible" && a.staged !== null) fail("FACTS");
    if (["reserved", "commit-possible", "registration-pending", "consumed-synthetic", "safety-only", "rejected"].includes(a.status) && !a.reservation) fail("FACTS");
    if (a.status === "commit-possible" && (a.request.kind === "register") !== (a.staged === null)) fail("FACTS");
    if (a.commitOutcome !== null) {
      const o = record(a.commitOutcome, ["baseMatch", "status", "checkpoint"]);
      if (typeof o.baseMatch !== "boolean" || o.status !== a.status) fail("FACTS");
      o.checkpoint = checkpoint(o.checkpoint);
      if (o.checkpoint.revision > m.revision) fail("FACTS"); a.commitOutcome = o;
    }
    const cp = a.request.checkpoint;
    if (["authorityId", "targetId", "storeGeneration"].some(k => cp[k] !== m.config[k])) fail("FACTS");
    return a;
  }, LIMITS.attempts);
  unique(m.attempts.map(a => a.request.attemptId)); unique(m.attempts.filter(a => a.reservation).map(a => a.reservation.tokenId));
  if (m.attempts.filter(a => a.reservation && a.reservation.held).length > 1) fail("FACTS");
  if (m.registrations.some(id => !m.attempts.some(a => a.request.attemptId === id && a.status === "registration-pending")) ||
      m.consumed.some(p => !m.attempts.some(a => a.status === "consumed-synthetic" && a.request.permitId === p.permitId && a.request.requestDigest === p.requestDigest))) fail("FACTS");
  m.events = []; m.closed = false;
  if (encodeFacts(m) !== body) fail("FACTS"); return m;
}
const sqliteFixtureKernel = Object.freeze({
  semanticFormat: FORMAT,
  initial(input) { return encodeFacts(initial(input)); },
  inspect(body) { return project(decodeFacts(body)); },
  normalizeCommand(input) { return freeze(typedCommand(input)); },
  transition(body, input) { return encodeFacts(transition(decodeFacts(body), typedCommand(input))); },
  safetyOnly(body, input, reason) { return encodeFacts(safetyOnly(decodeFacts(body), input, reason)); },
});
class SyntheticState {
  constructor(input) {
    machines.set(this, initial(input));
    Object.freeze(this);
  }
  snapshot() {
    return project(stateOf(this));
  }
  admit(input) { mutate(this, { type: "admit", data: request(input) }); }
  reserve(input) { mutate(this, typedCommand({ type: "reserve", data: input })); }
  invalidate(input) { mutate(this, typedCommand({ type: "invalidate", data: input })); }
  cancel(input) { mutate(this, typedCommand({ type: "cancel", data: input })); }
  // Controlled fixture commands, NOT authenticated lifecycle/grant authorities.
  advanceControl(input) { mutate(this, typedCommand({ type: "advanceControl", data: input })); }
  revokeControl(input) { mutate(this, typedCommand({ type: "revokeControl", data: input })); }
  // A staged observation is inert, copied data, not a trusted freshness proof.
  // enter() is the explicit simulated commit-uncertainty barrier, NOT merely
  // admission to a cancellable queue. After it, cancel only stops client wait;
  // commit() records the possible late result, while still rechecking C0/token.
  enter(input) {
    const command = typedCommand({ type: "enter", data: input }); mutate(this, command);
    const m = stateOf(this), a = m.attempts.find(a => a.request.attemptId === command.data.attemptId);
    if (a.status !== "commit-possible") return null;
    const handle = Object.freeze(Object.create(null)); handles.set(handle, { machine: this, attemptId: a.request.attemptId, used: false }); return handle;
  }
  commit(handle, sample) {
    const h = handles.get(handle); const c = clocks(sample);
    if (!h || h.machine !== this || h.used) fail("HANDLE");
    mutate(this, { type: "commit", data: { attemptId: h.attemptId, clocks: c } }); h.used = true;
  }
  exportImage() {
    const m = stateOf(this); return JSON.stringify({ format: FORMAT, config: m.config, events: m.events });
  }
  // Pure in-memory crash-image replay only. Images are NOT authenticated;
  // rejection/consistency checks cannot detect omitted/rolled-back valid logs.
  // No capability to resume outstanding work or activate registrations exists.
  static restore(image) {
    if (typeof image !== "string" || Buffer.byteLength(image) > LIMITS.imageBytes) fail("IMAGE");
    let parsed; try { parsed = JSON.parse(image); } catch { fail("IMAGE"); }
    const body = record(parsed, ["format", "config", "events"]);
    if (body.format !== FORMAT) fail("IMAGE_FORMAT"); // Before allocation/replay.
    const machine = new SyntheticState(body.config), events = list(body.events, typedCommand, LIMITS.events - 1);
    for (const command of events) mutate(machine, command);
    // Reject duplicate keys, noncanonical representations and hidden payloads.
    if (machine.exportImage() !== image) fail("IMAGE");
    mutate(machine, { type: "recover", data: {} }); return machine;
  }
}
Object.freeze(SyntheticState.prototype); Object.freeze(SyntheticState);
module.exports = Object.freeze({ SyntheticState, SyntheticStateError, LIMITS, FLAGS, sqliteFixtureKernel });
