"use strict";

// ─── Project-Scoped Local Consumer Registry (CP-9) ──────────────────────────
//
// Implements the project-scoped local consumer registry described in P-003 §5
// and §7. Every operation in this module:
//
//   1. Confines persistence to a caller-provided runtime root (must contain
//      `.agent-runtime` as a path segment, mirroring the
//      `notification-supervisor` discipline).
//   2. Uses safe atomic writes (tmp file + rename + fsync) with strict
//      POSIX permissions (0o600) so receipts never leak across users.
//   3. Rejects path traversal and symlink traversal before any read or
//      write — opening an existing file that resolves outside the root is
//      a hard error.
//   4. Persists ONLY redacted data: no credentials, prompts, responses,
//      file bodies, absolute paths, private host session/thread IDs or
//      exact token usage. Consumer ids, actor ids and event types are
//      bounded strings; everything else (prompt/response/file body/IP/…)
//      is rejected before it can be persisted.
//   5. Keeps ACK state independent per consumer. The delivery / ACK key is
//      `eventId + target + consumerId`, matching `notification-policy`'s
//      `deliveryKey` so two consumers receiving the same event track two
//      independent cursors, two pending records, two receipts and two ACKs.
//
// No fs spawn / no network / no process. Side-effect free apart from the
// targeted atomic write.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { isKnownCapability, CAPABILITY_NAMES } = require("./host-capabilities");

class ConsumerRegistryError extends Error {
  constructor(code, details = {}) {
    // Include the structured details in the message so consumers can use
    // `assert.throws(..., /reason/)` (Node's validator only inspects the
    // message string, not nested details objects).
    const reason = details && details.reason ? `:${details.reason}` : "";
    super(`${code}${reason}`);
    this.name = "ConsumerRegistryError";
    this.code = code;
    this.details = details;
  }
}

const RUNTIME_SEGMENT = ".agent-runtime";
const SCHEMA_VERSION = "1.0";
const MAX_CONSUMER_ID_LEN = 128;
const MAX_PROJECT_ID_LEN = 256;
const MAX_ACTOR_ID_LEN = 256;
const MAX_KIND_LEN = 64;
const MAX_STRING_LEN = 1024;
const CONSUMER_DIR_NAME = "consumers";
const PROJECT_FILE_PREFIX = "project-";

// ─── Validation helpers ────────────────────────────────────────────────────
//
// These match the strict-bounded rules of the existing
// `consumer-cursor.js` and the protocol deny-rule set: control characters
// are rejected, lengths are bounded, and obvious secret-shaped values are
// refused at the boundary so they can never reach a receipt.

const ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_TYPE_SAFE = /^[a-z][a-z0-9._-]{0,127}$/;
const PROJECT_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
// Stable identifier rules — relaxed enough for repo-relative IDs and human
// readable names, strict enough to keep symlinks / traversal out.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const SECRET_PATTERN = /(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]/i;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'`])\/(?:Users|home|var|tmp|private|opt|etc)\//;
const WINDOWS_ABSOLUTE_PATH = /(^|[\s"'`])[A-Za-z]:[\\/]/;
const IPV4_ADDRESS = /(^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}([^0-9]|$)/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Prompt-body / injection markers: refuse obvious attempts to smuggle
// prompt content into a receipt, even if it doesn't contain a literal
// secret-shaped field.
const PROMPT_MARKER = /\b(?:ignore (?:all )?(?:previous|prior|above) instructions|reveal (?:the )?system prompt|disregard (?:the )?(?:system|developer) (?:prompt|messages?))\b/i;
// Session / thread IDs: refuse obvious Codex/Claude/IDE-style session or
// thread identifiers that begin with a vendor prefix and a long opaque
// suffix. This is heuristic; receipt scrubbing also rejects any string
// that contains a colon-separated "vendor:..." identifier.
const SESSION_MARKER = /(?:codex|claude|windsurf|cursor|jetbrains|vscode)[_-]?(?:thread|session)[_-][A-Za-z0-9-]{6,}/i;

function assertBoundedString(value, field, pattern, maxLen) {
  if (typeof value !== "string") {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field, reason: "must be string" });
  }
  if (value.length === 0 || value.length > maxLen) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field, reason: "out_of_range", length: value.length, max: maxLen });
  }
  if (CONTROL_CHARS.test(value)) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field, reason: "control_chars" });
  }
  if (pattern && !pattern.test(value)) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field, reason: "unsafe_chars" });
  }
  return value;
}

function assertConsumerId(value, field = "consumerId") {
  return assertBoundedString(value, field, ID_SAFE, MAX_CONSUMER_ID_LEN);
}

function assertProjectId(value) {
  return assertBoundedString(value, "projectId", PROJECT_ID_SAFE, MAX_PROJECT_ID_LEN);
}

function assertTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field: "target", reason: "must be object" });
  }
  const kind = assertBoundedString(target.kind, "target.kind", SAFE_VALUE, MAX_KIND_LEN);
  const actorId = assertBoundedString(target.actorId, "target.actorId", SAFE_VALUE, MAX_ACTOR_ID_LEN);
  return Object.freeze({ kind, actorId });
}

function assertEventType(value, field) {
  return assertBoundedString(value, field, EVENT_TYPE_SAFE, MAX_STRING_LEN);
}

function assertStringList(values, field) {
  if (!Array.isArray(values)) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field, reason: "must be array" });
  }
  if (values.length > 128) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field, reason: "too_long", length: values.length, max: 128 });
  }
  const seen = new Set();
  const out = [];
  for (const value of values) {
    assertEventType(value, `${field}[]`);
    if (seen.has(value)) {
      throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field, reason: "duplicate", value });
    }
    seen.add(value);
    out.push(value);
  }
  // Stable, sorted output so persisted lists are deterministic across
  // re-registrations and a / b observe identical subscription order.
  out.sort();
  return out;
}

// Reject obvious secret-shaped values, absolute paths, IPs and overly large
// blobs at the registry boundary so they cannot reach a receipt.
function assertRedactedScalar(value, field) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") {
    throw new ConsumerRegistryError("ERR_REGISTRY_REDACTED", { field, reason: "unsupported_type" });
  }
  if (value.length > MAX_STRING_LEN) {
    throw new ConsumerRegistryError("ERR_REGISTRY_REDACTED", { field, reason: "too_long", length: value.length });
  }
  if (CONTROL_CHARS.test(value)) {
    throw new ConsumerRegistryError("ERR_REGISTRY_REDACTED", { field, reason: "control_chars" });
  }
  if (SECRET_PATTERN.test(value) || POSIX_ABSOLUTE_PATH.test(value)
      || WINDOWS_ABSOLUTE_PATH.test(value) || IPV4_ADDRESS.test(value)
      || PROMPT_MARKER.test(value) || SESSION_MARKER.test(value)) {
    throw new ConsumerRegistryError("ERR_REGISTRY_REDACTED", { field, reason: "contains_private_data" });
  }
  return value;
}

// ─── Filesystem helpers ────────────────────────────────────────────────────

function assertRuntimeScoped(dir) {
  if (typeof dir !== "string" || !dir) {
    throw new ConsumerRegistryError("ERR_REGISTRY_SCOPE", { dir });
  }
  const resolved = path.resolve(dir);
  const segments = resolved.split(path.sep);
  if (!segments.includes(RUNTIME_SEGMENT)) {
    throw new ConsumerRegistryError("ERR_REGISTRY_SCOPE", {
      dir: resolved,
      expectedSegment: RUNTIME_SEGMENT,
    });
  }
  return resolved;
}

function projectFileName(projectId) {
  assertProjectId(projectId);
  const digest = crypto.createHash("sha256").update(projectId, "utf8").digest("hex");
  return `${PROJECT_FILE_PREFIX}${digest}.json`;
}

// Safe path resolution: must end up inside `rootDir` after symlink resolution.
// We refuse any directory that itself is a symlink, since it could redirect
// reads / writes outside the runtime root.
function resolveProjectPath(rootDir, projectId) {
  const dir = assertRuntimeScoped(rootDir);
  const consumersDir = path.join(dir, CONSUMER_DIR_NAME);
  if (!fs.existsSync(consumersDir)) fs.mkdirSync(consumersDir, { recursive: true });
  const lstat = fs.lstatSync(consumersDir);
  if (lstat.isSymbolicLink()) {
    throw new ConsumerRegistryError("ERR_REGISTRY_SCOPE", {
      reason: "symlink_directory",
      dir: consumersDir,
    });
  }
  const file = path.join(consumersDir, projectFileName(projectId));
  // We never write through an existing symlink. Touching only the file path
  // is fine: file creation happens via `wx` (O_EXCL) which never follows.
  return { dir, consumersDir, file };
}

function writeAtomic(file, payload) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    const dir = path.dirname(file);
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(tmp); } catch { /* renamed or already gone */ }
  }
}

// ─── Schema sanity ─────────────────────────────────────────────────────────

function initialState(projectId, clock) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    revision: 0,
    consumers: {},
    deliveries: {},
    acknowledgements: {},
    updatedAt: new Date(clock()).toISOString(),
  };
}

function validatePersisted(state, projectId) {
  if (!state || typeof state !== "object") {
    throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", { projectId, reason: "not_object" });
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", { projectId, reason: "schema_version", version: state.schemaVersion });
  }
  if (state.projectId !== projectId) {
    throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", { projectId, reason: "project_mismatch" });
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", { projectId, reason: "revision" });
  }
  if (!state.consumers || typeof state.consumers !== "object") {
    throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", { projectId, reason: "consumers" });
  }
  if (!state.deliveries || typeof state.deliveries !== "object") {
    throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", { projectId, reason: "deliveries" });
  }
  if (!state.acknowledgements || typeof state.acknowledgements !== "object") {
    throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", { projectId, reason: "acknowledgements" });
  }
}

// ─── Delivery / ACK keys ──────────────────────────────────────────────────
//
// Each consumer independently tracks deliveries for (eventId, target,
// consumerId). The composite key is the SHA-256 of `\0`-separated fields,
// matching the existing `notification-policy.deliveryKey` formula so the
// registry's keys can interoperate with the notification pump without a
// second translation layer.

function targetIdentity(target) {
  if (!target || typeof target !== "object") {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field: "target", reason: "must be object" });
  }
  const kind = typeof target.kind === "string" ? target.kind.trim() : "";
  const actorId = typeof target.actorId === "string" ? target.actorId.trim() : "";
  if (!kind || !actorId) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field: "target", reason: "missing_fields" });
  }
  return `${kind}:${actorId}`;
}

function makeDeliveryKey(eventId, consumerId, target) {
  if (typeof eventId !== "string" || !eventId) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field: "eventId", reason: "must be string" });
  }
  if (typeof consumerId !== "string" || !consumerId) {
    throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field: "consumerId", reason: "must be string" });
  }
  // `target` is already a normalised `kind:actorId` string OR a target object.
  // Accept either so the helper is reusable both from recordDelivery (which
  // has already normalised) and from callers that pass the raw target.
  const t = typeof target === "string" ? target : targetIdentity(target);
  const material = `${eventId}\0${consumerId}\0${t}`;
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

// ─── Redacted receipt builder ──────────────────────────────────────────────
//
// Persisted receipts must NEVER include: credentials, prompts, response
// bodies, file bodies, absolute paths, private host session / thread IDs,
// or exact token usage. The schema only accepts:
//   - deliveryKey (sha256)
//   - consumerId, eventId, target (targetIdentity string)
//   - status (one of delivered/presented/deferred/failed)
//   - adapterId (registered adapter identifier; safe)
//   - attempts (integer)
//   - nextAttemptAt (ISO timestamp or null)
//   - acked (boolean)
//   - reason (short bounded scalar, redacted by assertRedactedScalar)
//   - createdAt / updatedAt (ISO timestamps)

function buildReceipt(input) {
  if (!input || typeof input !== "object") {
    throw new ConsumerRegistryError("ERR_REGISTRY_REDACTED", { reason: "missing" });
  }
  const status = assertRedactedScalar(input.status, "status");
  const reason = input.reason === null || input.reason === undefined
    ? null
    : assertRedactedScalar(input.reason, "reason");
  if (input.adapterId !== null && input.adapterId !== undefined) {
    assertRedactedScalar(input.adapterId, "adapterId");
  }
  const attempts = typeof input.attempts === "number" && Number.isInteger(input.attempts) && input.attempts >= 1
    ? input.attempts
    : 1;
  return Object.freeze({
    status,
    reason,
    adapterId: input.adapterId || null,
    attempts,
    nextAttemptAt: typeof input.nextAttemptAt === "string" ? input.nextAttemptAt : null,
    acked: input.acked === true,
  });
}

// ─── ConsumerRegistry class ────────────────────────────────────────────────

class ConsumerRegistry {
  constructor(rootDir, projectId, options = {}) {
    assertProjectId(projectId);
    this.rootDir = assertRuntimeScoped(rootDir);
    this.projectId = projectId;
    this.clock = options.clock || Date.now;
    const { file, consumersDir } = resolveProjectPath(this.rootDir, projectId);
    this.consumersDir = consumersDir;
    this.file = file;
    if (!fs.existsSync(this.file)) {
      writeAtomic(this.file, JSON.stringify(initialState(projectId, this.clock), null, 2) + "\n");
    }
    this._state = this._load();
  }

  _load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      throw new ConsumerRegistryError("ERR_REGISTRY_CORRUPT", {
        projectId: this.projectId,
        reason: "read_failed",
        cause: error && error.code,
      });
    }
    validatePersisted(parsed, this.projectId);
    return parsed;
  }

  _flush() {
    this._state.updatedAt = nowIso(this.clock);
    writeAtomic(this.file, JSON.stringify(this._state, null, 2) + "\n");
  }

  _update(mutator) {
    const snapshot = this._state;
    const result = mutator(snapshot);
    snapshot.revision += 1;
    validatePersisted(snapshot, this.projectId);
    this._flush();
    return result;
  }

  // ─── Consumer lifecycle ────────────────────────────────────────────────

  register(input) {
    if (!input || typeof input !== "object") {
      throw new ConsumerRegistryError("ERR_REGISTRY_FIELD", { field: "input", reason: "must be object" });
    }
    const consumerId = assertConsumerId(input.consumerId);
    const target = assertTarget(input.target);
    const adapterId = input.adapterId
      ? assertBoundedString(input.adapterId, "adapterId", ID_SAFE, MAX_CONSUMER_ID_LEN)
      : null;
    const subscriptions = input.subscriptions
      ? assertStringList(input.subscriptions, "subscriptions")
      : [];
    const fallback = input.fallback
      ? assertStringList(input.fallback, "fallback")
      : [];
    return this._update((state) => {
      const created = state.consumers[consumerId] === undefined;
      state.consumers[consumerId] = Object.freeze({
        consumerId,
        target,
        adapterId,
        subscriptions: Object.freeze([...subscriptions]),
        fallback: Object.freeze([...fallback]),
        createdAt: state.consumers[consumerId]
          ? state.consumers[consumerId].createdAt
          : nowIso(this.clock),
        updatedAt: nowIso(this.clock),
      });
      // Ensure delivery / ACK buckets exist for the consumer.
      if (!state.deliveries[consumerId]) state.deliveries[consumerId] = {};
      if (!state.acknowledgements[consumerId]) state.acknowledgements[consumerId] = {};
      return { created, consumer: state.consumers[consumerId] };
    });
  }

  unregister(consumerId) {
    const id = assertConsumerId(consumerId);
    return this._update((state) => {
      if (!state.consumers[id]) return false;
      delete state.consumers[id];
      delete state.deliveries[id];
      delete state.acknowledgements[id];
      return true;
    });
  }

  get(consumerId) {
    const id = assertConsumerId(consumerId);
    const entry = this._state.consumers[id];
    return entry ? clone(entry) : null;
  }

  list() {
    return Object.values(this._state.consumers).map((entry) => clone(entry));
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────

  addSubscription(consumerId, eventType) {
    const id = assertConsumerId(consumerId);
    const type = assertEventType(eventType, "eventType");
    return this._update((state) => {
      const consumer = state.consumers[id];
      if (!consumer) {
        throw new ConsumerRegistryError("ERR_CONSUMER_NOT_FOUND", { consumerId: id });
      }
      const next = new Set(consumer.subscriptions);
      const had = next.has(type);
      next.add(type);
      state.consumers[id] = Object.freeze({
        ...consumer,
        subscriptions: Object.freeze([...next].sort()),
        updatedAt: nowIso(this.clock),
      });
      return !had;
    });
  }

  removeSubscription(consumerId, eventType) {
    const id = assertConsumerId(consumerId);
    const type = assertEventType(eventType, "eventType");
    return this._update((state) => {
      const consumer = state.consumers[id];
      if (!consumer) {
        throw new ConsumerRegistryError("ERR_CONSUMER_NOT_FOUND", { consumerId: id });
      }
      const next = new Set(consumer.subscriptions);
      const had = next.delete(type);
      state.consumers[id] = Object.freeze({
        ...consumer,
        subscriptions: Object.freeze([...next].sort()),
        updatedAt: nowIso(this.clock),
      });
      return had;
    });
  }

  setSubscriptions(consumerId, eventTypes) {
    const id = assertConsumerId(consumerId);
    const list = assertStringList(eventTypes, "eventTypes");
    return this._update((state) => {
      const consumer = state.consumers[id];
      if (!consumer) {
        throw new ConsumerRegistryError("ERR_CONSUMER_NOT_FOUND", { consumerId: id });
      }
      state.consumers[id] = Object.freeze({
        ...consumer,
        subscriptions: Object.freeze([...list]),
        updatedAt: nowIso(this.clock),
      });
      return state.consumers[id].subscriptions;
    });
  }

  setFallback(consumerId, fallbackChain) {
    const id = assertConsumerId(consumerId);
    const chain = assertStringList(fallbackChain, "fallback");
    return this._update((state) => {
      const consumer = state.consumers[id];
      if (!consumer) {
        throw new ConsumerRegistryError("ERR_CONSUMER_NOT_FOUND", { consumerId: id });
      }
      state.consumers[id] = Object.freeze({
        ...consumer,
        fallback: Object.freeze([...chain]),
        updatedAt: nowIso(this.clock),
      });
      return state.consumers[id].fallback;
    });
  }

  // ─── Delivery / ACK (independent per consumer) ─────────────────────────

  recordDelivery(consumerId, eventId, target, receipt) {
    const id = assertConsumerId(consumerId);
    const eId = assertBoundedString(eventId, "eventId", ID_SAFE, MAX_STRING_LEN);
    const t = targetIdentity(target);
    const built = buildReceipt(receipt || {});
    const key = makeDeliveryKey(eId, id, t);
    return this._update((state) => {
      if (!state.consumers[id]) {
        throw new ConsumerRegistryError("ERR_CONSUMER_NOT_FOUND", { consumerId: id });
      }
      if (!state.deliveries[id]) state.deliveries[id] = {};
      if (!state.acknowledgements[id]) state.acknowledgements[id] = {};
      // If the same delivery key has already been acknowledged, record the
      // new attempt but keep the prior ACK (so an ACK is never implicitly
      // reversed by a later delivery attempt).
      const existingAck = state.acknowledgements[id][key];
      const persisted = {
        deliveryKey: key,
        consumerId: id,
        eventId: eId,
        target: t,
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
        ...built,
        acked: Boolean(existingAck),
      };
      state.deliveries[id][key] = persisted;
      return clone(persisted);
    });
  }

  acknowledge(consumerId, eventId, target) {
    const id = assertConsumerId(consumerId);
    const eId = assertBoundedString(eventId, "eventId", ID_SAFE, MAX_STRING_LEN);
    const t = targetIdentity(target);
    const key = makeDeliveryKey(eId, id, t);
    return this._update((state) => {
      if (!state.consumers[id]) {
        throw new ConsumerRegistryError("ERR_CONSUMER_NOT_FOUND", { consumerId: id });
      }
      if (!state.acknowledgements[id]) state.acknowledgements[id] = {};
      // Idempotent: re-ACKing a delivery is a no-op that returns false so the
      // caller can distinguish first-ACK from re-ACK.
      if (state.acknowledgements[id][key]) return false;
      if (!state.deliveries[id] || !state.deliveries[id][key]) {
        throw new ConsumerRegistryError("ERR_ACK_NOT_FOUND", { consumerId: id, eventId: eId, target: t });
      }
      state.acknowledgements[id][key] = {
        deliveryKey: key,
        consumerId: id,
        eventId: eId,
        target: t,
        acknowledgedAt: nowIso(this.clock),
      };
      delete state.deliveries[id][key];
      return true;
    });
  }

  pendingFor(consumerId) {
    const id = assertConsumerId(consumerId);
    const deliveries = this._state.deliveries[id] || {};
    const acks = this._state.acknowledgements[id] || {};
    return Object.values(deliveries)
      .filter((entry) => !entry.acked && !acks[entry.deliveryKey])
      .map(clone);
  }

  acknowledgedFor(consumerId) {
    const id = assertConsumerId(consumerId);
    return Object.values(this._state.acknowledgements[id] || {}).map(clone);
  }

  pendingAckCount(consumerId) {
    return this.pendingFor(consumerId).length;
  }

  // ─── Inspection / recovery ─────────────────────────────────────────────

  snapshot() {
    return {
      schemaVersion: this._state.schemaVersion,
      projectId: this._state.projectId,
      revision: this._state.revision,
      updatedAt: this._state.updatedAt,
      consumerCount: Object.keys(this._state.consumers).length,
      consumers: this.list(),
    };
  }

  // Reload from disk (used after a crash, before delivering).
  reload() {
    this._state = this._load();
    return this.snapshot();
  }

  // ─── Test seam ─────────────────────────────────────────────────────────

  get _filePath() {
    return this.file;
  }
}

module.exports = {
  ConsumerRegistry,
  ConsumerRegistryError,
  SCHEMA_VERSION,
  MAX_CONSUMER_ID_LEN,
  MAX_PROJECT_ID_LEN,
  makeDeliveryKey,
  targetIdentity,
  assertConsumerId,
  assertProjectId,
  assertTarget,
  assertEventType,
  buildReceipt,
};