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
  writeDispatchArtifact,
  generateRunId,
} = require("./base");

const ADAPTER_TYPE = "dsh";
const ADAPTER_VERSION = "0.1.0";
const ADAPTER_PROTOCOL = "external_v1";
const DEFAULT_BIN = "dsh";
const DEFAULT_TIMEOUT = 300;
const HEALTH_TIMEOUT_MS = 5000;
const STDERR_EXCERPT = 4096;
const STDOUT_EXCERPT = 4096;

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

  // 3. invoke — execute a real DSH dispatch.
  //    payload: { task, input, ... }
  //    options: { runId, projectRoot, agentId, configRef, credentialRef, timeout }
  //
  //    Mirrors `lib/agents/adapters/codex.js` invoke() one-for-one (with
  //    `codex` → `dsh` rename and `ERR_CODEX_*` → `ERR_DSH_*`). The DSH CLI
  //    shape is currently ASSUMED per P-006 §4.3; tests inject a fake `dsh`
  //    binary path via DSH_BIN env / options.bin (no real DSH CLI required).
  async invoke(payload = {}, options = {}) {
    const runId = options.runId || generateRunId(`R-${ADAPTER_TYPE}`);
    const projectRoot = options.projectRoot || process.cwd();
    const timeout = Number(options.timeout) || this.defaultTimeout;
    const agentId = options.agentId || payload.agent_id || null;
    const configRef = options.configRef || null;
    const credentialRef = options.credentialRef || null;
    const start = Date.now();

    // 1. Write request to journal
    const requestRecord = {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      payload: {
        task: payload.task || null,
        input: payload.input || null,
      },
      config_ref: configRef,
      credential_ref: credentialRef,
      timeout,
      cli: { bin: this.bin, shell: this.shell },
      created_at: new Date(start).toISOString(),
    };
    try {
      writeDispatchArtifact(projectRoot, runId, "request.json", requestRecord);
    } catch (err) {
      return {
        runId,
        status: "failed",
        result: null,
        error: { code: "ERR_REQUEST_WRITE_FAILED", message: err.message },
        latency_ms: 0,
      };
    }

    // 2. Build CLI args (per P-006 §4.3)
    const args = ["--json", "--run-id", runId];
    if (payload.task) args.push("--task", String(payload.task));
    if (payload.input) {
      args.push(
        "--input",
        typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input),
      );
    }
    if (configRef) args.push("--config", String(configRef));
    if (options.model) args.push("--model", String(options.model));

    // 3. Build JSON-RPC request body (sent on stdin)
    const jsonrpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "invoke",
      params: {
        run_id: runId,
        task: payload.task || null,
        input: payload.input || null,
        config_ref: configRef,
        credential_ref: credentialRef,
      },
    };
    const requestBody = JSON.stringify(jsonrpcRequest);

    // 4. Spawn the subprocess
    const spawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: projectRoot,
      shell: this.shell,
      env: {
        ...process.env,
        CORTEX_AGENT_ADAPTER: ADAPTER_TYPE,
        CORTEX_AGENT_RUN_ID: runId,
      },
    };

    let child;
    let spawnError = null;
    try {
      child = spawn(this.bin, args, spawnOptions);
    } catch (err) {
      spawnError = err;
    }

    if (spawnError || !child) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_ADAPTER_SPAWN",
          message: spawnError ? spawnError.message : "spawn returned no child",
        },
        latency_ms: Date.now() - start,
        written_at: new Date().toISOString(),
      });
    }

    // Track for cancel()
    this._trackSubprocess(runId, child);

    // 5. Write the JSON-RPC body to stdin and close
    try {
      child.stdin.write(requestBody);
      child.stdin.end();
    } catch (err) {
      this._untrackSubprocess(runId);
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: { code: "ERR_ADAPTER_STDIN", message: err.message },
        latency_ms: Date.now() - start,
        written_at: new Date().toISOString(),
      });
    }

    // 6. Accumulate stdout / stderr
    let stdoutData = "";
    let stderrData = "";
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString("utf8");
    });

    // 7. Wait for completion OR timeout.
    let timedOut = false;
    let timeoutHandle = null;
    const completionPromise = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        resolve({ code, signal, error: null });
      });
      child.on("error", (err) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        resolve({ code: -1, signal: null, error: err });
      });
    });
    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutHandle = null;
        try { child.kill("SIGTERM"); } catch (_) { /* ignore */ }
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
        }, 1500);
        resolve({ code: -1, signal: "SIGTERM", error: null, timeout: true });
      }, Math.max(1, timeout) * 1000);
    });
    const finalState = await Promise.race([completionPromise, timeoutPromise]);
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    this._untrackSubprocess(runId);
    const latency_ms = Date.now() - start;

    // 8. Branch on outcome
    if (timedOut) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "timeout",
        error: {
          code: "ERR_DISPATCH_TIMEOUT",
          message: `dispatch timed out after ${timeout}s`,
        },
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }
    if (finalState.error) {
      const isSpawnMissing = finalState.error.code === "ENOENT"
        || /ENOENT/.test(finalState.error.message || "");
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: isSpawnMissing
          ? { code: "ERR_ADAPTER_SPAWN", message: finalState.error.message }
          : { code: "ERR_DISPATCH_ERROR", message: finalState.error.message },
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }
    if (finalState.code !== 0) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_DISPATCH_FAILED",
          message: `dsh exited with code ${finalState.code}`,
          exit_code: finalState.code,
          signal: finalState.signal,
        },
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }

    // 9. Parse stdout as JSON-RPC response
    let parsed;
    try {
      parsed = this._parseJsonRpc(stdoutData);
    } catch (err) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_JSONRPC_PARSE",
          message: `failed to parse JSON-RPC response: ${err.message}`,
        },
        stdout_excerpt: stdoutData.slice(0, STDOUT_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }

    // 10. Detect JSON-RPC error envelope
    if (parsed && typeof parsed === "object" && parsed.error) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: parsed.error.code
            ? `ERR_DSH_${String(parsed.error.code).toUpperCase()}`
            : "ERR_DSH_RPC_ERROR",
          message: parsed.error.message || "DSH returned a JSON-RPC error",
          data: parsed.error.data || null,
        },
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }

    // 11. Success — write result.json + rollback.json
    const resultRecord = {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      status: "ok",
      result: parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed,
      latency_ms,
      written_at: new Date().toISOString(),
    };
    writeDispatchArtifact(projectRoot, runId, "result.json", resultRecord);
    writeDispatchArtifact(projectRoot, runId, "rollback.json", {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      status: "completed",
      reason: "real dispatch completed successfully; no rollback needed",
      written_at: new Date().toISOString(),
    });
    return resultRecord;
  }

  // 4. cancel — SIGTERM the running subprocess (if any).
  async cancel(runId, options = {}) {
    const child = this._subprocesses.get(runId);
    if (!child) {
      return {
        runId,
        cancelled: false,
        error: {
          code: "ERR_NO_RUNNING_SUBPROCESS",
          message: `no running subprocess tracked for ${runId}`,
        },
      };
    }
    try {
      child.kill("SIGTERM");
    } catch (err) {
      return {
        runId,
        cancelled: false,
        error: { code: "ERR_CANCEL_FAILED", message: err.message },
      };
    }
    this._untrackSubprocess(runId);
    return { runId, cancelled: true, error: null };
  }

  // 5. report — read the journal. We extend the base behavior with a
  //    helpful summary for the CLI surface (mirrors codex.js).
  async report(runId, options = {}) {
    const base = await super.report(runId, options);
    if (base.status === "not_found") return base;
    return {
      ...base,
      adapter_type: ADAPTER_TYPE,
      latency_ms: base.result ? base.result.latency_ms : (base.error ? base.error.latency_ms || 0 : 0),
    };
  }

  // ─── internal helpers ─────────────────────────────────────────────────────

  _parseJsonRpc(stdoutData) {
    const trimmed = (stdoutData || "").trim();
    if (!trimmed) {
      throw new Error("empty stdout from dsh CLI");
    }
    // Try plain JSON first (most common — dsh --json emits single-line JSON).
    try {
      return JSON.parse(trimmed);
    } catch (_) { /* fall through to framed parse */ }
    // Try Content-Length framed JSON-RPC (per JSON-RPC over stdio spec).
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const header = trimmed.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (match) {
        const length = parseInt(match[1], 10);
        const body = trimmed.slice(headerEnd + 4, headerEnd + 4 + length);
        return JSON.parse(body);
      }
    }
    // Also try \n\n separator (some implementations use LF).
    const lfHeaderEnd = trimmed.indexOf("\n\n");
    if (lfHeaderEnd !== -1) {
      const header = trimmed.slice(0, lfHeaderEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (match) {
        const length = parseInt(match[1], 10);
        const body = trimmed.slice(lfHeaderEnd + 2, lfHeaderEnd + 2 + length);
        return JSON.parse(body);
      }
    }
    throw new Error("not valid JSON and no Content-Length frame found");
  }

  _writeErrorAndRollback(projectRoot, runId, errorRecord) {
    let written = false;
    try {
      writeDispatchArtifact(projectRoot, runId, "error.json", errorRecord);
      written = true;
    } catch (err) {
      // Could not even write error.json — catastrophic.
      return {
        ...errorRecord,
        error: {
          ...(errorRecord.error || {}),
          journal_write_failed: true,
          journal_write_error: err.message,
        },
      };
    }
    // Try to write rollback.json. If that fails, write rollback-failed.json.
    try {
      writeDispatchArtifact(projectRoot, runId, "rollback.json", {
        run_id: runId,
        agent_id: errorRecord.agent_id,
        adapter_type: ADAPTER_TYPE,
        status: "rolled_back",
        reason: `real dispatch failed (${errorRecord.error.code}); rollback journal written`,
        original_error: errorRecord.error,
        written_at: new Date().toISOString(),
      });
    } catch (rollbackErr) {
      try {
        writeDispatchArtifact(projectRoot, runId, "rollback-failed.json", {
          run_id: runId,
          agent_id: errorRecord.agent_id,
          adapter_type: ADAPTER_TYPE,
          status: "rollback_failed",
          primary_error: errorRecord.error,
          rollback_error: {
            code: "ERR_ROLLBACK_WRITE_FAILED",
            message: rollbackErr.message,
          },
          notify_parent: true,
          written_at: new Date().toISOString(),
        });
      } catch (finalErr) {
        // eslint-disable-next-line no-console
        console.error(
          `[dsh] critical: failed to write any error/rollback for ${runId}: ${finalErr.message}`,
        );
      }
    }
    void written;
    return errorRecord;
  }

  _trackSubprocess(runId, child) {
    this._subprocesses.set(runId, child);
  }
  _untrackSubprocess(runId) {
    this._subprocesses.delete(runId);
  }

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
