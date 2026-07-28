"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { NotificationError } = require("./notification-policy");

const CURSOR_VERSION = 1;
const LOCK_TTL_MS = 30_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function validateId(value, field) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw new NotificationError("ERR_NOTIFICATION_IDENTITY", { field });
  }
}

function cursorFileName(consumerId) {
  validateId(consumerId, "consumerId");
  const digest = crypto.createHash("sha256").update(consumerId, "utf8").digest("hex");
  return `consumer-${digest}.json`;
}

function initialState(consumerId, clock) {
  return {
    version: CURSOR_VERSION,
    consumerId,
    revision: 0,
    highWater: 0,
    acknowledged: {},
    pending: {},
    updatedAt: nowIso(clock),
  };
}

function validateState(state, consumerId) {
  if (!state || state.version !== CURSOR_VERSION || state.consumerId !== consumerId) {
    throw new NotificationError("ERR_CURSOR_CORRUPT", { consumerId });
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Number.isSafeInteger(state.highWater) || state.highWater < 0 ||
      !state.acknowledged || typeof state.acknowledged !== "object" ||
      !state.pending || typeof state.pending !== "object") {
    throw new NotificationError("ERR_CURSOR_CORRUPT", { consumerId });
  }
}

class ConsumerCursorStore {
  constructor(dir, consumerId, options = {}) {
    validateId(consumerId, "consumerId");
    this.dir = dir;
    this.consumerId = consumerId;
    this.clock = options.clock || Date.now;
    this.lockTtlMs = options.lockTtlMs ?? LOCK_TTL_MS;
    this.file = path.join(dir, cursorFileName(consumerId));
    this.lockFile = `${this.file}.lock`;
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.file)) this._writeAtomic(initialState(consumerId, this.clock));
    this.read();
  }

  read() {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      throw new NotificationError("ERR_CURSOR_CORRUPT", {
        consumerId: this.consumerId,
        cause: error && error.code,
      });
    }
    validateState(state, this.consumerId);
    return clone(state);
  }

  update(mutator) {
    const release = this._acquireLock();
    try {
      const state = this.read();
      const result = mutator(state);
      state.revision += 1;
      state.updatedAt = nowIso(this.clock);
      validateState(state, this.consumerId);
      this._writeAtomic(state);
      return { state: clone(state), result };
    } finally {
      release();
    }
  }

  acknowledge(key, details = {}) {
    validateId(key, "deliveryKey");
    return this.update((state) => {
      if (state.acknowledged[key]) return false;
      state.acknowledged[key] = {
        eventId: details.eventId,
        target: details.target,
        acknowledgedAt: nowIso(this.clock),
      };
      delete state.pending[key];
      return true;
    });
  }

  recordPending(key, delivery) {
    validateId(key, "deliveryKey");
    return this.update((state) => {
      if (state.acknowledged[key]) return false;
      state.pending[key] = clone(delivery);
      return true;
    });
  }

  removePending(key) {
    return this.update((state) => {
      const existed = Boolean(state.pending[key]);
      delete state.pending[key];
      return existed;
    });
  }

  advanceHighWater(position) {
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new NotificationError("ERR_CURSOR_POSITION", { position });
    }
    return this.update((state) => {
      state.highWater = Math.max(state.highWater, position);
      return state.highWater;
    });
  }

  resetExhausted() {
    return this.update((state) => {
      let count = 0;
      for (const pending of Object.values(state.pending)) {
        if (!pending.exhausted) continue;
        pending.attempts = 0;
        pending.exhausted = false;
        pending.nextAttemptAt = nowIso(this.clock);
        count += 1;
      }
      return count;
    });
  }

  _writeAtomic(state) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const data = `${JSON.stringify(state, null, 2)}\n`;
    let fd;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.file);
      const dirFd = fs.openSync(this.dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally {
      if (fd != null) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch { /* renamed or best-effort cleanup */ }
    }
  }

  _acquireLock() {
    const token = crypto.randomBytes(16).toString("hex");
    const payload = JSON.stringify({ token, expiresAt: this.clock() + this.lockTtlMs });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        fs.writeFileSync(fd, payload, "utf8");
        fs.closeSync(fd);
        return () => {
          try {
            const current = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
            if (current.token === token) fs.unlinkSync(this.lockFile);
          } catch {
            /* already reclaimed */
          }
        };
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        let expired = false;
        let observedLock = null;
        try {
          observedLock = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
          expired = !Number.isFinite(observedLock.expiresAt) ||
            observedLock.expiresAt <= this.clock();
        } catch {
          expired = true;
        }
        if (!expired) throw new NotificationError("ERR_CURSOR_LOCKED", { consumerId: this.consumerId });
        const staleFile = `${this.lockFile}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
        try {
          fs.renameSync(this.lockFile, staleFile);
        } catch (reclaimError) {
          throw new NotificationError("ERR_CURSOR_LOCKED", {
            consumerId: this.consumerId,
            reason: reclaimError && reclaimError.code === "ENOENT"
              ? "reclaim_raced"
              : "reclaim_failed",
          });
        }
        let moved;
        try {
          moved = JSON.parse(fs.readFileSync(staleFile, "utf8"));
        } catch {
          moved = null;
        }
        if (!moved || !observedLock || moved.token !== observedLock.token) {
          try { fs.renameSync(staleFile, this.lockFile); } catch { /* fail closed below */ }
          throw new NotificationError("ERR_CURSOR_LOCKED", {
            consumerId: this.consumerId,
            reason: "reclaim_raced",
          });
        }
        try { fs.unlinkSync(staleFile); } catch { /* best effort */ }
      }
    }
    throw new NotificationError("ERR_CURSOR_LOCKED", { consumerId: this.consumerId });
  }
}

module.exports = {
  CURSOR_VERSION,
  ConsumerCursorStore,
  cursorFileName,
  initialState,
  validateState,
};
