"use strict";

// ─── DSH Adapter (M-029 / P-006 / MS-001) ──────────────────────────────────────
//
// Concrete adapter for the DeepSeek Harness (DSH) CLI. Promoted from a
// Token Control Plane shadow host (`D-TCP-004-add-dsh-host`) to a first-class
// dispatch adapter on par with Pi / Claude Code / Codex CLI / MiniMax.
//
// CLI invocation shape (assumed per P-006 §4.3; verified incrementally in
// MS-001 via the protocol-free health() check; full STDIO JSON-RPC behaviour
// validated in MS-003):
//
//   $ dsh --json --run-id <runId> --task "<task>" [--input <input>]
//        [--config <configRef>] [--model <model>]
//
//   stdin  : JSON-RPC 2.0 request body (single line, newline-terminated)
//   stdout : JSON-RPC 2.0 response (single line, newline-terminated)
//            — or, if --json is not used, plain-text response
//   stderr : diagnostics (non-JSON)
//
// Difference from Pi / Claude Code / Codex / MiniMax adapters:
//   - ADAPTER_TYPE === "dsh" (per `lib/agents/registry-adapter-types.js`
//     `VALID_ADAPTER_TYPES_EXT` extension path — registry.js itself is
//     M-002 frozen and stays zero-modify).
//   - Default bin is "dsh" (not claude / codex / codey / pi / minimax).
//   - Override env: DSH_BIN.
//   - Capability descriptor reports explicit fallback for capabilities the
//     DSH CLI does not yet expose (tool.before.block / context.render.observe).
//
// Differences from DSH shadow adapter (`lib/host-adapter/shadow-usage/dsh-shadow.js`):
//   - The shadow adapter only measures token usage from the on-disk DSH
//     envelope and never spawns the DSH CLI. The dispatch adapter here
//     spawns the CLI and exchanges JSON-RPC requests.
//   - Both code paths co-exist: shadow keeps governance evidence flowing for
//     TCP; dispatch handles real agent work.
//
// Hard constraints (per VC-029-G01 / architecture-design.md):
//   - Zero npm deps. node:child_process / node:fs / node:path only.
//   - No real DSH CLI call in tests — tests inject a fake binary path
//     via DSH_BIN env var (or options.bin).
//   - Pure add. base.js / claude-code.js / codex.js / pi.js / minimax.js
//     / registry.js / index.js (except the try/catch tail added in MS-002)
//     unchanged in this file's commit.

const { spawn } = require("node:child_process");
const {
  BaseAdapter,
} = require("./base");

const ADAPTER_TYPE = "dsh";
const ADAPTER_VERSION = "0.1.0";
const ADAPTER_PROTOCOL = "external_v1";
const DEFAULT_BIN = "dsh";
const DEFAULT_TIMEOUT = 300;
const HEALTH_TIMEOUT_MS = 5000;

class DshAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    this.bin = options.bin || process.env.DSH_BIN || DEFAULT_BIN;
    // Default shell:true per the M-003 MS-001 risk mitigation (macOS/Linux
    // PATH differences). Tests pass shell:false with an absolute binary path
    // to keep the spawn deterministic.
    this.shell = options.shell !== undefined ? options.shell : true;
    this.defaultTimeout = options.defaultTimeout || DEFAULT_TIMEOUT;
    // Per-instance subprocess tracking for cancel() — populated in MS-003.
    this._subprocesses = new Map();
  }

  // 1. discover — describe this adapter. Pure metadata; never touches the
  //    external runtime. Synchronous.
  discover() {
    return {
      adapter_type: ADAPTER_TYPE,
      version: ADAPTER_VERSION,
      protocol: ADAPTER_PROTOCOL,
      capabilities: [
        "text_generation",
        "code_review",
        "tool_use",
        "multi_turn",
        "long_context",
      ],
      schema: { request: 1, response: 1, journal: 1 },
      transport: "stdio-json-rpc",
      cli: { bin: this.bin, shell: this.shell },
      // Promoted from shadow host (D-TCP-004) by P-006 / M-029 MS-001.
      maturity: "stable",
      host: "deepseek-harness",
      receipt_contract: "ms-001",
      // Capability descriptor per P-001 frozen vocabulary.
      capability_descriptor: this._buildCapabilityDescriptor(),
    };
  }

  // 2. health — verify the dsh binary is reachable. Uses `which` (POSIX)
  //    or `where` (Windows). Cheap, safe to call from CLI / dashboard.
  //    Mirrors claude-code / codex / pi health check shape so
  //    `agent adapter health` output stays consistent across vendors.
  async health() {
    const start = Date.now();
    const whichBin = process.platform === "win32" ? "where" : "which";
    return new Promise((resolve) => {
      let resolved = false;
      const settle = (result) => {
        if (resolved) return;
        resolved = true;
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
          error: `spawn ${whichBin} failed: ${err.message}`,
          details: { bin: this.bin, platform: process.platform },
        });
      }
      const timeoutHandle = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
        settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: `which ${this.bin} timed out`,
          details: { bin: this.bin },
        });
      }, HEALTH_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: err.message,
          details: { bin: this.bin, platform: process.platform },
        });
      });
      child.on("exit", (code) => {
        clearTimeout(timeoutHandle);
        const latency_ms = Date.now() - start;
        if (code === 0) {
          settle({
            status: "ok",
            ready: true,
            latency_ms,
            error: null,
            details: {
              bin: this.bin,
              version: ADAPTER_VERSION,
              platform: process.platform,
            },
          });
        } else {
          settle({
            status: "down",
            ready: false,
            latency_ms,
            error: `${this.bin} not found in PATH (${whichBin} exit ${code})`,
            details: {
              bin: this.bin,
              platform: process.platform,
              PATH: process.env.PATH || "",
            },
          });
        }
      });
    });
  }

  // 3-5. invoke / cancel / report
  //
  //    - invoke() and cancel() are NOT implemented in MS-001. The BaseAdapter
  //      default `invoke()` throws ERR_ADAPTER_ABSTRACT; the default
  //      `cancel()` returns ERR_CANCEL_NOT_SUPPORTED. MS-003 will override
  //      both with the spawn + JSON-RPC + atomic journal pattern from
  //      pi.js / codex.js (mirrors claude-code.js / codex.js / pi.js one-for-one).
  //    - report() falls through to BaseAdapter.report(), which reads the
  //      dispatch journal under `.agent-runtime/dispatch/<runId>/`. Tests
  //      for report() not-found behaviour live in MS-001; full happy-path
  //      report() coverage moves to MS-003 alongside invoke().

  // _buildCapabilityDescriptor — P-001 frozen vocabulary descriptor.
  // Returns an object that passes `validateCapabilityDescriptor` from
  // lib/runtime-adapters/capability-contract.js (kept as a pure data
  // builder here so the adapter does not import the contract module; the
  // contract tests live under tests/runtime-adapters/capability-contract.test.js
  // and are extended in MS-001).
  _buildCapabilityDescriptor() {
    const detectedAt = new Date().toISOString();
    return Object.freeze({
      schema_version: "1.0",
      host: Object.freeze({
        adapter_id: ADAPTER_TYPE,
        vendor: "deepseek",
        version: ADAPTER_VERSION,
      }),
      detected_at: detectedAt,
      capabilities: Object.freeze({
        "session.boundary": Object.freeze({
          level: "explicit",
          source: "self-reported",
          reason: "DSH CLI emits session lifecycle via its on-disk envelope (D-TCP-004 backfill evidence)",
        }),
        "turn.boundary": Object.freeze({
          level: "adapter",
          source: "runtime-trace",
          reason: "DSH chunk events carry turn/step metadata; derived via the shadow usage backfill",
        }),
        "message.boundary": Object.freeze({
          level: "unobservable",
          source: "not-exposed",
          reason: "DSH CLI does not expose message-level boundary events in current version",
        }),
        "tool.before.observe": Object.freeze({
          level: "unsupported",
          source: "not-implemented",
          reason: "DSH CLI tool-before hook not yet verified — M-018 (P-006 Phase 5) conditional on real hook capability",
        }),
        "tool.before.block": Object.freeze({
          level: "unsupported",
          source: "not-implemented",
          reason: "DSH CLI tool-before block not yet verified — gated by M-018",
        }),
        "tool.update": Object.freeze({
          level: "unobservable",
          source: "not-exposed",
          reason: "DSH CLI does not expose tool update callbacks in current version",
        }),
        "context.render.observe": Object.freeze({
          level: "unsupported",
          source: "not-implemented",
          reason: "DSH CLI does not expose transformContext hook in current version",
        }),
      }),
    });
  }
}

module.exports = {
  DshAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
  DEFAULT_BIN,
  DEFAULT_TIMEOUT,
};
