"use strict";

/**
 * lib/event-bus/persistence.js
 *
 * Append-only JSONL persistence for the framework event bus.
 *
 * Responsibilities:
 *   - Append events to events.jsonl with fsync (durability)
 *   - Single-writer flock (cross-process safety)
 *   - 10 MB cap rotate -> gzip archive
 *   - 100 MB total cap -> prune oldest archive (keep >= 1)
 *   - meta.json bus metadata (last_event_id, counts, schema_version)
 *   - subs.json subscription registry (last_read_offset)
 *   - Restart recovery (read events.jsonl tail to rebuild state)
 *
 * Zero npm dependencies - node:fs, node:path, node:zlib, node:crypto only.
 *
 * References:
 *   - docs/architecture/framework-event-bus-design.md §5 (Persistence & Data Flow)
 *   - .agent/missions/M-004/validation-contract.json VC-004
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ARCHIVE_CAP = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TOTAL_CAP = 100 * 1024 * 1024;  // 100 MB
const DEFAULT_DEDUPE_LRU_SIZE = 10000;
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a process is alive (portable). */
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ensure a directory exists. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Persistence factory
// ---------------------------------------------------------------------------

/**
 * Create a persistence layer for an event bus.
 *
 * @param {object} opts
 * @param {string} opts.dataDir   - bus data directory
 * @param {boolean} [opts.fsync=true] - fsync after each append
 * @param {number}  [opts.archiveCapBytes=10MB] - rotate threshold
 * @param {number}  [opts.totalCapBytes=100MB]  - total dir cap
 * @param {number}  [opts.dedupeLruSize=10000]  - LRU capacity for dedupe
 * @returns {Persistence}
 */
function createPersistence(opts) {
  return new Persistence(opts);
}

class Persistence {
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.fsync = opts.fsync !== false;
    this.archiveCapBytes = opts.archiveCapBytes || DEFAULT_ARCHIVE_CAP;
    this.totalCapBytes = opts.totalCapBytes || DEFAULT_TOTAL_CAP;
    this.dedupeLruSize = opts.dedupeLruSize || DEFAULT_DEDUPE_LRU_SIZE;

    // File paths
    this._eventsPath = path.join(this.dataDir, "events.jsonl");
    this._subsPath = path.join(this.dataDir, "subs.json");
    this._metaPath = path.join(this.dataDir, "meta.json");
    this._lockPath = path.join(this.dataDir, "locks", "write.lock");
    this._archiveDir = path.join(this.dataDir, "archive");
    this._acksDir = path.join(this.dataDir, "acks");

    // State
    this._fd = null;          // persistent file descriptor for events.jsonl
    this._lockHeld = false;
    this._meta = null;
    this._closed = false;

    // Dedupe LRU (Map preserves insertion order -> LRU via delete+set)
    this._seenIds = new Map();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the persistence layer: create dirs, open fd, load meta,
   * rebuild dedupe LRU from events.jsonl tail.
   */
  init() {
    ensureDir(this.dataDir);
    ensureDir(path.join(this.dataDir, "locks"));
    ensureDir(this._archiveDir);
    ensureDir(this._acksDir);

    // Open events.jsonl for appending (create if not exists)
    this._fd = fs.openSync(this._eventsPath, "a");

    // Load or create meta
    this._meta = this._readMeta();

    // Rebuild dedupe LRU from last N events
    this._rebuildDedupe();
  }

  // -------------------------------------------------------------------------
  // Lock management (single-writer flock via lock file)
  // -------------------------------------------------------------------------

  /**
   * Acquire the write lock. Throws if another live process holds it.
   */
  acquireLock() {
    if (this._lockHeld) return;
    ensureDir(path.dirname(this._lockPath));
    try {
      fs.writeFileSync(this._lockPath, String(process.pid), { flag: "wx" });
      this._lockHeld = true;
    } catch (err) {
      if (err.code === "EEXIST") {
        const existingPid = parseInt(fs.readFileSync(this._lockPath, "utf8").trim(), 10);
        if (!isProcessAlive(existingPid)) {
          // Stale lock - take over
          fs.writeFileSync(this._lockPath, String(process.pid));
          this._lockHeld = true;
        } else {
          throw new Error(`event_bus_write_failed: lock held by pid ${existingPid}`);
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Release the write lock.
   */
  releaseLock() {
    if (!this._lockHeld) return;
    try {
      fs.unlinkSync(this._lockPath);
    } catch {
      // already gone
    }
    this._lockHeld = false;
  }

  /**
   * Run a function while holding the write lock.
   * @param {function} fn
   * @returns {*} fn's return value
   */
  withLock(fn) {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  // -------------------------------------------------------------------------
  // Append
  // -------------------------------------------------------------------------

  /**
   * Append an event to events.jsonl with fsync.
   * Thread/process safe via lock.
   * @param {object} event - fully-formed event envelope
   * @returns {{ ok: boolean, event_id: string, persisted_at: string, offset: number }}
   */
  append(event) {
    if (this._closed) throw new Error("Persistence is closed");
    if (this._fd === null) throw new Error("Persistence not initialized");

    return this.withLock(() => {
      const line = JSON.stringify(event);
      const buf = Buffer.from(line + "\n", "utf8");

      // Current file size before write (for offset tracking)
      const offset = fs.statSync(this._eventsPath).size;

      fs.writeSync(this._fd, buf);
      if (this.fsync) fs.fsyncSync(this._fd);

      // Track in dedupe LRU
      this._seenIds.set(event.event_id, true);
      if (this._seenIds.size > this.dedupeLruSize) {
        const oldest = this._seenIds.keys().next().value;
        this._seenIds.delete(oldest);
      }

      // Update meta
      this._meta.last_event_id = event.event_id;
      this._meta.event_count = (this._meta.event_count || 0) + 1;
      this._meta.last_appended_at = event.occurred_at;
      this._writeMeta();

      // Check rotation
      const newSize = offset + buf.length;
      if (newSize >= this.archiveCapBytes) {
        this._rotate(newSize);
      }

      return {
        ok: true,
        event_id: event.event_id,
        persisted_at: event.occurred_at,
        offset: offset,
      };
    });
  }

  /**
   * Check if an event_id has already been seen (dedupe).
   * @param {string} eventId
   * @returns {boolean}
   */
  isDuplicate(eventId) {
    return this._seenIds.has(eventId);
  }

  // -------------------------------------------------------------------------
  // Rotation & archive
  // -------------------------------------------------------------------------

  /**
   * Rotate events.jsonl to a gzipped archive.
   * Closes current fd, compresses, reopens fresh events.jsonl.
   * @param {number} currentSize - current file size
   * @private
   */
  _rotate(currentSize) {
    // Close current fd
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }

    // Read current content
    const content = fs.readFileSync(this._eventsPath);
    const ts = Date.now();
    const archiveName = `events-${ts}.jsonl.gz`;
    const archivePath = path.join(this._archiveDir, archiveName);

    // Compress to archive
    const compressed = zlib.gzipSync(content);
    fs.writeFileSync(archivePath, compressed);

    // Truncate events.jsonl (open with 'w' then switch to 'a')
    fs.writeFileSync(this._eventsPath, "");
    this._fd = fs.openSync(this._eventsPath, "a");

    // Update meta
    this._meta.last_rotate_at = new Date().toISOString();
    this._meta.last_rotate_size = currentSize;
    this._meta.archive_count = (this._meta.archive_count || 0) + 1;
    this._writeMeta();

    // Prune old archives if total cap exceeded
    this._pruneArchives();
  }

  /**
   * Delete oldest archives until total dir size is under totalCapBytes.
   * Always keeps at least 1 archive.
   * @private
   */
  _pruneArchives() {
    const archives = fs.readdirSync(this._archiveDir)
      .filter((f) => f.endsWith(".jsonl.gz"))
      .map((f) => ({
        name: f,
        path: path.join(this._archiveDir, f),
        size: fs.statSync(path.join(this._archiveDir, f)).size,
        mtime: fs.statSync(path.join(this._archiveDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    if (archives.length <= 1) return;

    let totalSize = archives.reduce((sum, a) => sum + a.size, 0);
    // Also count events.jsonl
    try {
      totalSize += fs.statSync(this._eventsPath).size;
    } catch { /* ignore */ }

    for (const arch of archives) {
      if (archives.length <= 1) break; // keep at least 1
      if (totalSize <= this.totalCapBytes) break;
      fs.unlinkSync(arch.path);
      totalSize -= arch.size;
      this._meta.archive_count = Math.max(0, (this._meta.archive_count || 0) - 1);
    }
    this._writeMeta();
  }

  // -------------------------------------------------------------------------
  // Read events
  // -------------------------------------------------------------------------

  /**
   * Read events from events.jsonl, optionally filtered.
   * @param {object} [filter] - { since?, until?, event_name?, limit?, offset? }
   * @returns {{ events: object[], total: number }}
   */
  readEvents(filter) {
    filter = filter || {};
    const events = [];
    let total = 0;

    if (!fs.existsSync(this._eventsPath)) {
      return { events: [], total: 0 };
    }

    const content = fs.readFileSync(this._eventsPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      total++;

      if (filter.event_name && event.event_name !== filter.event_name) continue;
      if (filter.since && event.occurred_at < filter.since) continue;
      if (filter.until && event.occurred_at > filter.until) continue;
      if (filter.correlation) {
        if (filter.correlation.mission_id &&
            event.correlation?.mission_id !== filter.correlation.mission_id) continue;
        if (filter.correlation.subagent_id &&
            event.correlation?.subagent_id !== filter.correlation.subagent_id) continue;
      }

      events.push(event);
    }

    const limit = filter.limit || 0;
    const offset = filter.offset || 0;
    const sliced = limit > 0 ? events.slice(offset, offset + limit) : events.slice(offset);

    return { events: sliced, total };
  }

  /**
   * Read events from byte offset onwards (for fan-out delivery).
   * @param {number} byteOffset
   * @returns {object[]} events after the byte offset
   */
  readEventsFromOffset(byteOffset) {
    if (!fs.existsSync(this._eventsPath)) return [];
    const content = fs.readFileSync(this._eventsPath, "utf8");
    const fromOffset = content.slice(byteOffset);
    const lines = fromOffset.split("\n").filter((l) => l.trim());
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return events;
  }

  /**
   * Read the last N event IDs from events.jsonl (for dedupe LRU rebuild).
   * @param {number} count
   * @returns {string[]} event IDs (most recent last)
   */
  readLastEventIds(count) {
    if (!fs.existsSync(this._eventsPath)) return [];
    const content = fs.readFileSync(this._eventsPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    const tail = lines.slice(-count);
    const ids = [];
    for (const line of tail) {
      try {
        const event = JSON.parse(line);
        if (event.event_id) ids.push(event.event_id);
      } catch {
        continue;
      }
    }
    return ids;
  }

  /**
   * Get the current byte size of events.jsonl.
   * @returns {number}
   */
  getEventsSize() {
    try {
      return fs.statSync(this._eventsPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Get archive info.
   * @returns {{ archives: object[], totalSize: number }}
   */
  getArchiveInfo() {
    const archives = [];
    let totalSize = 0;

    if (fs.existsSync(this._archiveDir)) {
      const files = fs.readdirSync(this._archiveDir).filter((f) => f.endsWith(".jsonl.gz"));
      for (const f of files) {
        const fp = path.join(this._archiveDir, f);
        const stat = fs.statSync(fp);
        archives.push({ name: f, size: stat.size, mtime: stat.mtimeMs });
        totalSize += stat.size;
      }
    }
    totalSize += this.getEventsSize();
    return { archives, totalSize };
  }

  // -------------------------------------------------------------------------
  // Meta management
  // -------------------------------------------------------------------------

  _readMeta() {
    try {
      const raw = fs.readFileSync(this._metaPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return {
        bus_id: path.basename(this.dataDir),
        created_at: new Date().toISOString(),
        last_event_id: null,
        event_count: 0,
        schema_version: SCHEMA_VERSION,
        archive_count: 0,
      };
    }
  }

  _writeMeta() {
    fs.writeFileSync(this._metaPath, JSON.stringify(this._meta, null, 2));
  }

  getMeta() {
    return { ...this._meta };
  }

  // -------------------------------------------------------------------------
  // Subs (subscription registry)
  // -------------------------------------------------------------------------

  readSubs() {
    try {
      const raw = fs.readFileSync(this._subsPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return { version: 1, subscriptions: [] };
    }
  }

  writeSubs(subs) {
    fs.writeFileSync(this._subsPath, JSON.stringify(subs, null, 2));
  }

  /**
   * Add or update a subscription.
   * @param {object} sub - subscription object
   */
  upsertSub(sub) {
    const subs = this.readSubs();
    const idx = subs.subscriptions.findIndex((s) => s.subscription_id === sub.subscription_id);
    if (idx >= 0) {
      subs.subscriptions[idx] = { ...subs.subscriptions[idx], ...sub };
    } else {
      subs.subscriptions.push(sub);
    }
    this.writeSubs(subs);
  }

  /**
   * Update last_read_offset for a subscription.
   * @param {string} subscriptionId
   * @param {number} offset
   */
  updateSubOffset(subscriptionId, offset) {
    const subs = this.readSubs();
    const sub = subs.subscriptions.find((s) => s.subscription_id === subscriptionId);
    if (sub) {
      sub.last_read_offset = offset;
      this.writeSubs(subs);
    }
  }

  /**
   * Remove a subscription.
   * @param {string} subscriptionId
   */
  removeSub(subscriptionId) {
    const subs = this.readSubs();
    subs.subscriptions = subs.subscriptions.filter((s) => s.subscription_id !== subscriptionId);
    this.writeSubs(subs);
  }

  // -------------------------------------------------------------------------
  // Ack persistence
  // -------------------------------------------------------------------------

  /**
   * Write an ack record for a subscription.
   * @param {string} subscriptionId
   * @param {object} ack - { event_id, status, acked_at }
   */
  writeAck(subscriptionId, ack) {
    const ackPath = path.join(this._acksDir, `${subscriptionId}.acks.jsonl`);
    const line = JSON.stringify(ack) + "\n";
    fs.appendFileSync(ackPath, line);
  }

  /**
   * Read ack history for a subscription.
   * @param {string} subscriptionId
   * @returns {object[]}
   */
  readAcks(subscriptionId) {
    const ackPath = path.join(this._acksDir, `${subscriptionId}.acks.jsonl`);
    try {
      const content = fs.readFileSync(ackPath, "utf8");
      return content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Dedupe LRU rebuild
  // -------------------------------------------------------------------------

  _rebuildDedupe() {
    const ids = this.readLastEventIds(this.dedupeLruSize);
    this._seenIds = new Map();
    for (const id of ids) {
      this._seenIds.set(id, true);
    }
  }

  getDedupeSize() {
    return this._seenIds.size;
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  close() {
    this._closed = true;
    this.releaseLock();
    if (this._fd !== null) {
      try {
        fs.closeSync(this._fd);
      } catch { /* ignore */ }
      this._fd = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createPersistence,
  Persistence,
  DEFAULT_ARCHIVE_CAP,
  DEFAULT_TOTAL_CAP,
  DEFAULT_DEDUPE_LRU_SIZE,
  SCHEMA_VERSION,
};
