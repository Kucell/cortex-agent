"use strict";

// ─── Real Dispatch Execution (M-003 MS-001 / F-009 partial) ────────────────────
//
// HTTP-based real dispatch execution. Takes a plan (URL, method, headers,
// body, timeout) and POSTs it, with 3-retry + per-attempt decision step
// (D-FAE-002-4). MS-001 ships the HTTP protocol only; MS-004 adds CLI / file
// protocols (per validation contract AC #4 + mission plan §MS-004).
//
// Failure handling (per D-FAE-002-4 + the M-003 MS-001 risk #4 mitigation):
//   1. Try the HTTP request with the configured timeout.
//   2. On 5xx / network error / timeout → call decision step.
//   3. Decision step returns "retry" (backoff + try again) or
//      "rollback" (write rollback.json) or "abort" (stop, no rollback).
//   4. After maxRetries attempts, write rollback.json anyway and
//      return a structured error.
//
// Journal (per F-001 contract):
//   - request.json written before the first attempt
//   - result.json / error.json written on terminal state
//   - rollback.json (or rollback-failed.json) always written
//
// Hard constraints:
//   - Zero npm deps. node:http / node:https / node:url only.
//   - No fetch (engines.node: ">=14.0.0" — fetch not guaranteed).
//   - Pure addition. No file in lib/agents/ (M-002 5/5) is modified.

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const {
  writeDispatchArtifact,
  ensureDispatchDir,
  generateRunId,
} = require("./adapters/base");

const DEFAULT_TIMEOUT = 30; // seconds per attempt
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5000;

// ─── default decision step (per D-FAE-002-4) ────────────────────────────────

// Maps an attempt outcome to one of: "retry" | "rollback" | "abort".
// `attempt` is 0-indexed (0 = first try, 1 = second try, etc.).
// `err` is the failure (may be null for success — caller should not call
// decision() in the success path).
function defaultDecision(attempt, err) {
  // Exhausted retries → always rollback.
  if (attempt >= DEFAULT_MAX_RETRIES - 1) return "rollback";
  // 5xx → retry (server may recover).
  if (err && err.statusCode && err.statusCode >= 500) return "retry";
  // 4xx (except 408/429) → abort (caller error, no point retrying).
  if (err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    if (err.statusCode === 408 || err.statusCode === 429) return "retry";
    return "abort";
  }
  // Network errors → retry (transient).
  if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" ||
              err.code === "ETIMEDOUT" || err.code === "ENOTFOUND" ||
              err.code === "EAI_AGAIN")) {
    return "retry";
  }
  // Unknown error → rollback to be safe.
  return "rollback";
}

// ─── HTTP transport (no fetch — uses node:http / node:https) ────────────────

function httpRequest({ url, method, headers, body, timeout, requestOptions }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      const e = new Error(`dispatch-execute: invalid url: ${err.message}`);
      e.code = "ERR_DISPATCH_URL_INVALID";
      return reject(e);
    }
    const isHttps = parsed.protocol === "https:";
    const client = isHttps ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: (parsed.pathname || "/") + (parsed.search || ""),
      method,
      headers: headers || {},
      ...(requestOptions || {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const latency_ms = Date.now() - req.startTime;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
            latency_ms,
          });
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 256)}`);
          err.statusCode = res.statusCode;
          err.responseBody = text;
          err.latency_ms = latency_ms;
          reject(err);
        }
      });
    });
    req.startTime = Date.now();
    req.on("error", (err) => {
      // Includes socket errors (ECONNREFUSED, ECONNRESET, etc.) and our
      // own req.destroy(err) calls (e.g. for timeout).
      reject(err);
    });
    if (timeout && timeout > 0) {
      req.setTimeout(Math.max(1, timeout) * 1000, () => {
        const err = new Error(`dispatch-execute: request timed out after ${timeout}s`);
        err.code = "ETIMEDOUT";
        req.destroy(err);
      });
    }
    if (body !== undefined && body !== null) {
      const data = typeof body === "string" ? body : Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!headers || !headers["Content-Length"]) {
        req.setHeader("Content-Length", Buffer.byteLength(data));
      }
      req.write(data);
    }
    req.end();
  });
}

// ─── main entry point ──────────────────────────────────────────────────────

/**
 * Execute a real HTTP dispatch with retry + decision step.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} [opts.runId]      - auto-generated if absent
 * @param {string} opts.url          - target URL
 * @param {string} [opts.method]     - default "POST"
 * @param {object} [opts.headers]    - extra HTTP headers
 * @param {string|Buffer|object} [opts.body]
 * @param {number} [opts.timeout]    - per-attempt timeout in seconds
 * @param {number} [opts.maxRetries] - default 3 (D-FAE-002-4)
 * @param {number} [opts.backoffMs]  - initial backoff in ms; doubled each retry
 * @param {string} [opts.agentType]  - for journal tagging (e.g. "claude-code")
 * @param {string} [opts.configRef]
 * @param {string} [opts.credentialRef]
 * @param {function} [opts.decision] - (attempt, err) => "retry"|"rollback"|"abort"
 * @param {function} [opts.transport] - for tests: custom transport (url, method, headers, body, timeout) => Promise<{statusCode, headers, body, latency_ms}>
 * @returns {Promise<{runId, status, result?, error?, attempts, latency_ms, decision_log}>}
 */
async function dispatchExecute({
  projectRoot = process.cwd(),
  runId,
  url,
  method = "POST",
  headers = {},
  body = null,
  timeout = DEFAULT_TIMEOUT,
  maxRetries = DEFAULT_MAX_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  agentType = null,
  configRef = null,
  credentialRef = null,
  decision = defaultDecision,
  transport = null,
} = {}) {
  if (!url) {
    const err = new Error("dispatchExecute: url required");
    err.code = "ERR_DISPATCH_URL_REQUIRED";
    throw err;
  }
  const rid = runId || generateRunId("R-dispatch");
  const start = Date.now();
  const decision_log = [];

  // 1. Write request.json before any attempt (audit trail).
  try {
    ensureDispatchDir(projectRoot, rid);
    writeDispatchArtifact(projectRoot, rid, "request.json", {
      run_id: rid,
      url,
      method,
      headers,
      body: body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body)),
      timeout,
      max_retries: maxRetries,
      backoff_ms: backoffMs,
      agent_type: agentType,
      config_ref: configRef,
      credential_ref: credentialRef,
      created_at: new Date(start).toISOString(),
    });
  } catch (err) {
    // Request write failed — catastrophic, can't even journal.
    return {
      runId: rid,
      status: "failed",
      error: { code: "ERR_REQUEST_WRITE_FAILED", message: err.message },
      attempts: 0,
      latency_ms: 0,
      decision_log: [],
    };
  }

  // 2. Retry loop
  const finalMaxRetries = Math.max(1, maxRetries);
  const transportFn = transport || httpRequest;
  let lastError = null;

  for (let attempt = 0; attempt < finalMaxRetries; attempt++) {
    let result = null;
    let err = null;
    try {
      result = await transportFn({ url, method, headers, body, timeout });
    } catch (e) {
      err = e;
    }

    if (!err) {
      // 3a. Success — write result + rollback
      const latency_ms = Date.now() - start;
      writeDispatchArtifact(projectRoot, rid, "result.json", {
        run_id: rid,
        status: "ok",
        result: {
          statusCode: result.statusCode,
          headers: result.headers,
          body: result.body,
        },
        attempt: attempt + 1,
        latency_ms,
        written_at: new Date().toISOString(),
      });
      writeDispatchArtifact(projectRoot, rid, "rollback.json", {
        run_id: rid,
        status: "completed",
        reason: "real dispatch completed successfully; no rollback needed",
        attempt: attempt + 1,
        written_at: new Date().toISOString(),
      });
      return {
        runId: rid,
        status: "ok",
        result: {
          statusCode: result.statusCode,
          headers: result.headers,
          body: result.body,
        },
        attempt: attempt + 1,
        latency_ms,
        decision_log,
      };
    }

    // 3b. Failure — consult the decision step
    lastError = err;
    let action;
    try {
      action = decision(attempt, err);
    } catch (decisionErr) {
      // Decision itself threw — default to rollback (safe).
      action = "rollback";
      decision_log.push({
        attempt: attempt + 1,
        decision: "rollback",
        note: `decision step threw: ${decisionErr.message}; defaulting to rollback`,
      });
    }
    if (!["retry", "rollback", "abort"].includes(action)) {
      action = "rollback";
    }
    decision_log.push({
      attempt: attempt + 1,
      decision: action,
      error_code: err.code || null,
      status_code: err.statusCode || null,
      message: err.message,
    });

    if (action === "retry" && attempt < finalMaxRetries - 1) {
      // Exponential backoff with cap
      const sleepMs = Math.min(backoffMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }
    if (action === "abort") {
      // Caller decision: stop, no rollback (caller will handle cleanup).
      break;
    }
    // action === "rollback" OR retries exhausted → break and rollback.
    break;
  }

  // 4. Write error.json + rollback.json (or rollback-failed.json on failure).
  return _writeErrorAndRollback({
    projectRoot, runId: rid, error: lastError, attempts: decision_log.length,
    latency_ms: Date.now() - start, decision_log,
  });
}

function _writeErrorAndRollback({ projectRoot, runId, error, attempts, latency_ms, decision_log }) {
  const errorRecord = {
    run_id: runId,
    status: "failed",
    error: {
      code: error.code || `ERR_HTTP_${error.statusCode || "UNKNOWN"}`,
      message: error.message || "dispatch failed",
      status_code: error.statusCode || null,
      response_body: error.responseBody ? error.responseBody.slice(0, 4096) : null,
    },
    attempts,
    latency_ms,
    decision_log,
    written_at: new Date().toISOString(),
  };
  try {
    writeDispatchArtifact(projectRoot, runId, "error.json", errorRecord);
  } catch (err) {
    return {
      runId,
      status: "failed",
      error: {
        ...errorRecord.error,
        journal_write_failed: true,
        journal_write_error: err.message,
      },
      attempts,
      latency_ms,
      decision_log,
    };
  }
  try {
    writeDispatchArtifact(projectRoot, runId, "rollback.json", {
      run_id: runId,
      status: "rolled_back",
      reason: `dispatch failed after ${attempts} attempt(s); rollback journal written`,
      original_error: errorRecord.error,
      attempts,
      written_at: new Date().toISOString(),
    });
  } catch (rollbackErr) {
    try {
      writeDispatchArtifact(projectRoot, runId, "rollback-failed.json", {
        run_id: runId,
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
        `[dispatch-execute] critical: failed to write any error/rollback for ${runId}: ${finalErr.message}`,
      );
    }
  }
  return {
    runId,
    status: "failed",
    error: errorRecord.error,
    attempts,
    latency_ms,
    decision_log,
  };
}

// ─── exported helpers ──────────────────────────────────────────────────────

// Build a dispatch spec from an M-002 plan (external_dispatch). This is the
// glue lib/agents/m003-cli.js uses to wire real dispatch from the M-002
// plan-only path.
function buildDispatchFromPlan(plan, opts = {}) {
  if (!plan || plan.kind !== "external_dispatch") {
    const err = new Error("buildDispatchFromPlan: plan must be external_dispatch");
    err.code = "ERR_DISPATCH_PLAN_INVALID";
    throw err;
  }
  const adapterType = plan.entry_point && plan.entry_point.adapter_type;
  // The real URL/headers come from the adapter (config_ref) or the caller.
  // For MS-001 we use a default URL template based on adapter_type; MS-002
  // will let each adapter override this.
  const url = opts.url || _defaultUrlForAdapter(adapterType, plan);
  return {
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cortex-Agent-Adapter": adapterType,
      "X-Cortex-Agent-Target": plan.target_agent_id,
    },
    body: JSON.stringify({
      plan: {
        target_agent_id: plan.target_agent_id,
        entry_point: plan.entry_point,
        payload: plan.payload,
        timeout: plan.timeout,
        required_capabilities: plan.required_capabilities,
      },
    }),
    agentType: adapterType,
    configRef: plan.entry_point.config_ref,
    credentialRef: plan.entry_point.credential_ref,
  };
}

function _defaultUrlForAdapter(adapterType, plan) {
  // Per D-FAE-002-4 default endpoint pattern: <scheme>://<adapter>/invoke
  // where <scheme> is http/https based on the env hint. In MS-001 we
  // hardcode http://localhost; MS-002 will replace with vendor URLs.
  return `http://localhost/${adapterType}/invoke`;
}

module.exports = {
  dispatchExecute,
  httpRequest,
  defaultDecision,
  buildDispatchFromPlan,
  // constants for tests / external callers
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
};

// ════════════════════════════════════════════════════════════════════════════
// M-003 MS-004 / F-009 三协议扩展 (HTTP + CLI + file)
// ════════════════════════════════════════════════════════════════════════════
//
// Above is M-003 MS-001's F-009-partial (HTTP only, 434 lines). It is preserved
// **zero-modified** (硬约束). Below is the MS-004 extension: 2 new transport
// implementations (CLI / file) + a unified `dispatchExecuteProtocol()` entry
// point that abstracts all 3 behind a single `protocol` field. The unified
// journal (request / result / error / rollback[-failed]) and 3-stage rollback
// fallback (per D-FAE-002-4) are shared with the existing HTTP path via the
// in-file `_writeErrorAndRollback` helper and `defaultDecision` family.
//
// Conventions (parity with M-003 MS-001):
//   - Zero npm deps. node:child_process / node:fs / node:path only.
//   - `request.json` is written BEFORE the first attempt (audit trail).
//   - 3 retry cap (D-FAE-002-4) with exponential backoff (200ms→5s cap).
//   - On terminal failure: error.json + rollback.json, or rollback-failed.json
//     if the rollback write itself fails (notify_parent: true).
//   - All errors carry a `code` so the default decision can classify them.

const childProcess = require("node:child_process");
const fsFileProto = require("node:fs");
const pathFileProto = require("node:path");

// ─── protocol catalog ─────────────────────────────────────────────────────

const PROTOCOLS = Object.freeze({
  HTTP: "http",
  CLI: "cli",
  FILE: "file",
});

// ─── JSON-RPC parser (parity with claude-code.js §3.2.2 / _parseJsonRpc) ──
//
// Supports 3 stdout shapes, in order:
//   1. Plain JSON (most CLI tools emit single-line JSON-RPC by default).
//   2. Content-Length framed with CRLF separator (`\r\n\r\n`).
//   3. Content-Length framed with LF separator (`\n\n`).
// Frame parser is robust to partial / malformed headers (no infinite loop).
function _parseJsonRpc(stdoutData) {
  const trimmed = (stdoutData || "").trim();
  if (!trimmed) throw new Error("empty stdout from subprocess");
  // 1. Plain JSON
  try { return JSON.parse(trimmed); } catch (_) { /* fall through */ }
  // 2. CRLF Content-Length
  const headerEnd = trimmed.indexOf("\r\n\r\n");
  if (headerEnd !== -1) {
    const match = trimmed.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (match) {
      const length = parseInt(match[1], 10);
      return JSON.parse(trimmed.slice(headerEnd + 4, headerEnd + 4 + length));
    }
  }
  // 3. LF Content-Length
  const lfHeaderEnd = trimmed.indexOf("\n\n");
  if (lfHeaderEnd !== -1) {
    const match = trimmed.slice(0, lfHeaderEnd).match(/Content-Length:\s*(\d+)/i);
    if (match) {
      const length = parseInt(match[1], 10);
      return JSON.parse(trimmed.slice(lfHeaderEnd + 2, lfHeaderEnd + 2 + length));
    }
  }
  throw new Error("not valid JSON and no Content-Length frame found");
}

// ─── CLI protocol transport ────────────────────────────────────────────────
//
// Spawn a subprocess, send a JSON-RPC 2.0 body on stdin, parse the response
// from stdout. Mirror of `lib/agents/adapters/claude-code.js#invoke` but
// generic (binary path is provided by the caller, not hard-coded).
//
// Risk #1 mitigation (per validation contract `VC-M-003-MS-004-dispatch`):
// `shell: true` is the default so macOS / Linux PATH differences are handled.
// Tests pass an absolute `bin` path with `shell: false` for determinism.

/**
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string[]} [opts.args]
 * @param {object} [opts.env]
 * @param {object} [opts.payload]   — JSON-RPC body written to stdin
 * @param {number} [opts.timeout]   — seconds (default 30)
 * @param {boolean} [opts.shell]    — use shell to resolve bin (default true)
 * @param {string} [opts.cwd]
 * @returns {Promise<{statusCode: 200, headers, body, latency_ms}>}
 * @throws on any failure, with `err.code` ∈ {ERR_CLI_*}.
 */
function cliRequest({
  bin,
  args = [],
  env = {},
  payload,
  timeout = DEFAULT_TIMEOUT,
  shell = true,
  cwd = process.cwd(),
} = {}) {
  if (typeof bin !== "string" || !bin) {
    return Promise.reject(_err("ERR_CLI_PROTOCOL", "cliRequest: bin (non-empty string) required"));
  }
  if (!Array.isArray(args)) {
    return Promise.reject(_err("ERR_CLI_PROTOCOL", "cliRequest: args must be an array"));
  }
  return new Promise((resolve, reject) => {
    const start = Date.now();

    let child;
    let spawnError = null;
    try {
      child = childProcess.spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        shell,
        env: { ...process.env, ...env },
      });
    } catch (err) {
      spawnError = err;
    }
    if (spawnError || !child) {
      const e = _err("ERR_CLI_SPAWN", `cliRequest: spawn failed: ${spawnError ? spawnError.message : "no child"}`);
      e.latency_ms = Date.now() - start;
      return reject(e);
    }

    let stdoutData = "";
    let stderrData = "";
    child.stdout.on("data", (c) => { stdoutData += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderrData += c.toString("utf8"); });

    // Write payload to stdin + close (so the subprocess sees EOF).
    try {
      const body = payload !== undefined && payload !== null
        ? (typeof payload === "string" ? payload : JSON.stringify(payload))
        : "";
      if (body) child.stdin.write(body);
      child.stdin.end();
    } catch (err) {
      const e = _err("ERR_CLI_STDIN", `cliRequest: failed to write payload to stdin: ${err.message}`);
      e.latency_ms = Date.now() - start;
      return reject(e);
    }

    // Race completion vs timeout. CRITICAL: clear the timeout handle in BOTH
    // paths — otherwise Node's test runner waits for the pending setTimeout
    // to fire (up to `timeout` seconds) before exiting.
    let timeoutHandle = null;
    const completionPromise = new Promise((res) => {
      child.on("exit", (code, signal) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        res({ code, signal, error: null, timeout: false });
      });
      child.on("error", (err) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        res({ code: -1, signal: null, error: err, timeout: false });
      });
    });
    const timeoutPromise = new Promise((res) => {
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        try { child.kill("SIGTERM"); } catch (_) { /* ignore */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) { /* ignore */ } }, 1500);
        res({ code: -1, signal: "SIGTERM", error: null, timeout: true });
      }, Math.max(1, timeout) * 1000);
    });

    Promise.race([completionPromise, timeoutPromise]).then((finalState) => {
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      const latency_ms = Date.now() - start;

      if (finalState.timeout) {
        const e = _err("ERR_CLI_TIMEOUT", `cliRequest: timed out after ${timeout}s`);
        e.latency_ms = latency_ms;
        return reject(e);
      }
      if (finalState.error) {
        // ENOENT (binary not on PATH) → ERR_CLI_SPAWN (matches claude-code.js
        // behavior). Other spawn errors → ERR_CLI_STDIN (caller/IO class).
        const isSpawnMissing = finalState.error.code === "ENOENT"
          || /ENOENT/.test(finalState.error.message || "");
        const e = _err(
          isSpawnMissing ? "ERR_CLI_SPAWN" : "ERR_CLI_STDIN",
          `cliRequest: subprocess error: ${finalState.error.message}`,
        );
        e.latency_ms = latency_ms;
        return reject(e);
      }
      if (finalState.code !== 0) {
        const e = _err("ERR_CLI_EXIT_NONZERO", `cliRequest: subprocess exited with code ${finalState.code}`);
        e.exitCode = finalState.code;
        e.signal = finalState.signal;
        e.stderr = stderrData.slice(0, 4096);
        e.latency_ms = latency_ms;
        return reject(e);
      }

      // Parse stdout as JSON-RPC
      let parsed;
      try {
        parsed = _parseJsonRpc(stdoutData);
      } catch (parseErr) {
        const e = _err("ERR_CLI_PARSE", `cliRequest: failed to parse JSON-RPC: ${parseErr.message}`);
        e.stdoutExcerpt = stdoutData.slice(0, 4096);
        e.latency_ms = latency_ms;
        return reject(e);
      }

      // Detect JSON-RPC error envelope
      if (parsed && typeof parsed === "object" && parsed.error) {
        const e = _err(
          "ERR_CLI_RPC_ERROR",
          `cliRequest: JSON-RPC error from binary: ${parsed.error.message || "no message"}`,
        );
        e.rpcError = parsed.error;
        e.latency_ms = latency_ms;
        return reject(e);
      }

      const result = parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
      resolve({
        statusCode: 200,
        headers: { "X-Cortex-Agent-Protocol": "cli" },
        body: typeof result === "string" ? result : JSON.stringify(result),
        latency_ms,
      });
    });
  });
}

// ─── file protocol transport ──────────────────────────────────────────────
//
// Read a JSON config from disk + write a JSON result to disk. Atomic via the
// `.tmp-<pid>-<ts>` + `rename` pattern (per M-001 registry.js §3.4).
//
// Risk #2 mitigation (per validation contract): the output write is atomic so
// a crash mid-write never leaves a corrupt file visible to readers.

/**
 * @param {object} opts
 * @param {string} opts.configPath
 * @param {string} opts.outputPath
 * @param {object} [opts.payload]
 * @param {number} [opts.timeout]   — seconds (rarely meaningful; default 30)
 * @returns {Promise<{statusCode: 200, headers, body, latency_ms}>}
 * @throws on any failure, with `err.code` ∈ {ERR_FILE_*}.
 */
async function fileRequest({ configPath, outputPath, payload, timeout = DEFAULT_TIMEOUT } = {}) {
  if (typeof configPath !== "string" || !configPath) {
    throw _err("ERR_FILE_PROTOCOL", "fileRequest: configPath required");
  }
  if (typeof outputPath !== "string" || !outputPath) {
    throw _err("ERR_FILE_PROTOCOL", "fileRequest: outputPath required");
  }
  const start = Date.now();

  // 1. Read + parse config
  if (!fsFileProto.existsSync(configPath)) {
    throw _err("ERR_FILE_CONFIG_NOT_FOUND", `fileRequest: config not found: ${configPath}`, { path: configPath });
  }
  let parsedConfig;
  try {
    parsedConfig = JSON.parse(fsFileProto.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw _err(
      "ERR_FILE_CONFIG_INVALID_JSON",
      `fileRequest: failed to read/parse config: ${err.message}`,
      { path: configPath, cause: err },
    );
  }

  // 2. Atomic write output
  try {
    const outputDir = pathFileProto.dirname(outputPath);
    fsFileProto.mkdirSync(outputDir, { recursive: true });
    const resultBody = {
      ok: true,
      protocol: PROTOCOLS.FILE,
      config_path: configPath,
      config: parsedConfig,
      payload: payload || null,
      written_at: new Date().toISOString(),
    };
    const tmp = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
    fsFileProto.writeFileSync(tmp, JSON.stringify(resultBody, null, 2));
    fsFileProto.renameSync(tmp, outputPath);
    return {
      statusCode: 200,
      headers: { "X-Cortex-Agent-Protocol": "file" },
      body: JSON.stringify(resultBody),
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    throw _err(
      "ERR_FILE_OUTPUT_WRITE_FAILED",
      `fileRequest: failed to write output: ${err.message}`,
      { path: outputPath, cause: err },
    );
  }
}

// ─── protocol-aware decision step ─────────────────────────────────────────
//
// Classifies an attempt failure for the unified retry+decision+rollback loop.
// Mirrors the existing `defaultDecision` (HTTP-only) but adds CLI / file error
// codes. The 3 protocol's error codes are mapped per the per-protocol risk
// analysis (see validation contract §risks + design notes).
function defaultDecisionProtocol(attempt, err) {
  if (attempt >= DEFAULT_MAX_RETRIES - 1) return "rollback";
  // HTTP-style status code
  if (err && err.statusCode && err.statusCode >= 500 && err.statusCode < 600) return "retry";
  if (err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    if (err.statusCode === 408 || err.statusCode === 429) return "retry";
    return "abort";
  }
  // Network / transport errors → retry
  if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" ||
              err.code === "ETIMEDOUT" || err.code === "ENOTFOUND" ||
              err.code === "EAI_AGAIN")) {
    return "retry";
  }
  // CLI / file error codes
  if (err && err.code) {
    const code = err.code;
    // Retryable (transient)
    if (code === "ERR_CLI_TIMEOUT") return "retry";
    if (code === "ERR_CLI_EXIT_NONZERO") return "retry"; // exit code may pass on next run
    if (code === "ERR_CLI_SPAWN") return "retry";       // PATH may get fixed
    if (code === "ERR_CLI_STDIN") return "retry";       // race vs subprocess start
    // Non-retryable
    if (code === "ERR_CLI_PARSE") return "rollback";    // broken output, retry won't help
    if (code === "ERR_CLI_RPC_ERROR") return "rollback"; // server-rejected
    if (code === "ERR_CLI_PROTOCOL") return "abort";    // config error
    if (code === "ERR_FILE_PROTOCOL") return "abort";   // config error
    if (code === "ERR_FILE_CONFIG_NOT_FOUND") return "rollback";
    if (code === "ERR_FILE_CONFIG_INVALID_JSON") return "rollback";
    if (code === "ERR_FILE_OUTPUT_WRITE_FAILED") return "rollback";
  }
  // Unknown error → rollback (safe default)
  return "rollback";
}

// ─── protocol → transport dispatcher ──────────────────────────────────────

function _transportFor(protocol, opts) {
  if (protocol === PROTOCOLS.HTTP) {
    // Custom transport injection (test-friendly; mirrors the existing
    // `dispatchExecute` `transport` option for parity).
    if (typeof opts.transport === "function") {
      return () => opts.transport({
        url: opts.url,
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        timeout: opts.timeout,
      });
    }
    return () => httpRequest({
      url: opts.url,
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      timeout: opts.timeout,
    });
  }
  if (protocol === PROTOCOLS.CLI) {
    return () => cliRequest({
      bin: opts.bin,
      args: opts.args,
      env: opts.env,
      payload: opts.payload,
      timeout: opts.timeout,
      shell: opts.shell,
      cwd: opts.cwd,
    });
  }
  if (protocol === PROTOCOLS.FILE) {
    return () => fileRequest({
      configPath: opts.configPath,
      outputPath: opts.outputPath,
      payload: opts.payload,
      timeout: opts.timeout,
    });
  }
  throw _err(
    "ERR_DISPATCH_PROTOCOL_INVALID",
    `dispatchExecuteProtocol: unknown protocol "${protocol}". Valid: ${Object.values(PROTOCOLS).join(", ")}`,
  );
}

// ─── unified multi-protocol entry point ────────────────────────────────────

/**
 * Multi-protocol real dispatch (HTTP / CLI / file). The 3 protocols share
 * the same retry + decision + journal + rollback semantics (per D-FAE-002-4
 * + D-003-3). The only thing that varies is the transport (how the dispatch
 * is actually executed) and the journal `request.json` shape (which records
 * the protocol + protocol-specific config for audit).
 *
 * @param {object} opts
 * @param {string} opts.protocol — required, one of PROTOCOLS values
 * @param {string} [opts.projectRoot]
 * @param {string} [opts.runId]
 * @param {string} [opts.agentType]
 * @param {string} [opts.configRef]
 * @param {string} [opts.credentialRef]
 * @param {number} [opts.timeout]   — per-attempt seconds (default 30)
 * @param {number} [opts.maxRetries] — default 3 (D-FAE-002-4)
 * @param {number} [opts.backoffMs]
 * @param {function} [opts.decision] — (attempt, err) => "retry"|"rollback"|"abort"
 *
 * Protocol-specific opts (must match `opts.protocol`):
 *   HTTP : url, [method=POST], [headers], [body]
 *   CLI  : bin, [args], [env], [payload], [shell=true], [cwd]
 *   file : configPath, outputPath, [payload]
 *
 * @returns {Promise<{runId, status, protocol, result?, error?, attempts, latency_ms, decision_log}>}
 */
async function dispatchExecuteProtocol(opts = {}) {
  const {
    protocol,
    projectRoot = process.cwd(),
    runId,
    agentType = null,
    configRef = null,
    credentialRef = null,
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    decision = defaultDecisionProtocol,
  } = opts;

  // 1. Validate protocol
  if (!protocol || !Object.values(PROTOCOLS).includes(protocol)) {
    const e = _err(
      "ERR_DISPATCH_PROTOCOL_INVALID",
      `dispatchExecuteProtocol: protocol required, one of ${Object.values(PROTOCOLS).join(", ")}`,
    );
    throw e;
  }

  const rid = runId || generateRunId(`R-dispatch-${protocol}`);
  const start = Date.now();
  const decision_log = [];

  // 2. Resolve transport (catches ERR_DISPATCH_PROTOCOL_INVALID)
  let transportFn;
  try {
    transportFn = _transportFor(protocol, opts);
  } catch (err) {
    return {
      runId: rid,
      status: "failed",
      protocol,
      result: null,
      error: { code: err.code || "ERR_DISPATCH_PROTOCOL_INVALID", message: err.message },
      attempts: 0,
      latency_ms: 0,
      decision_log: [],
    };
  }

  // 3. Write request.json BEFORE any attempt (audit trail)
  try {
    ensureDispatchDir(projectRoot, rid);
    writeDispatchArtifact(projectRoot, rid, "request.json",
      _buildRequestRecord(protocol, rid, opts, {
        agentType, configRef, credentialRef, timeout, maxRetries, backoffMs, start,
      }));
  } catch (err) {
    return {
      runId: rid,
      status: "failed",
      protocol,
      result: null,
      error: { code: "ERR_REQUEST_WRITE_FAILED", message: err.message },
      attempts: 0,
      latency_ms: 0,
      decision_log: [],
    };
  }

  // 4. Retry loop
  const finalMaxRetries = Math.max(1, maxRetries);
  let lastError = null;
  for (let attempt = 0; attempt < finalMaxRetries; attempt++) {
    let result = null;
    let err = null;
    try {
      result = await transportFn();
    } catch (e) {
      err = e;
    }

    if (!err) {
      // Success — write result + rollback
      const latency_ms = Date.now() - start;
      writeDispatchArtifact(projectRoot, rid, "result.json", {
        run_id: rid,
        protocol,
        status: "ok",
        result: {
          statusCode: result.statusCode,
          headers: result.headers,
          body: result.body,
        },
        attempt: attempt + 1,
        latency_ms,
        written_at: new Date().toISOString(),
      });
      writeDispatchArtifact(projectRoot, rid, "rollback.json", {
        run_id: rid,
        protocol,
        status: "completed",
        reason: "real dispatch completed successfully; no rollback needed",
        attempt: attempt + 1,
        written_at: new Date().toISOString(),
      });
      return {
        runId: rid,
        status: "ok",
        protocol,
        result: {
          statusCode: result.statusCode,
          headers: result.headers,
          body: result.body,
        },
        attempt: attempt + 1,
        latency_ms,
        decision_log,
      };
    }

    // Failure — consult the decision step
    lastError = err;
    let action;
    try {
      action = decision(attempt, err);
    } catch (decisionErr) {
      action = "rollback";
      decision_log.push({
        attempt: attempt + 1,
        decision: "rollback",
        note: `decision step threw: ${decisionErr.message}; defaulting to rollback`,
      });
    }
    if (!["retry", "rollback", "abort"].includes(action)) {
      action = "rollback";
    }
    decision_log.push({
      attempt: attempt + 1,
      decision: action,
      protocol,
      error_code: err.code || null,
      status_code: err.statusCode || null,
      message: err.message,
    });

    if (action === "retry" && attempt < finalMaxRetries - 1) {
      const sleepMs = Math.min(backoffMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }
    if (action === "abort") {
      break;
    }
    break;
  }

  // 5. Terminal failure — write error.json + rollback.json (or rollback-failed)
  const final = _writeErrorAndRollbackProtocol({
    projectRoot,
    runId: rid,
    protocol,
    error: lastError,
    attempts: decision_log.length,
    latency_ms: Date.now() - start,
    decision_log,
  });
  return { ...final, protocol };
}

// Protocol-aware error/rollback writer. Mirrors the existing
// `_writeErrorAndRollback` (M-003 MS-001, line 308) but:
//   - records the protocol field on every journal artifact
//   - preserves extra error fields (exitCode, signal, stderr, stdoutExcerpt,
//     rpcError, path) so callers can debug CLI / file failures
//   - identical 3-stage fallback (error.json → rollback.json → rollback-failed.json)
// We keep this separate from `_writeErrorAndRollback` (which is private to
// the M-003 MS-001 HTTP path) so the existing 434 lines stay zero-modified.
function _writeErrorAndRollbackProtocol({ projectRoot, runId, protocol, error, attempts, latency_ms, decision_log }) {
  // Capture all the structured error fields the transports set. The existing
  // _writeErrorAndRollback only keeps {code, message, statusCode, responseBody};
  // we add the protocol-aware fields so the journal is debuggable.
  const errorObj = {
    code: error.code || `ERR_DISPATCH_UNKNOWN`,
    message: error.message || "dispatch failed",
    status_code: error.statusCode || null,
    response_body: error.responseBody ? error.responseBody.slice(0, 4096) : null,
  };
  if (error.exitCode !== undefined) errorObj.exit_code = error.exitCode;
  if (error.signal !== undefined) errorObj.signal = error.signal;
  if (error.stderr !== undefined) errorObj.stderr = error.stderr;
  if (error.stdoutExcerpt !== undefined) errorObj.stdout_excerpt = error.stdoutExcerpt;
  if (error.rpcError !== undefined) errorObj.rpc_error = error.rpcError;
  if (error.path !== undefined) errorObj.path = error.path;
  if (error.latency_ms !== undefined) errorObj.transport_latency_ms = error.latency_ms;

  const errorRecord = {
    run_id: runId,
    protocol,
    status: "failed",
    error: errorObj,
    attempts,
    latency_ms,
    decision_log,
    written_at: new Date().toISOString(),
  };
  try {
    writeDispatchArtifact(projectRoot, runId, "error.json", errorRecord);
  } catch (err) {
    return {
      runId,
      status: "failed",
      error: {
        ...errorObj,
        journal_write_failed: true,
        journal_write_error: err.message,
      },
      attempts,
      latency_ms,
      decision_log,
    };
  }
  // Try to write rollback.json. If that fails, write rollback-failed.json
  // (per D-FAE-002-4 + the M-003 MS-001 risk #4 mitigation).
  try {
    writeDispatchArtifact(projectRoot, runId, "rollback.json", {
      run_id: runId,
      protocol,
      status: "rolled_back",
      reason: `real dispatch failed after ${attempts} attempt(s); rollback journal written`,
      original_error: errorObj,
      attempts,
      written_at: new Date().toISOString(),
    });
  } catch (rollbackErr) {
    try {
      writeDispatchArtifact(projectRoot, runId, "rollback-failed.json", {
        run_id: runId,
        protocol,
        status: "rollback_failed",
        primary_error: errorObj,
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
        `[dispatch-execute] critical: failed to write any error/rollback for ${runId}: ${finalErr.message}`,
      );
    }
  }
  return {
    runId,
    status: "failed",
    error: errorObj,
    attempts,
    latency_ms,
    decision_log,
  };
}

function _buildRequestRecord(protocol, rid, opts, ctx) {
  const base = {
    run_id: rid,
    protocol,
    timeout: ctx.timeout,
    max_retries: ctx.maxRetries,
    backoff_ms: ctx.backoffMs,
    agent_type: ctx.agentType,
    config_ref: ctx.configRef,
    credential_ref: ctx.credentialRef,
    created_at: new Date(ctx.start).toISOString(),
  };
  if (protocol === PROTOCOLS.HTTP) {
    return {
      ...base,
      url: opts.url,
      method: opts.method || "POST",
      headers: opts.headers || {},
      body: opts.body === undefined
        ? null
        : (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)),
    };
  }
  if (protocol === PROTOCOLS.CLI) {
    return {
      ...base,
      cli: {
        bin: opts.bin,
        args: opts.args || [],
        shell: opts.shell !== false,
      },
      env: opts.env || {},
    };
  }
  if (protocol === PROTOCOLS.FILE) {
    return {
      ...base,
      file: {
        configPath: opts.configPath,
        outputPath: opts.outputPath,
      },
    };
  }
  return base;
}

// ─── protocol-aware M-002 plan builder ────────────────────────────────────
//
// Thin convenience: take an M-002 external_dispatch plan, output a
// `dispatchExecuteProtocol()`-shaped opts for the chosen protocol.
// Protocol-specific config (bin, configPath, etc.) is supplied via the
// second-arg opts (the M-002 plan only carries entry_point + payload).
function buildDispatchFromPlanProtocol(plan, opts = {}) {
  if (!plan || plan.kind !== "external_dispatch") {
    throw _err("ERR_DISPATCH_PLAN_INVALID", "buildDispatchFromPlanProtocol: plan must be external_dispatch");
  }
  const protocol = opts.protocol || PROTOCOLS.HTTP;
  const adapterType = plan.entry_point && plan.entry_point.adapter_type;
  const common = {
    protocol,
    agentType: adapterType,
    configRef: plan.entry_point && plan.entry_point.config_ref,
    credentialRef: plan.entry_point && plan.entry_point.credential_ref,
    timeout: plan.timeout,
  };
  if (protocol === PROTOCOLS.HTTP) {
    return {
      ...common,
      url: opts.url || `http://localhost/${adapterType}/invoke`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cortex-Agent-Adapter": adapterType,
        "X-Cortex-Agent-Target": plan.target_agent_id,
      },
      body: JSON.stringify({
        plan: {
          target_agent_id: plan.target_agent_id,
          entry_point: plan.entry_point,
          payload: plan.payload,
          timeout: plan.timeout,
          required_capabilities: plan.required_capabilities,
        },
      }),
    };
  }
  if (protocol === PROTOCOLS.CLI) {
    return {
      ...common,
      bin: opts.bin || adapterType || "echo",
      args: opts.args || [],
      payload: plan.payload,
    };
  }
  if (protocol === PROTOCOLS.FILE) {
    return {
      ...common,
      configPath: opts.configPath,
      outputPath: opts.outputPath,
      payload: plan.payload,
    };
  }
  return common;
}

// ─── shared error factory ─────────────────────────────────────────────────

function _err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// ─── exports (additive — extends the existing module.exports) ─────────────

module.exports.dispatchExecuteProtocol = dispatchExecuteProtocol;
module.exports.cliRequest = cliRequest;
module.exports.fileRequest = fileRequest;
module.exports.defaultDecisionProtocol = defaultDecisionProtocol;
module.exports.buildDispatchFromPlanProtocol = buildDispatchFromPlanProtocol;
module.exports.PROTOCOLS = PROTOCOLS;
module.exports._parseJsonRpc = _parseJsonRpc; // exported for tests + adapter reuse
