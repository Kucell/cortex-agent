"use strict";

/**
 * Notification runtime: turns the stateless `NotificationPump` into a
 * long-lived service.
 *
 * Wake-up model — two independent sources, deliberately:
 *   1. `fs.watch` on the journal directory gives near-zero latency when the
 *      platform delivers events.
 *   2. An internal exponential backoff timer guarantees forward progress when
 *      it does not. fs.watch is unreliable across platforms and filesystems
 *      (network mounts, containers, editors that replace files), so it is
 *      treated as an optimisation, never as the mechanism of record.
 *
 * The loop is single-flight: exactly one `runOnce` is in flight at a time, and
 * a wake-up that arrives mid-cycle sets a "dirty" flag so the next cycle runs
 * immediately instead of being lost.
 */

const fs = require("fs");
const { EventEmitter } = require("events");

const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_MAX_INTERVAL_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

class NotificationRuntimeError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "NotificationRuntimeError";
    this.code = code;
    this.details = details;
  }
}

function positiveInteger(value, fallback, field) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new NotificationRuntimeError("ERR_NOTIFICATION_RUNTIME_CONFIG", { field, value });
  }
  return resolved;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    if (typeof timer.unref === "function") timer.unref();
    function done() {
      clearTimeout(timer);
      signal.removeListener("wake", done);
      resolve();
    }
    signal.once("wake", done);
  });
}

class NotificationRuntime extends EventEmitter {
  constructor(options) {
    super();
    if (!options || !options.pump || typeof options.pump.runOnce !== "function") {
      throw new TypeError("pump with runOnce() is required");
    }
    this.pump = options.pump;
    this.consumerId = options.consumerId || options.pump.consumerId || null;
    this.journalDir = options.journalDir || null;
    this.minIntervalMs = positiveInteger(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, "minIntervalMs");
    this.maxIntervalMs = positiveInteger(options.maxIntervalMs, DEFAULT_MAX_INTERVAL_MS, "maxIntervalMs");
    if (this.maxIntervalMs < this.minIntervalMs) {
      throw new NotificationRuntimeError("ERR_NOTIFICATION_RUNTIME_CONFIG", {
        field: "maxIntervalMs",
        value: this.maxIntervalMs,
      });
    }
    this.stopTimeoutMs = positiveInteger(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs");
    this.statusStore = options.statusStore;
    this.stopOnError = options.stopOnError === true;
    this.watchFactory = options.watchFactory || ((dir, listener) =>
      fs.watch(dir, { persistent: false }, listener));

    this._state = "idle";
    this._running = false;
    this._stopping = false;
    this._dirty = false;
    this._cycles = 0;
    this._backoffMs = this.minIntervalMs;
    this._lastReport = null;
    this._lastError = null;
    this._watcher = null;
    this._signal = new EventEmitter();
    this._signal.setMaxListeners(0);
    this._inFlight = null;
  }

  /** One pump cycle. Safe to call standalone (`pump once`). */
  async runOnce() {
    this._inFlight = this.pump.runOnce();
    try {
      const report = await this._inFlight;
      this._cycles += 1;
      this._lastReport = report;
      this._lastError = null;
      return report;
    } catch (error) {
      this._cycles += 1;
      this._lastError = error;
      throw error;
    } finally {
      this._inFlight = null;
      this._persist();
    }
  }

  /**
   * Run until `stop()`. Resolves once the loop has drained; rejects only when
   * `stopOnError` is set and a cycle throws.
   */
  async watch() {
    if (this._running) {
      throw new NotificationRuntimeError("ERR_NOTIFICATION_RUNTIME_ACTIVE", {
        consumerId: this.consumerId,
      });
    }
    this._running = true;
    this._stopping = false;
    this._state = "running";
    this._backoffMs = this.minIntervalMs;
    this._startWatcher();
    this._persist();

    try {
      while (!this._stopping) {
        this._dirty = false;
        let report = null;
        let failed = null;
        try {
          report = await this.runOnce();
        } catch (error) {
          failed = error;
          if (this.stopOnError) throw error;
          // Otherwise the loop is deliberately resilient: a broken adapter or a
          // transient FS error must not take the service down. The pump has
          // already recorded per-delivery retry state durably.
          this.emit("error", error);
        }

        // Reset the interval whenever the cycle did something useful, so a
        // busy period stays responsive; otherwise decay towards the cap.
        const productive = Boolean(
          report && (report.delivered || report.acknowledged || report.failed)
        );
        this._backoffMs = productive || failed
          ? this.minIntervalMs
          : Math.min(this.maxIntervalMs, this._backoffMs * 2);

        this.emit("cycle", {
          report,
          error: failed,
          cycles: this._cycles,
          backoffMs: this._backoffMs,
        });

        if (this._stopping) break;
        // A wake-up during the cycle must not be lost to the sleep.
        if (this._dirty) continue;
        await sleep(this._backoffMs, this._signal);
      }
    } finally {
      this._stopWatcher();
      // Never leave a delivery half-observed: drain before reporting stopped.
      if (this._inFlight) {
        try { await this._inFlight; } catch { /* already recorded */ }
      }
      this._running = false;
      this._stopping = false;
      this._state = "stopped";
      this._persist();
      this._signal.emit("stopped");
    }
  }

  /** Graceful stop. Idempotent, and a no-op when not watching. */
  async stop() {
    if (!this._running) {
      this._stopping = false;
      return;
    }
    this._stopping = true;
    this._wake();
    await new Promise((resolve) => {
      if (!this._running) return resolve();
      const timer = setTimeout(finish, this.stopTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      function finish() {
        clearTimeout(timer);
        resolve();
      }
      this._signal.once("stopped", finish);
    });
  }

  status() {
    return {
      state: this._state,
      consumerId: this.consumerId,
      cycles: this._cycles,
      backoffMs: this._backoffMs,
      lastReport: this._lastReport,
      lastError: this._lastError
        ? {
          code: this._lastError.code || "ERR_NOTIFICATION_RUNTIME",
          message: String(this._lastError.message || this._lastError),
        }
        : null,
    };
  }

  /** Test/diagnostic helper: resolve once at least `count` cycles have run. */
  waitForCycle(count, timeoutMs = 5000) {
    if (this._cycles >= count) return Promise.resolve(this._cycles);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("cycle", onCycle);
        reject(new NotificationRuntimeError("ERR_NOTIFICATION_RUNTIME_TIMEOUT", { count }));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const onCycle = () => {
        if (this._cycles < count) return;
        clearTimeout(timer);
        this.removeListener("cycle", onCycle);
        resolve(this._cycles);
      };
      this.on("cycle", onCycle);
    });
  }

  waitForIdle(timeoutMs = 5000) {
    return this.waitForCycle(1, timeoutMs);
  }

  _wake() {
    this._dirty = true;
    this._signal.emit("wake");
  }

  _startWatcher() {
    if (!this.journalDir) return;
    try {
      this._watcher = this.watchFactory(this.journalDir, () => this._wake());
      if (this._watcher && typeof this._watcher.on === "function") {
        // A watcher error must degrade to the backoff timer, not crash the loop.
        this._watcher.on("error", () => this._stopWatcher());
      }
    } catch {
      this._watcher = null;
    }
  }

  _stopWatcher() {
    if (!this._watcher) return;
    try { this._watcher.close(); } catch { /* best effort */ }
    this._watcher = null;
  }

  _persist() {
    if (!this.statusStore || typeof this.statusStore.write !== "function") return;
    try {
      this.statusStore.write({ ...this.status(), pid: process.pid });
    } catch {
      // Status is diagnostic: never let it break delivery.
    }
  }
}

module.exports = {
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  NotificationRuntime,
  NotificationRuntimeError,
};
