"use strict";

// ─── Codey Adapter (M-003 MS-002 / F-004) ───────────────────────────────────────
//
// Concrete adapter for the Codey CLI (Google's Codey models: code-bison,
// codechat-bison, text-bison). Spawns the CLI as a subprocess, exchanges a
// line-based JSON request, and writes the result to
// .agent-runtime/dispatch/<runId>/{request,result,error,rollback}.json.
//
// CLI invocation shape (line-based generic protocol — chosen because no
// first-party `codey` CLI is widely published; the line-based JSON wire is
// the most common convention for similar CLIs and matches FAE-001 dispatch
// vocabulary §"line-protocol"):
//
//   $ codey --model <model> --task "<task>" [--input <input>]
//           [--run-id <runId>] [--config <configRef>]
//
//   stdin  : single line of JSON-RPC 2.0 request body (newline-terminated)
//   stdout : single line of JSON-RPC 2.0 response (newline-terminated)
//            — or, if the CLI prefers a plain-text mode, a single line
//              prefixed with `OUT:` followed by the text payload
//   stderr : diagnostics (non-JSON, captured to journal on failure)
//
// Failure modes covered (mirrors claude-code.js for consistency):
//   - binary not found       → ERR_ADAPTER_SPAWN
//   - binary exits non-zero  → ERR_DISPATCH_FAILED (with stderr excerpt)
//   - timeout                → ERR_DISPATCH_TIMEOUT (child killed via SIGTERM)
//   - stdout is not JSON     → ERR_JSONRPC_PARSE (line-protocol parse)
//   - rollback write fails   → rollback-failed.json + notify_parent=true
//
// Hard constraints:
//   - Zero npm deps. node:child_process / node:fs / node:path only.
//   - No real codey CLI call in tests — tests inject a fake binary path
//     via CODEY_BIN env var (or options.bin).
//   - Atomic journal writes (writeDispatchArtifact does .tmp + rename).
//   - Pure add. base.js / claude-code.js / index.js unchanged.

const { spawn } = require("node:child_process");
const adapters = require("./index");
const {
  BaseAdapter,
  writeDispatchArtifact,
  generateRunId,
} = require("./base");

const ADAPTER_TYPE = "codey";
const ADAPTER_VERSION = "0.1.0";
const ADAPTER_PROTOCOL = "external_v1";
const DEFAULT_BIN = "codey";
const DEFAULT_TIMEOUT = 300;
const STDERR_EXCERPT = 4096;
const STDOUT_EXCERPT = 4096;

class CodeyAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    this.bin = options.bin || process.env.CODEY_BIN || DEFAULT_BIN;
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
        "code_completion",
        "code_chat",
        "text_generation",
        "code_review",
      ],
      schema: { request: 1, response: 1, journal: 1 },
      transport: "stdio-line-protocol",
      cli: { bin: this.bin, shell: this.shell },
    };
  }

  // 2. health — verify the codey binary is reachable. Uses `which` (POSIX)
  //    or `where` (Windows). Cheap, safe to call from CLI / dashboard.
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
      }, 5000);
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

  // 3. invoke — execute a real Codey dispatch.
  //    payload: { task, input, model? }
  //    options: { runId, projectRoot, agentId, configRef, credentialRef, timeout }
  async invoke(payload = {}, options = {}) {
    const runId = options.runId || generateRunId(`R-${ADAPTER_TYPE}`);
    const projectRoot = options.projectRoot || process.cwd();
    const timeout = Number(options.timeout) || this.defaultTimeout;
    const agentId = options.agentId || payload.agent_id || null;
    const configRef = options.configRef || null;
    const credentialRef = options.credentialRef || null;
    const model = payload.model || "code-bison";
    const start = Date.now();

    // 1. Write request to journal
    const requestRecord = {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      payload: {
        task: payload.task || null,
        input: payload.input || null,
        model,
      },
      config_ref: configRef,
      credential_ref: credentialRef,
      timeout,
      cli: { bin: this.bin, shell: this.shell, model },
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

    // 2. Build CLI args. Codey uses a simple flag-based surface.
    const args = [
      "--model", model,
      "--run-id", runId,
    ];
    if (payload.task) args.push("--task", String(payload.task));
    if (payload.input) {
      args.push(
        "--input",
        typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input),
      );
    }
    if (configRef) args.push("--config", String(configRef));

    // 3. Build the line-protocol request body (sent on stdin as a single
    //    JSON line, newline-terminated). This mirrors claude-code.js's
    //    JSON-RPC shape so the journal payload schema is consistent across
    //    vendors — 3rd-party tools can rely on `params.run_id / task / input`
    //    being present in request.json regardless of which adapter wrote it.
    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "invoke",
      params: {
        run_id: runId,
        model,
        task: payload.task || null,
        input: payload.input || null,
        config_ref: configRef,
        credential_ref: credentialRef,
      },
    });

    // 4. Spawn the subprocess
    const spawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: projectRoot,
      shell: this.shell,
      env: {
        ...process.env,
        CORTEX_AGENT_ADAPTER: ADAPTER_TYPE,
        CORTEX_AGENT_RUN_ID: runId,
        CORTEX_AGENT_MODEL: model,
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

    // 5. Write the line-protocol body to stdin (single line + close).
    try {
      child.stdin.write(requestBody + "\n");
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

    // 6. Accumulate stdout / stderr line by line. Codey's wire protocol
    //    emits a single JSON line on stdout, but we accumulate everything
    //    so a multi-line response (rare) still parses via the last non-
    //    empty line, with a fallback to joining.
    const stdoutLines = [];
    const stderrChunks = [];
    let stdoutRemainder = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutRemainder += text;
      // Split on newlines; if the chunk doesn't end in \n, keep the tail
      // as remainder so a multi-chunk split line still parses as one.
      const parts = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = parts.pop() || "";
      for (const line of parts) {
        if (line.length > 0) stdoutLines.push(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk.toString("utf8"));
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
    const stderrData = stderrChunks.join("");

    // Flush any leftover stdout remainder (process exited without final \n).
    if (stdoutRemainder.length > 0) {
      stdoutLines.push(stdoutRemainder);
    }

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
          message: `codey exited with code ${finalState.code}`,
          exit_code: finalState.code,
          signal: finalState.signal,
        },
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }

    // 9. Parse the line-protocol response. We treat the last non-empty
    //    stdout line as the response payload; this lets the CLI emit
    //    progress / telemetry lines (e.g. "thinking…", "downloading model…")
    //    before the final JSON-RPC reply.
    let parsed;
    try {
      parsed = this._parseLineProtocol(stdoutLines);
    } catch (err) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_JSONRPC_PARSE",
          message: `failed to parse line-protocol response: ${err.message}`,
        },
        stdout_excerpt: stdoutLines.join("\n").slice(0, STDOUT_EXCERPT),
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
            ? `ERR_CODEY_${String(parsed.error.code).toUpperCase()}`
            : "ERR_CODEY_RPC_ERROR",
          message: parsed.error.message || "Codey returned a JSON-RPC error",
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
  //    helpful summary for the CLI surface.
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

  // Parse the line-protocol response. The last non-empty line must be valid
  // JSON-RPC 2.0 (or a plain JSON object). Trailing telemetry lines that
  // aren't JSON are tolerated and ignored.
  _parseLineProtocol(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error("no stdout lines from codey CLI");
    }
    let lastErr = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // Also tolerate "OUT: ..." plain-text lines as a fallback (some
      // vendors wrap their answer in a prefix when invoked without --json).
      if (line.startsWith("OUT:")) {
        return { jsonrpc: "2.0", id: 1, result: { text: line.slice(4).trim() } };
      }
      try {
        return JSON.parse(line);
      } catch (err) {
        lastErr = err;
        // Keep trying earlier lines in case the trailing line is progress
        // telemetry that isn't JSON.
      }
    }
    throw new Error(
      `no parseable JSON line in ${lines.length} stdout lines: ${lastErr ? lastErr.message : "unknown"}`,
    );
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
          `[codey] critical: failed to write any error/rollback for ${runId}: ${finalErr.message}`,
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
  CodeyAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
};

// ─── self-register (per bin/cli.js "Codey/Pi 自注册到 'agent adapter list' 即可") ─
//
// This side-effect runs at module-load time. Tests import this module
// directly to trigger registration. For real CLI use, require this module
// once at startup (e.g. via `node -r ./lib/agents/adapters/codey-pi-bootstrap.js
// bin/cli.js ...`) — see codey-pi-bootstrap.js for the one-liner.
adapters.register(ADAPTER_TYPE, CodeyAdapter);
