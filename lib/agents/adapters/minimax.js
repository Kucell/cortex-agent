"use strict";

// ─── MiniMax CLI Adapter (M-003 MS-003 / F-006) ─────────────────────────────────
//
// Concrete adapter for the MiniMax CLI. Spawns the CLI as a subprocess and
// exchanges a JSON-RPC over stdio request, then writes the result to
// .agent-runtime/dispatch/<runId>/{request,result,error,rollback}.json.
//
// Design note: this is the 5th adapter in the M-003 set. The "mavis platform
// bridge abstraction" referenced in the mission plan means we expect the
// MiniMax CLI to be wrapped / launched by a mavis runtime bridge that handles
// cross-platform credential injection (mirroring how the AI-Brain runtime
// stack wraps the underlying model CLI). At this layer the adapter does NOT
// know about specific credentials — the platform bridge injects them. The
// adapter is therefore identical in shape to claude-code.js, with two
// differences:
//
//   1. Default binary name is `minimax` (or `mavis` if `mavisBridge: true`),
//      overridable via MINIMAX_BIN / MAVIS_BIN env vars or `options.bin`.
//   2. CLI flags + protocol namespace differ from claude-code's
//      (`--run-id` / `--task` / `--json` vs minimax's
//      `agent run --id <runId> --task <task> --json`).
//
// CLI invocation shape (FAE-001 dispatch vocabulary + M-003 spec):
//
//   $ minimax agent run --id <runId> --task "<task>" [--input <input>]
//                       [--config <configRef>] [--project <project>]
//          (OR, when options.mavisBridge === true:
//   $ mavis agent run --id <runId> --task "<task>" --bridge minimax [...])
//
//   stdin  : JSON-RPC 2.0 request body
//   stdout : JSON-RPC 2.0 response (plain JSON OR Content-Length framed)
//   stderr : diagnostics (non-JSON)
//
// Failure modes covered (mirrors claude-code.js risk matrix):
//   - binary not found       → ERR_ADAPTER_SPAWN
//   - binary exits non-zero  → ERR_DISPATCH_FAILED (with stderr excerpt)
//   - timeout                → ERR_DISPATCH_TIMEOUT (child killed via SIGTERM)
//   - stdout is not JSON     → ERR_JSONRPC_PARSE
//   - rollback write fails   → rollback-failed.json + notify_parent=true
//
// Hard constraints:
//   - Zero npm deps. node:child_process / node:fs / node:path only.
//   - No real MiniMax CLI call in tests — tests inject a fake binary path.
//   - Atomic journal writes (writeDispatchArtifact does .tmp + rename).
//   - Pure add. base.js / claude-code.js / adapters/index.js untouched.

const { spawn } = require("node:child_process");
const {
  BaseAdapter,
  writeDispatchArtifact,
  generateRunId,
} = require("./base");

const ADAPTER_TYPE = "minimax";
const ADAPTER_VERSION = "0.1.0";
const ADAPTER_PROTOCOL = "external_v1";
const DEFAULT_BIN = "minimax";
const DEFAULT_MAVIS_BIN = "mavis";
const DEFAULT_TIMEOUT = 300;
const STDERR_EXCERPT = 4096; // bytes captured to journal on failure
const STDOUT_EXCERPT = 4096; // bytes captured on JSON-RPC parse failure

class MinimaxAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    // mavisBridge: when true, the default binary becomes `mavis` and the CLI
    // surface emits `--bridge minimax` so the platform bridge knows which
    // underlying runtime to route to. This matches the AI-Brain "mavis
    // platform bridge" pattern (ai-keys run --profile <p> -- mavis-runtime ...).
    this.mavisBridge = options.mavisBridge === true;
    this.bin = options.bin
      || (this.mavisBridge
        ? (process.env.MAVIS_BIN || DEFAULT_MAVIS_BIN)
        : (process.env.MINIMAX_BIN || DEFAULT_BIN));
    this.shell = options.shell !== undefined ? options.shell : true;
    this.defaultTimeout = options.defaultTimeout || DEFAULT_TIMEOUT;
    // Per-instance subprocess tracking for cancel().
    this._subprocesses = new Map();
  }

  // 1. discover — describe this adapter. Pure metadata.
  discover() {
    return {
      adapter_type: ADAPTER_TYPE,
      version: ADAPTER_VERSION,
      protocol: ADAPTER_PROTOCOL,
      capabilities: [
        "text_generation",
        "code_review",
        "tool_use",
        "long_context",
        "platform_bridge",
      ],
      schema: { request: 1, response: 1, journal: 1 },
      transport: "stdio-json-rpc",
      bridge: this.mavisBridge ? "mavis" : "direct",
      cli: { bin: this.bin, shell: this.shell },
    };
  }

  // 2. health — verify the mavis/minimax binary is reachable. Uses `which`
  //    (POSIX) or `where` (Windows). Mirrors claude-code.js health() but
  //    surfaces the mavisBridge flag in details so the CLI display can show
  //    "via mavis" vs "direct".
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
          details: {
            bin: this.bin,
            platform: process.platform,
            bridge: this.mavisBridge ? "mavis" : "direct",
          },
        });
      }
      const timeoutHandle = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
        settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: `which ${this.bin} timed out`,
          details: { bin: this.bin, bridge: this.mavisBridge ? "mavis" : "direct" },
        });
      }, 5000);
      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: err.message,
          details: {
            bin: this.bin,
            platform: process.platform,
            bridge: this.mavisBridge ? "mavis" : "direct",
          },
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
              bridge: this.mavisBridge ? "mavis" : "direct",
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
              bridge: this.mavisBridge ? "mavis" : "direct",
              PATH: process.env.PATH || "",
            },
          });
        }
      });
    });
  }

  // 3. invoke — execute a real MiniMax dispatch (via the mavis platform
  //    bridge if mavisBridge is set). payload: { task, input, ... }
  //    options: { runId, projectRoot, agentId, configRef, credentialRef,
  //               timeout, project }
  async invoke(payload = {}, options = {}) {
    const runId = options.runId || generateRunId(`R-${ADAPTER_TYPE}`);
    const projectRoot = options.projectRoot || process.cwd();
    const timeout = Number(options.timeout) || this.defaultTimeout;
    const agentId = options.agentId || payload.agent_id || null;
    const configRef = options.configRef || null;
    const credentialRef = options.credentialRef || null;
    const project = options.project || null;
    const start = Date.now();

    // 1. Write request to journal
    const requestRecord = {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      bridge: this.mavisBridge ? "mavis" : "direct",
      payload: {
        task: payload.task || null,
        input: payload.input || null,
      },
      config_ref: configRef,
      credential_ref: credentialRef,
      project,
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

    // 2. Build CLI args. Two shapes:
    //    a) direct mode:  `minimax agent run --id <runId> --task <task> --json`
    //    b) mavis bridge: `mavis agent run --id <runId> --task <task> --bridge minimax`
    const args = ["agent", "run", "--json"];
    if (this.mavisBridge) args.push("--bridge", ADAPTER_TYPE);
    args.push("--id", runId);
    if (payload.task) args.push("--task", String(payload.task));
    if (payload.input) {
      args.push(
        "--input",
        typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input),
      );
    }
    if (configRef) args.push("--config", String(configRef));
    if (project) args.push("--project", String(project));

    // 3. Build JSON-RPC request body (sent on stdin). Mirrors claude-code.js.
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
        bridge: this.mavisBridge ? "mavis" : "direct",
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
        CORTEX_AGENT_BRIDGE: this.mavisBridge ? "mavis" : "direct",
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
        bridge: this.mavisBridge ? "mavis" : "direct",
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
        bridge: this.mavisBridge ? "mavis" : "direct",
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
        bridge: this.mavisBridge ? "mavis" : "direct",
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
        bridge: this.mavisBridge ? "mavis" : "direct",
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
        bridge: this.mavisBridge ? "mavis" : "direct",
        status: "failed",
        error: {
          code: "ERR_DISPATCH_FAILED",
          message: `${this.bin} exited with code ${finalState.code}`,
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
        bridge: this.mavisBridge ? "mavis" : "direct",
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
        bridge: this.mavisBridge ? "mavis" : "direct",
        status: "failed",
        error: {
          code: parsed.error.code
            ? `ERR_MINIMAX_${String(parsed.error.code).toUpperCase()}`
            : "ERR_MINIMAX_RPC_ERROR",
          message: parsed.error.message || "MiniMax returned a JSON-RPC error",
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
      bridge: this.mavisBridge ? "mavis" : "direct",
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
      bridge: this.mavisBridge ? "mavis" : "direct",
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

  // 5. report — read the journal. Extends base behavior with adapter_type
  //    + bridge metadata + latency_ms at top level for CLI display. We
  //    always include adapter_type + bridge, even for the not_found branch,
  //    so the CLI surface can render a consistent shape.
  async report(runId, options = {}) {
    const base = await super.report(runId, options);
    return {
      ...base,
      adapter_type: ADAPTER_TYPE,
      bridge: this.mavisBridge ? "mavis" : "direct",
      latency_ms: base.result
        ? base.result.latency_ms
        : (base.error ? (base.error.latency_ms || 0) : 0),
    };
  }

  // ─── internal helpers ─────────────────────────────────────────────────────

  // _parseJsonRpc — identical to claude-code.js (plain JSON first, then CRLF
  // and LF Content-Length framed). Kept as a private method so 3rd-party
  // adapter authors can copy this pattern. If a future minimax CLI variant
  // diverges, override here without touching claude-code.js.
  _parseJsonRpc(stdoutData) {
    const trimmed = (stdoutData || "").trim();
    if (!trimmed) {
      throw new Error("empty stdout from minimax CLI");
    }
    try {
      return JSON.parse(trimmed);
    } catch (_) { /* fall through to framed parse */ }
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
      return {
        ...errorRecord,
        error: {
          ...(errorRecord.error || {}),
          journal_write_failed: true,
          journal_write_error: err.message,
        },
      };
    }
    try {
      writeDispatchArtifact(projectRoot, runId, "rollback.json", {
        run_id: runId,
        agent_id: errorRecord.agent_id,
        adapter_type: ADAPTER_TYPE,
        bridge: this.mavisBridge ? "mavis" : "direct",
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
          bridge: this.mavisBridge ? "mavis" : "direct",
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
          `[minimax] critical: failed to write any error/rollback for ${runId}: ${finalErr.message}`,
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
}

module.exports = {
  MinimaxAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
};
