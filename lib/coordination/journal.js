"use strict";

// ─── Reliable Segmented JSONL Journal (T-ACN-003) ──────────────────────────
// Append-only, atomic (fsync), recoverable (truncated-tail), hash-chained,
// segmented event store with per-producer sequence enforcement and eventId
// idempotency. Zero external dependencies — Node.js built-ins only.
//
// Read-only dependencies:
//   - ./contract  → validateEvent (structural event validation, fail-closed)
//   - ./errors    → CoordinationError + stable error codes
//
// Design invariants (P-001 §8.1, §14):
//   1. Append-only: existing records are never modified in place; only the
//      active segment receives new lines.
//   2. Atomic + recoverable: every append is fsync'd. A crash mid-write can
//      leave at most one partial tail line (no trailing "\n"); on open the
//      partial tail is truncated, restoring the last fully-durable record.
//   3. Hash chain: each record carries prevHash + hash (sha256 over canonical
//      JSON of {v, event, prevHash}). The chain spans segments so a sealed
//      segment is tamper-evident and the next segment continues the chain.
//   4. Sequence: per (taskId + producer.actorId) stream, strictly +1. Gaps or
//      regressions fail closed with ERR_SEQUENCE_GAP (no state guessing).
//   5. eventId idempotency: appending an event whose eventId already exists
//      returns the canonical stored event (appended=false, duplicate=true),
//      never storing a second copy. §14.5 "相同 eventId 返回已有结果".
//   6. Single writer: an O_EXCL lock file with owner/expiry serializes
//      multi-process appenders; stale locks are reclaimed.
//
// Scope (CP-1 / T-ACN-003): durable storage + ordering + integrity + recovery.
// State-machine transitions, snapshot files, ownership leases, consumer ACK
// and notification belong to T-ACN-004/005/006/008 and are intentionally NOT
// implemented here.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CoordinationError } = require("./errors");
const { validateEvent } = require("./contract");

// ─── Constants ─────────────────────────────────────────────────────────────

const RECORD_VERSION = 1;
const GENESIS_HASH = "0".repeat(64); // prevHash of the very first record
const SEGMENT_PREFIX = "events-";
const SEGMENT_REGEX = /^events-(\d{6})\.jsonl$/;
const LOCK_FILE = "journal.lock";

const DEFAULT_MAX_EVENTS_PER_SEGMENT = 1000;
const DEFAULT_MAX_BYTES_PER_SEGMENT = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024; // 256 KiB per record line
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 min

const NEWLINE = 0x0a; // "\n"

// ─── Canonical serialization + hashing ─────────────────────────────────────
// Deterministic JSON so the on-disk line and the hash input are stable
// regardless of property insertion order (survives parse → re-stringify).

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

function computeHash(obj) {
  return crypto.createHash("sha256").update(stableStringify(obj), "utf8").digest("hex");
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function streamKeyOf(event) {
  return `${event.taskId}::${event.producer && event.producer.actorId}`;
}

function segmentFileName(num) {
  return `${SEGMENT_PREFIX}${String(num).padStart(6, "0")}.jsonl`;
}

class Journal {
  constructor(dir, options = {}) {
    this._dir = dir;
    this._lockEnabled = options.lock !== false;
    this._lockOwner = options.owner || null;
    this._lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this._maxEventsPerSegment = options.maxEventsPerSegment ?? DEFAULT_MAX_EVENTS_PER_SEGMENT;
    this._maxBytesPerSegment = options.maxBytesPerSegment ?? DEFAULT_MAX_BYTES_PER_SEGMENT;
    this._maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this._fsync = options.fsync !== false;

    this._closed = false;
    this._activeSegment = 1;
    this._activeFd = null;
    this._activeCount = 0;
    this._activeBytes = 0;

    // eventId -> { event, hash, segment, sequence, streamKey }
    this._index = new Map();
    // streamKey -> last applied sequence
    this._lastSequence = new Map();
    this._lastHash = GENESIS_HASH;
    this._count = 0;

    this._lockPath = null;
    this._recovery = {
      recovered: false,
      truncatedSegments: [],
      truncatedBytes: 0,
      truncatedRecords: 0,
      openedAt: null,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  static open(dir, options = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const journal = new Journal(dir, options);
    journal._init();
    return journal;
  }

  _init() {
    this._acquireLock();
    try {
      let segNums = this._segmentNumbers();
      if (segNums.length === 0) {
        // create the first (empty) segment
        const fd = fs.openSync(this._segmentPath(1), "a");
        fs.closeSync(fd);
        segNums = [1];
      }
      this._activeSegment = segNums[segNums.length - 1];

      // Recover any partial tails (crash mid-write) on every segment.
      for (const segNum of this._segmentNumbers()) {
        this._recoverTail(segNum);
      }

      // Rebuild in-memory index + lastHash + lastSequence from durable records.
      this._scan();

      // Open the active segment for appending.
      this._activeFd = fs.openSync(this._segmentPath(this._activeSegment), "a");
      this._recovery.openedAt = new Date().toISOString();
    } catch (err) {
      this._releaseLock();
      throw err;
    }
  }

  close() {
    if (this._closed) return;
    if (this._activeFd != null) {
      try { if (this._fsync) fs.fsyncSync(this._activeFd); } catch { /* best effort */ }
      try { fs.closeSync(this._activeFd); } catch { /* best effort */ }
      this._activeFd = null;
    }
    this._releaseLock();
    this._closed = true;
  }

  _ensureOpen() {
    if (this._closed) {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { reason: "journal_closed" },
      });
    }
  }

  // ─── Path helpers ───────────────────────────────────────────────────────

  _segmentPath(num) {
    return path.join(this._dir, segmentFileName(num));
  }

  _segmentNumbers() {
    const nums = [];
    let entries;
    try {
      entries = fs.readdirSync(this._dir);
    } catch (err) {
      if (err && err.code === "ENOENT") return nums;
      throw err;
    }
    for (const name of entries) {
      const m = SEGMENT_REGEX.exec(name);
      if (m) nums.push(parseInt(m[1], 10));
    }
    nums.sort((a, b) => a - b);
    return nums;
  }

  // ─── Tail recovery (§14 crash recovery) ─────────────────────────────────
  // A partial write (crash before "\n" was durable) leaves a final line with
  // no trailing newline. Truncate at the last durable newline; the producer
  // can re-send the lost event. This never touches fully-durable records.

  _recoverTail(segNum) {
    const segPath = this._segmentPath(segNum);
    const buf = fs.readFileSync(segPath);
    if (buf.length === 0) return;
    if (buf[buf.length - 1] === NEWLINE) return; // tail is complete

    const lastNewline = buf.lastIndexOf(NEWLINE);
    const keepBytes = lastNewline >= 0 ? lastNewline + 1 : 0;
    const truncatedBytes = buf.length - keepBytes;
    fs.truncateSync(segPath, keepBytes);

    this._recovery.recovered = true;
    this._recovery.truncatedSegments.push({
      segment: segNum,
      truncatedBytes,
    });
    this._recovery.truncatedBytes += truncatedBytes;
    this._recovery.truncatedRecords += 1;
  }

  // ─── Scan / rebuild index ───────────────────────────────────────────────
  // Verifies the hash chain and per-stream sequence continuity. Append prevents
  // gaps during normal operation, but reopen must also fail closed when files
  // were externally replaced with a self-consistent yet incomplete chain.

  _scan() {
    let expectedPrev = GENESIS_HASH;
    for (const segNum of this._segmentNumbers()) {
      const segPath = this._segmentPath(segNum);
      const buf = fs.readFileSync(segPath);
      const content = buf.toString("utf8");
      let segCount = 0;
      if (content.length > 0) {
        const lines = content.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        for (const line of lines) {
          if (line === "") continue;
          const rec = this._parseAndVerify(line, segNum, expectedPrev);
          expectedPrev = rec.hash;
          const eventId = rec.event.eventId;
          if (this._index.has(eventId)) {
            throw new CoordinationError("ERR_INVALID_EVENT", {
              details: { reason: "duplicate_event_id_in_journal", segment: segNum, eventId },
            });
          }
          const sKey = streamKeyOf(rec.event);
          const prevLast = this._lastSequence.get(sKey) || 0;
          if (rec.event.sequence !== prevLast + 1) {
            throw new CoordinationError("ERR_SEQUENCE_GAP", {
              details: {
                streamKey: sKey,
                expected: prevLast + 1,
                actual: rec.event.sequence,
                segment: segNum,
                reason: rec.event.sequence <= prevLast ? "regression" : "gap",
              },
            });
          }
          this._index.set(eventId, {
            event: rec.event,
            hash: rec.hash,
            segment: segNum,
            sequence: rec.event.sequence,
            streamKey: sKey,
          });
          this._lastSequence.set(sKey, rec.event.sequence);
          this._count += 1;
          segCount += 1;
        }
      }
      if (segNum === this._activeSegment) {
        this._activeCount = segCount;
        this._activeBytes = buf.length;
      }
    }
    this._lastHash = expectedPrev;
  }

  _parseAndVerify(line, segNum, expectedPrev) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new CoordinationError("ERR_INVALID_EVENT", {
        details: { reason: "json_parse_failed", segment: segNum },
      });
    }
    const computed = computeHash({ v: rec.v, event: rec.event, prevHash: rec.prevHash });
    if (computed !== rec.hash) {
      throw new CoordinationError("ERR_INVALID_EVENT", {
        details: {
          reason: "hash_mismatch",
          segment: segNum,
          eventId: rec.event && rec.event.eventId,
        },
      });
    }
    if (rec.prevHash !== expectedPrev) {
      throw new CoordinationError("ERR_INVALID_EVENT", {
        details: {
          reason: "chain_broken",
          segment: segNum,
          eventId: rec.event && rec.event.eventId,
          expectedPrevHash: expectedPrev,
          actualPrevHash: rec.prevHash,
        },
      });
    }
    return rec;
  }

  // ─── Iteration (verified) ───────────────────────────────────────────────

  *_iterateRecords() {
    let expectedPrev = GENESIS_HASH;
    for (const segNum of this._segmentNumbers()) {
      const segPath = this._segmentPath(segNum);
      const content = fs.readFileSync(segPath, "utf8");
      if (content.length === 0) continue;
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) {
        if (line === "") continue;
        const rec = this._parseAndVerify(line, segNum, expectedPrev);
        expectedPrev = rec.hash;
        rec._segment = segNum;
        yield rec;
      }
    }
  }

  // ─── Append ─────────────────────────────────────────────────────────────

  append(event) {
    this._ensureOpen();
    if (!event || typeof event !== "object") {
      throw new CoordinationError("ERR_INVALID_EVENT", {
        details: { reason: "event must be an object" },
      });
    }
    const eventId = event.eventId;
    if (!eventId || typeof eventId !== "string") {
      throw new CoordinationError("ERR_INVALID_EVENT", {
        details: { reason: "missing or non-string eventId" },
      });
    }

    // Idempotency: same eventId returns the canonical stored result.
    if (this._index.has(eventId)) {
      const entry = this._index.get(eventId);
      return {
        event: entry.event,
        appended: false,
        duplicate: true,
        sequence: entry.sequence,
        hash: entry.hash,
        segment: entry.segment,
      };
    }

    // Producer + task identity required for the sequence stream key.
    if (!event.taskId || !event.producer || !event.producer.actorId) {
      throw new CoordinationError("ERR_INVALID_EVENT", {
        details: { reason: "missing taskId or producer.actorId" },
      });
    }

    const sKey = streamKeyOf(event);
    const last = this._lastSequence.get(sKey) || 0;

    // Shallow copy so we can assign sequence without mutating the caller's
    // object. Nested objects are not mutated by this module.
    const ev = { ...event };
    if (ev.sequence == null) {
      ev.sequence = last + 1;
    } else {
      const seq = ev.sequence;
      if (seq > last + 1) {
        throw new CoordinationError("ERR_SEQUENCE_GAP", {
          details: { streamKey: sKey, lastSequence: last, providedSequence: seq, reason: "gap" },
        });
      }
      if (seq <= last) {
        throw new CoordinationError("ERR_SEQUENCE_GAP", {
          details: { streamKey: sKey, lastSequence: last, providedSequence: seq, reason: "regression" },
        });
      }
    }

    // Structural validation via the shared contract (fail-closed).
    validateEvent(ev);

    // Build the chained record.
    const record = { v: RECORD_VERSION, event: ev, prevHash: this._lastHash };
    const hash = computeHash(record);
    record.hash = hash;
    const line = stableStringify(record) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (lineBytes > this._maxEventBytes) {
      throw new CoordinationError("ERR_EVENT_TOO_LARGE", {
        details: { eventId, bytes: lineBytes, max: this._maxEventBytes },
      });
    }

    // Roll over to a new segment if this record would cross a limit.
    if (
      this._activeCount > 0 &&
      (this._activeCount >= this._maxEventsPerSegment ||
        this._activeBytes + lineBytes > this._maxBytesPerSegment)
    ) {
      this._rollSegment();
    }

    // Append the complete record before fsync. writeSync may legally perform a
    // short write, so advance by bytes rather than assuming one call suffices.
    const data = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < data.length) {
      const written = fs.writeSync(this._activeFd, data, offset, data.length - offset);
      if (written <= 0) {
        throw new CoordinationError("ERR_INVALID_STATE", {
          details: { reason: "journal_write_made_no_progress", eventId },
        });
      }
      offset += written;
    }
    if (this._fsync) fs.fsyncSync(this._activeFd);

    // Update in-memory state.
    this._index.set(eventId, {
      event: ev,
      hash,
      segment: this._activeSegment,
      sequence: ev.sequence,
      streamKey: sKey,
    });
    this._lastSequence.set(sKey, ev.sequence);
    this._lastHash = hash;
    this._activeCount += 1;
    this._activeBytes += lineBytes;
    this._count += 1;

    return {
      event: ev,
      appended: true,
      duplicate: false,
      sequence: ev.sequence,
      hash,
      segment: this._activeSegment,
    };
  }

  _rollSegment() {
    if (this._activeFd != null) {
      try { if (this._fsync) fs.fsyncSync(this._activeFd); } catch { /* best effort */ }
      try { fs.closeSync(this._activeFd); } catch { /* best effort */ }
      this._activeFd = null;
    }
    this._activeSegment += 1;
    this._activeFd = fs.openSync(this._segmentPath(this._activeSegment), "a");
    this._activeCount = 0;
    this._activeBytes = 0;
    // _lastHash carries over so the chain continues across segments.
  }

  // ─── Reads ──────────────────────────────────────────────────────────────

  hasEvent(eventId) {
    return this._index.has(eventId);
  }

  getEvent(eventId) {
    const entry = this._index.get(eventId);
    return entry ? entry.event : null;
  }

  readAll(filter = {}) {
    this._ensureOpen();
    const events = [];
    for (const rec of this._iterateRecords()) {
      if (!this._matchesFilter(rec.event, filter)) continue;
      events.push(rec.event);
    }
    return events;
  }

  replay(options = {}) {
    this._ensureOpen();
    const { filter = {}, onEvent } = options;
    let count = 0;
    for (const rec of this._iterateRecords()) {
      if (!this._matchesFilter(rec.event, filter)) continue;
      count += 1;
      if (typeof onEvent === "function") {
        const keep = onEvent(rec.event, {
          sequence: rec.event.sequence,
          hash: rec.hash,
          segment: rec._segment,
        });
        if (keep === false) break;
      }
    }
    return count;
  }

  _matchesFilter(event, filter) {
    if (!filter) return true;
    if (filter.taskId && event.taskId !== filter.taskId) return false;
    if (filter.actorId && (!event.producer || event.producer.actorId !== filter.actorId)) return false;
    if (filter.eventTypes && !filter.eventTypes.includes(event.eventType)) return false;
    if (filter.fromSequence != null && event.sequence < filter.fromSequence) return false;
    if (filter.toSequence != null && event.sequence > filter.toSequence) return false;
    return true;
  }

  // ─── Full integrity audit ───────────────────────────────────────────────
  // Verifies the hash chain AND per-stream sequence continuity. Throws on
  // hash/chain corruption; returns a report including any sequence gaps
  // (which can only appear via external corruption — append prevents them).

  verify() {
    this._ensureOpen();
    const streamLast = new Map();
    const gaps = [];
    let total = 0;
    let lastHash = GENESIS_HASH;
    for (const rec of this._iterateRecords()) {
      lastHash = rec.hash;
      const sKey = streamKeyOf(rec.event);
      const last = streamLast.has(sKey) ? streamLast.get(sKey) : 0;
      if (rec.event.sequence !== last + 1) {
        gaps.push({
          streamKey: sKey,
          expected: last + 1,
          actual: rec.event.sequence,
          eventId: rec.event.eventId,
          segment: rec._segment,
        });
      }
      if (rec.event.sequence > last) streamLast.set(sKey, rec.event.sequence);
      total += 1;
    }
    return {
      ok: gaps.length === 0,
      totalEvents: total,
      segments: this._segmentNumbers().length,
      lastHash,
      gaps,
    };
  }

  // ─── Metadata / introspection ───────────────────────────────────────────

  getSegmentMetas() {
    this._ensureOpen();
    const metas = [];
    for (const segNum of this._segmentNumbers()) {
      const segPath = this._segmentPath(segNum);
      const buf = fs.readFileSync(segPath);
      const content = buf.toString("utf8");
      const lines = content.length ? content.split("\n") : [];
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      let firstEventId = null;
      let lastEventId = null;
      let firstHash = null;
      let lastHash = null;
      let firstPrevHash = null;
      let firstSequence = null;
      let lastSequence = null;
      let count = 0;
      for (const line of lines) {
        if (!line) continue;
        const rec = JSON.parse(line);
        if (count === 0) {
          firstEventId = rec.event.eventId;
          firstHash = rec.hash;
          firstPrevHash = rec.prevHash;
          firstSequence = rec.event.sequence;
        }
        lastEventId = rec.event.eventId;
        lastHash = rec.hash;
        lastSequence = rec.event.sequence;
        count += 1;
      }
      metas.push({
        segment: segNum,
        path: segPath,
        count,
        bytes: buf.length,
        firstEventId,
        lastEventId,
        firstHash,
        lastHash,
        firstPrevHash,
        firstSequence,
        lastSequence,
        sealed: segNum !== this._activeSegment,
      });
    }
    return metas;
  }

  getLastSequence(taskId, actorId) {
    return this._lastSequence.get(`${taskId}::${actorId}`) || 0;
  }

  getStreamSequences() {
    const out = {};
    for (const [k, v] of this._lastSequence) out[k] = v;
    return out;
  }

  getLastHash() {
    return this._lastHash;
  }

  getCount() {
    return this._count;
  }

  getRecoveryInfo() {
    return {
      recovered: this._recovery.recovered,
      truncatedSegments: this._recovery.truncatedSegments.map((s) => ({ ...s })),
      truncatedBytes: this._recovery.truncatedBytes,
      truncatedRecords: this._recovery.truncatedRecords,
      openedAt: this._recovery.openedAt,
    };
  }

  get dir() {
    return this._dir;
  }

  // ─── Single-writer lock (§8.1) ──────────────────────────────────────────

  _acquireLock() {
    if (!this._lockEnabled) return;
    const lockPath = path.join(this._dir, LOCK_FILE);
    const owner = this._lockOwner || `journal-pid${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this._lockTtlMs).toISOString();
    const payload = stableStringify({
      owner,
      acquiredAt: now.toISOString(),
      expiresAt,
      pid: process.pid,
    });

    const tryCreate = () => {
      const fd = fs.openSync(lockPath, "wx"); // O_EXCL
      fs.writeFileSync(fd, payload, "utf8");
      if (this._fsync) fs.fsyncSync(fd);
      fs.closeSync(fd);
    };

    try {
      tryCreate();
    } catch (err) {
      if (err && err.code !== "EEXIST") throw err;
      // Lock exists — inspect it.
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        existing = null;
      }
      const expired =
        !existing || !existing.expiresAt || new Date(existing.expiresAt).getTime() <= Date.now();
      if (!expired) {
        throw new CoordinationError("ERR_LEASE_CONFLICT", {
          details: {
            resource: "journal",
            lockFile: lockPath,
            owner: existing && existing.owner,
            expiresAt: existing && existing.expiresAt,
          },
        });
      }
      // Move the observed stale lock out of the lock namespace atomically.
      // Never unlink lockPath after inspection: another contender may already
      // have replaced it, which would create two live writers.
      const stalePath = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      try {
        fs.renameSync(lockPath, stalePath);
      } catch (reclaimError) {
        throw new CoordinationError("ERR_LEASE_CONFLICT", {
          details: {
            resource: "journal",
            lockFile: lockPath,
            reason: reclaimError && reclaimError.code === "ENOENT"
              ? "reclaim_raced"
              : "reclaim_failed",
          },
        });
      }
      try {
        tryCreate();
      } catch (err2) {
        if (err2 && err2.code === "EEXIST") {
          throw new CoordinationError("ERR_LEASE_CONFLICT", {
            details: { resource: "journal", lockFile: lockPath, reason: "reclaim_failed" },
          });
        }
        throw err2;
      } finally {
        try { fs.unlinkSync(stalePath); } catch { /* best effort */ }
      }
    }

    this._lockPath = lockPath;
    this._lockOwner = owner;
  }

  _releaseLock() {
    if (!this._lockPath) return;
    try {
      const raw = fs.readFileSync(this._lockPath, "utf8");
      const lock = JSON.parse(raw);
      if (lock && lock.owner === this._lockOwner) {
        fs.unlinkSync(this._lockPath);
      }
    } catch {
      /* best effort — lock file may already be gone */
    }
    this._lockPath = null;
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  Journal,
  // Constants exposed for tests / consumers
  RECORD_VERSION,
  GENESIS_HASH,
  SEGMENT_PREFIX,
  SEGMENT_REGEX,
  LOCK_FILE,
  DEFAULT_MAX_EVENTS_PER_SEGMENT,
  DEFAULT_MAX_BYTES_PER_SEGMENT,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_LOCK_TTL_MS,
  // Pure helpers (exported for testability)
  stableStringify,
  computeHash,
  streamKeyOf,
  segmentFileName,
};
