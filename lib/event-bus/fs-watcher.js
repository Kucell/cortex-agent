"use strict";

/**
 * lib/event-bus/fs-watcher.js
 *
 * Cross-platform file watcher for the event bus.
 *
 * Wraps node:fs.watch with an automatic polling fallback.  On some platforms
 * (especially macOS network volumes and certain Linux configs) fs.watch can
 * be unreliable; this module detects failures and degrades to setInterval
 * polling.
 *
 * Features:
 *   - fs.watch primary (event-level, low latency)
 *   - Polling fallback (configurable interval, default 1000ms)
 *   - Debounce (avoid duplicate triggers within a short window)
 *   - Graceful close
 *
 * Zero npm dependencies - node:fs only.
 *
 * References:
 *   - docs/architecture/framework-event-bus-design.md §7.3 (fs.watch risk)
 *   - .agent/missions/M-004/validation-contract.json VC-004
 */

const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DEBOUNCE_MS = 50;

// ---------------------------------------------------------------------------
// FsWatcher
// ---------------------------------------------------------------------------

/**
 * Create a file watcher.
 *
 * @param {object} opts
 * @param {string} opts.filePath  - file to watch
 * @param {function} opts.onChange - callback invoked on change (no args; caller re-reads)
 * @param {number} [opts.pollFallbackMs=1000] - polling interval for fallback
 * @param {number} [opts.debounceMs=50] - debounce window
 * @returns {FsWatcher}
 */
function createFsWatcher(opts) {
  return new FsWatcher(opts);
}

class FsWatcher {
  constructor(opts) {
    this.filePath = opts.filePath;
    this.onChange = opts.onChange;
    this.pollFallbackMs = opts.pollFallbackMs || DEFAULT_POLL_INTERVAL_MS;
    this.debounceMs = opts.debounceMs !== undefined ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;

    this._fsWatcher = null;
    this._pollTimer = null;
    this._lastSize = 0;
    this._debounceTimer = null;
    this._closed = false;
    this._usingPolling = false;
  }

  /**
   * Start watching. Tries fs.watch first; falls back to polling on error.
   */
  start() {
    if (this._closed) return;

    // Initialize last known size
    try {
      this._lastSize = fs.statSync(this.filePath).size;
    } catch {
      this._lastSize = 0;
    }

    // Try fs.watch
    try {
      this._fsWatcher = fs.watch(this.filePath, (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          this._trigger();
        }
      });
      this._fsWatcher.on("error", () => {
        this._fallbackToPolling();
      });
      this._usingPolling = false;
    } catch {
      this._fallbackToPolling();
    }
  }

  /**
   * Fall back to interval-based polling.
   * @private
   */
  _fallbackToPolling() {
    if (this._usingPolling || this._closed) return;
    this._usingPolling = true;

    // Close fs.watch if still open
    if (this._fsWatcher) {
      try { this._fsWatcher.close(); } catch { /* ignore */ }
      this._fsWatcher = null;
    }

    this._pollTimer = setInterval(() => {
      if (this._closed) return;
      try {
        const stat = fs.statSync(this.filePath);
        if (stat.size !== this._lastSize) {
          this._lastSize = stat.size;
          this._trigger();
        }
      } catch {
        // File might not exist yet; ignore
      }
    }, this.pollFallbackMs);

    // Don't keep the event loop alive solely for polling
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  /**
   * Trigger the onChange callback with debounce.
   * @private
   */
  _trigger() {
    if (this._closed) return;
    if (this._debounceTimer) return; // already pending

    // Update last known size
    try {
      this._lastSize = fs.statSync(this.filePath).size;
    } catch { /* ignore */ }

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (!this._closed && typeof this.onChange === "function") {
        try {
          this.onChange();
        } catch {
          // Swallow handler errors to keep watcher alive
        }
      }
    }, this.debounceMs);
  }

  /**
   * Whether the watcher is using polling fallback.
   * @returns {boolean}
   */
  isPolling() {
    return this._usingPolling;
  }

  /**
   * Stop watching and release resources.
   */
  close() {
    this._closed = true;
    if (this._fsWatcher) {
      try { this._fsWatcher.close(); } catch { /* ignore */ }
      this._fsWatcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createFsWatcher,
  FsWatcher,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_DEBOUNCE_MS,
};
