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
