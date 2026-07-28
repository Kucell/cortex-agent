"use strict";

// ─── Coordination Task Snapshot Store (T-ACN-004) ──────────────────────────
// Atomic, compare-and-swap snapshot persistence for CoordinationTask state.
//
// Responsibilities (CP-1, see P-001 §8.1, §14.4, §14.5):
//   * atomic write: temp file + fsync + rename (crash-safe replace).
//   * compare-and-swap by revision (ERR_REVISION_MISMATCH on concurrent write).
//   * corruption detection: schema / revision / integrity hash (§14.4).
//   * corruption recovery: replay events via the deterministic reducer, rebuild
//     to a temp file, atomically replace, emit a recovery audit descriptor
//     (the caller writes it to the journal - this module never imports journal).
//   * Run.phase protection: snapshots persist coordination task state only;
//     task.completed events carrying progress.phase are rejected upstream by the
//     reducer (assertCompletedSyncToRun), so no snapshot path can overwrite
//     Run.phase.
//
// The snapshot is a rebuildable projection (§4 invariant 2): the journal is the
// source of truth, the snapshot is a cache. Recovery accepts an event iterable
// supplied by the caller (Application Service / T-ACN-006), keeping this module
// decoupled from the journal store (T-ACN-003, read-only here).
//
// Zero external dependencies: node:fs, node:path, node:crypto only.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { CoordinationError } = require("./errors");
const { SCHEMA_VERSION, validateTaskState } = require("./contract");
const { replay } = require("./state");

const SNAPSHOT_SCHEMA_VERSION = SCHEMA_VERSION; // "1.0"
const INTEGRITY_ALGO = "sha256";

// ─── Canonical serialization (stable key order for deterministic hashing) ───

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

function computeIntegrity(payload) {
  return crypto.createHash(INTEGRITY_ALGO).update(canonicalStringify(payload), "utf8").digest("hex");
}

// ─── Paths ──────────────────────────────────────────────────────────────────

function snapshotPath(tasksDir, taskId) {
  if (typeof taskId !== "string"
      || taskId.length === 0
      || taskId === "."
      || taskId === ".."
      || taskId.includes("/")
      || taskId.includes("\\")
      || taskId.includes("\0")) {
    throw new CoordinationError("ERR_INVALID_STATE", {
      details: { reason: "taskId is not safe for snapshot storage", taskId },
    });
  }
  return path.join(tasksDir, `${taskId}.json`);
}

function tempPath(file) {
  // Unique temp name on the same directory/filesystem as the target so rename
  // is atomic. process.pid + counter + random guards parallel writers.
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${file}.tmp.${process.pid}.${Date.now()}.${rnd}`;
}

// ─── Envelope ───────────────────────────────────────────────────────────────

function buildSnapshotEnvelope(taskState, options = {}) {
  if (!taskState || typeof taskState !== "object") {
    throw new CoordinationError("ERR_INVALID_STATE", {
      details: { reason: "taskState must be an object" },
    });
  }
  validateTaskState(taskState);
  const payload = taskState; // store as-is; canonical hash covers key order
  const integrity = computeIntegrity(payload);
  const writtenAt = options.now !== undefined ? options.now : new Date().toISOString();
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: "coordination-task-snapshot",
    taskId: taskState.taskId,
    revision: taskState.revision,
    lastSequence: taskState.lastSequence,
    integrityAlgo: INTEGRITY_ALGO,
    integrity,
    writtenAt,
    payload,
  };
}

// ─── Read / parse ───────────────────────────────────────────────────────────
//
// readSnapshot(tasksDir, taskId) -> {
//   status: "absent" | "ok" | "corrupted",
//   taskId,
//   taskState?, revision?, lastSequence?, writtenAt?,  // when ok
//   reason?,                                          // when corrupted
//   raw?,                                             // when corrupted (for audit)
// }
//
// "absent"   - no snapshot file (fresh task).
// "ok"       - valid snapshot; taskState usable.
// "corrupted"- file exists but failed schema/integrity/state validation; caller
//              should call recoverSnapshot to rebuild from the journal.

function readSnapshot(tasksDir, taskId) {
  const file = snapshotPath(tasksDir, taskId);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { status: "absent", taskId, path: file };
    }
    throw err; // unexpected filesystem error
  }
  return parseSnapshotString(raw, taskId, file);
}

function parseSnapshotString(raw, taskId, file) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    return { status: "corrupted", taskId, path: file, reason: "json-parse-failed", raw };
  }
  if (!envelope || typeof envelope !== "object") {
    return { status: "corrupted", taskId, path: file, reason: "not-an-object", raw };
  }
  if (envelope.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return { status: "corrupted", taskId, path: file, reason: "schema-version-mismatch",
      actual: envelope.schemaVersion, raw };
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    return { status: "corrupted", taskId, path: file, reason: "missing-payload", raw };
  }
  if (envelope.taskId !== taskId || envelope.payload.taskId !== taskId) {
    return { status: "corrupted", taskId, path: file, reason: "task-id-mismatch",
      envelopeTaskId: envelope.taskId, payloadTaskId: envelope.payload.taskId, raw };
  }
  // integrity hash check (detects partial writes / tampering)
  const recomputed = computeIntegrity(envelope.payload);
  if (recomputed !== envelope.integrity) {
    return { status: "corrupted", taskId, path: file, reason: "integrity-mismatch",
      expected: recomputed, actual: envelope.integrity, raw };
  }
  // task state structural validation
  try {
    validateTaskState(envelope.payload);
  } catch (err) {
    return { status: "corrupted", taskId, path: file, reason: "task-state-invalid",
      error: (err && err.key) || (err && err.message), raw };
  }
  // envelope <-> payload consistency (revision / lastSequence must agree)
  if (envelope.revision !== envelope.payload.revision
      || envelope.lastSequence !== envelope.payload.lastSequence) {
    return { status: "corrupted", taskId, path: file, reason: "envelope-payload-revision-mismatch",
      envelopeRevision: envelope.revision,
      payloadRevision: envelope.payload.revision,
      envelopeLastSequence: envelope.lastSequence,
      payloadLastSequence: envelope.payload.lastSequence,
      raw };
  }
  return {
    status: "ok",
    taskId,
    path: file,
    taskState: envelope.payload,
    revision: envelope.payload.revision,
    lastSequence: envelope.payload.lastSequence,
    writtenAt: envelope.writtenAt,
  };
}

// ─── Atomic write ───────────────────────────────────────────────────────────

function atomicWrite(tasksDir, taskState, options = {}) {
  fs.mkdirSync(tasksDir, { recursive: true });
  const envelope = buildSnapshotEnvelope(taskState, { now: options.now });
  const file = snapshotPath(tasksDir, taskState.taskId);
  const data = JSON.stringify(envelope, null, 2);
  const tmp = tempPath(file);
  const fd = fs.openSync(tmp, "wx"); // exclusive create; fails if temp name collides
  try {
    fs.writeFileSync(fd, data, "utf8");
    try {
      fs.fsyncSync(fd); // durability: flush before rename
    } catch (_fsyncErr) {
      // fsync may be unavailable on some platforms; rename still atomic.
      // The integrity hash guards against partial content on crash.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file); // atomic replace on POSIX (same filesystem)
  // Persist the directory entry as well as the file content. Some platforms do
  // not support directory fsync; that is a durability degradation, not a
  // reason to discard an otherwise atomically replaced snapshot.
  let dirFd;
  try {
    dirFd = fs.openSync(tasksDir, "r");
    fs.fsyncSync(dirFd);
  } catch (_dirFsyncErr) {
    // best effort
  } finally {
    if (dirFd !== undefined) fs.closeSync(dirFd);
  }
  return {
    ok: true,
    taskId: taskState.taskId,
    revision: taskState.revision,
    lastSequence: taskState.lastSequence,
    writtenAt: envelope.writtenAt,
    path: file,
  };
}

// ─── Write with compare-and-swap ────────────────────────────────────────────
//
// writeSnapshot(tasksDir, taskState, options) -> write result.
// options:
//   expectedRevision?: number  - CAS: current snapshot revision must match.
//                               0 (or absent snapshot) when creating fresh.
//                               When omitted, CAS is skipped (force).
//   force?: boolean            - bypass CAS and corrupted-check (recovery only).
//   now?: string               - injected writtenAt (test determinism).
//
// Throws:
//   ERR_INVALID_STATE          - existing snapshot corrupted (call recoverSnapshot).
//   ERR_REVISION_MISMATCH       - CAS failed (concurrent writer won).

function writeSnapshot(tasksDir, taskState, options = {}) {
  const { expectedRevision, force = false, now } = options;
  validateTaskState(taskState);
  const existing = readSnapshot(tasksDir, taskState.taskId);

  if (existing.status === "corrupted" && !force) {
    throw new CoordinationError("ERR_INVALID_STATE", {
      details: {
        kind: "snapshot-corrupted",
        taskId: taskState.taskId,
        reason: existing.reason,
        hint: "call recoverSnapshot to rebuild from the journal",
      },
    });
  }

  if (!force && expectedRevision !== undefined) {
    if (existing.status === "ok") {
      if (existing.revision !== expectedRevision) {
        throw new CoordinationError("ERR_REVISION_MISMATCH", {
          details: {
            taskId: taskState.taskId,
            expected: expectedRevision,
            actual: existing.revision,
          },
        });
      }
    } else if (existing.status === "absent") {
      // creating fresh: expectedRevision must be 0
      if (expectedRevision !== 0) {
        throw new CoordinationError("ERR_REVISION_MISMATCH", {
          details: {
            taskId: taskState.taskId,
            expected: expectedRevision,
            actual: 0,
            reason: "snapshot absent but a prior revision was expected",
          },
        });
      }
    }
  }

  return atomicWrite(tasksDir, taskState, { now });
}

// ─── Corruption recovery ────────────────────────────────────────────────────
//
// recoverSnapshot(tasksDir, taskId, events, options) -> {
//   ok, recovered, taskState, audit, write, log
// }
//
// Rebuilds the snapshot by replaying `events` (ABSENT -> final) through the
// deterministic reducer, then atomically replaces the (possibly corrupt)
// snapshot. `events` are supplied by the caller from the journal; this module
// never imports the journal store.
//
// `audit` is a recovery audit descriptor (§14.4 "写 recovery audit event").
// The caller (Application Service) appends it to the journal; this module only
// returns it, preserving the journal single-writer boundary.
//
// Throws ERR_INVALID_STATE if no state can be rebuilt (empty events) - the
// caller should then treat the task as absent, not guess.
// Throws ERR_SEQUENCE_GAP if the event stream has a gap - recovery must not
// guess state across a gap (§14.5).

function recoverSnapshot(tasksDir, taskId, events, options = {}) {
  const { now } = options;
  const existing = readSnapshot(tasksDir, taskId);
  const reason = existing.status === "corrupted"
    ? existing.reason
    : (existing.status === "absent" ? "absent" : "explicit-recovery");

  const { state, log } = replay(events, options);

  if (!state) {
    throw new CoordinationError("ERR_INVALID_STATE", {
      details: {
        kind: "snapshot-recovery-failed",
        taskId,
        reason: "no state could be rebuilt from the provided events",
        eventsReplayed: log.length,
      },
    });
  }

  // If the rebuilt state matches the existing healthy snapshot exactly, the
  // recovery is a no-op write (still atomic and audited).
  const write = atomicWrite(tasksDir, state, { now });

  const audit = {
    kind: "recovery-audit",
    taskId,
    reason,
    recoveredRevision: state.revision,
    recoveredLastSequence: state.lastSequence,
    recoveredState: state.state,
    recoveredAt: write.writtenAt,
    eventsReplayed: log.length,
    appliedCount: log.filter((l) => l.applied).length,
    duplicateCount: log.filter((l) => l.duplicate).length,
    integrity: computeIntegrity(state),
  };

  return {
    ok: true,
    recovered: true,
    taskId,
    taskState: state,
    write,
    audit,
    log,
  };
}

// ─── Load helper (convenience) ──────────────────────────────────────────────
//
// loadTaskState(tasksDir, taskId) -> taskState | null
// Returns the task state if a healthy snapshot exists, null if absent.
// Throws ERR_INVALID_STATE if corrupted (caller decides to recover).

function loadTaskState(tasksDir, taskId) {
  const res = readSnapshot(tasksDir, taskId);
  if (res.status === "absent") return null;
  if (res.status === "corrupted") {
    throw new CoordinationError("ERR_INVALID_STATE", {
      details: {
        kind: "snapshot-corrupted",
        taskId,
        reason: res.reason,
        hint: "call recoverSnapshot to rebuild from the journal",
      },
    });
  }
  return res.taskState;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  INTEGRITY_ALGO,
  canonicalStringify,
  computeIntegrity,
  snapshotPath,
  buildSnapshotEnvelope,
  readSnapshot,
  parseSnapshotString,
  writeSnapshot,
  atomicWrite,
  recoverSnapshot,
  loadTaskState,
};
