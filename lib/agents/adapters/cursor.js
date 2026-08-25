"use strict";

// ─── Cursor Adapter (M-031 MS-001 / F-031-001) ────────────────────────────────
//
// Observer-mode adapter for the Cursor IDE CLI (cursor.sh / cursor.com).
// Phase 1 scope (per P-007 approved revision 4c50a96c...):
//   - discover  : returns the approved observer envelope (read-only metadata)
//   - health    : probes for `cursor` binary via `which` / `where`
//   - report    : delegates to BaseAdapter default journal reader
//   - invoke    : rejects with ERR_DISPATCH_OBSERVER_ONLY (no real dispatch yet)
//   - cancel    : returns "not_supported" (no subprocess state in observer mode)
//
// Why observer-mode and not full dispatch:
//   - cursor is the "空指针" gap closed by M-031 MS-001 (SUPPORTED_HOSTS
//     and HOSTS already listed it, but no BaseAdapter subclass existed)
//   - the proposal fixes the registry gap; full invoke/cancel parity is
//     deferred to a separate revision so this milestone stays additive
//   - Cursor's actual dispatch surface (chat / composer / agent mode) is
//     still under audit; we do not invent a fake protocol
//
// Hard constraints (per VC-031-001-01..05 + DRIFT-001):
//   - Zero npm deps (node:child_process / node:fs / node:path only)
//   - No real Cursor CLI call in tests — FAKE_CURSOR_BIN injection
//   - Does NOT mutate Task / Run / Decision / Waitpoint state
//   - Does NOT claim context / tool hooks that are unsupported
//   - Does NOT read private IDE state (no private IDE directory scan)

const { spawn } = require("node:child_process");
const { BaseAdapter } = require("./base");

const ADAPTER_TYPE = "cursor";
const ADAPTER_VERSION = "0.1.0-m031-ms001";
const ADAPTER_PROTOCOL = "observer_v1";
const DEFAULT_BIN = "cursor";
const DEFAULT_TIMEOUT = 5_000; // observer health probe — bounded

class CursorAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    this.bin = options.bin || process.env.CURSOR_BIN || DEFAULT_BIN;
    this.shell = options.shell !== undefined ? options.shell : true;
    this.defaultTimeout = options.defaultTimeout || DEFAULT_TIMEOUT;
    // No live subprocess tracking — observer mode never spawns long-running
    // work. The Map exists only so the subclass shape matches future
    // invoke()-bearing adapters; cancel() always reports "not_supported".
    this._subprocesses = new Map();
  }

  // 1. discover — pure metadata. Read-only, synchronous, no side effects.
  discover() {
    return {
      adapter_type: ADAPTER_TYPE,
      version: ADAPTER_VERSION,
      protocol: ADAPTER_PROTOCOL,
      capabilities: [
        "editor_discovery",
        "binary_health_check",
        "capability_snapshot",
      ],
      schema: { request: 0, response: 0, journal: 1 },
      transport: "stdio-observer",
      cli: { bin: this.bin, shell: this.shell },
      observer: true,
      invoke_supported: false,
      cancel_supported: false,
    };
  }

  // 2. health — verify the cursor binary is reachable.
  //    Mirrors the claude-code / codex health check shape so
  //    `cortex-agent agent adapter health` output stays consistent.
  //    Returns ERR_ADAPTER_TIMEOUT if the probe exceeds defaultTimeout.
  async health() {
    const start = Date.now();
    const whichBin = process.platform === "win32" ? "where" : "which";
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let child;
      try {
        child = spawn(whichBin, [this.bin], {
          stdio: "ignore",
          shell: this.shell,
        });
      } catch (err) {
        return settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: {
            code: "ERR_ADAPTER_SPAWN",
            message: err.message,
          },
          details: { bin: this.bin },
        });
      }
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) { /* noop */ }
        settle({
          status: "timeout",
          ready: false,
          latency_ms: Date.now() - start,
          error: {
            code: "ERR_ADAPTER_TIMEOUT",
            message: `cursor binary lookup exceeded ${this.defaultTimeout}ms`,
          },
          details: { bin: this.bin, timeout_ms: this.defaultTimeout },
        });
      }, this.defaultTimeout);

      child.on("error", (err) => {
        clearTimeout(timer);
        settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: {
            code: "ERR_ADAPTER_SPAWN",
            message: err.message,
          },
          details: { bin: this.bin },
        });
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          settle({
            status: "ok",
            ready: true,
            latency_ms: Date.now() - start,
            error: null,
            details: { bin: this.bin },
          });
        } else {
          settle({
            status: "down",
            ready: false,
            latency_ms: Date.now() - start,
            error: {
              code: "ERR_ADAPTER_BINARY_NOT_FOUND",
              message: `cursor binary not found in PATH (exit ${code})`,
            },
            details: { bin: this.bin, exit_code: code },
          });
        }
      });
    });
  }

  // 3. invoke — REJECT. Observer mode has no real dispatch surface.
  //    Callers wanting read-only capability data should use
  //    `host-runtime-snapshots` (lib/runtime-adapters/host-runtime-snapshots.js).
  async invoke(payload, options = {}) {
    const err = new Error(
      `CursorAdapter.invoke: not supported in observer mode (M-031 MS-001, Phase 1). ` +
      `Use host-runtime-snapshots for read-only capability data.`,
    );
    err.code = "ERR_DISPATCH_OBSERVER_ONLY";
    err.adapter_type = ADAPTER_TYPE;
    err.observer = true;
    err.payload_keys = Object.keys(payload || {});
    throw err;
  }

  // 4. cancel — no-op (observer has no running subprocess state).
  //    Matches BaseAdapter default contract shape; explicit for clarity.
  async cancel(runId, options = {}) {
    return {
      runId,
      cancelled: false,
      error: {
        code: "ERR_CANCEL_NOT_SUPPORTED",
        message: "CursorAdapter.cancel: observer mode has no subprocess state",
      },
    };
  }

  // 5. report — delegate to BaseAdapter default (journal reader).
  //    No vendor-specific telemetry needed in Phase 1.
}

module.exports = {
  CursorAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
};
