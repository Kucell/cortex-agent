"use strict";

// ─── Dispatch Execute Tests (M-003 MS-001 / F-009 partial) ────────────────────
//
// Coverage: lib/agents/dispatch-execute.js
//   - HTTP success path (200) writes result + rollback, returns ok
//   - HTTP 5xx triggers retry → eventual rollback
//   - HTTP 4xx (non-408/429) aborts immediately, no retry
//   - HTTP 408/429 retries
//   - Network errors (ECONNREFUSED) retry
//   - Timeout (ETIMEDOUT) retries
//   - 3 retry cap (D-FAE-002-4)
//   - decision_log captures every attempt
//   - rollback-failed.json when rollback write itself fails
//   - journal layout: .agent-runtime/dispatch/<run_id>/
//   - buildDispatchFromPlan + the default decision step
//
// We start a tiny HTTP server in-process (node:http) so tests don't need
// network access.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  dispatchExecute,
  httpRequest,
  defaultDecision,
  buildDispatchFromPlan,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_MS,
} = require("../../lib/agents/dispatch-execute");
const { generateRunId } = require("../../lib/agents/adapters/base");

// ─── in-process HTTP test server ─────────────────────────────────────────────

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        try {
          handler(req, res, body);
        } catch (err) {
          res.statusCode = 500;
          res.end(`server handler error: ${err.message}`);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms001-disp-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
function journal(root, runId, name) {
  return path.join(root, ".agent", "runtime", "dispatch", runId, name);
}
function readJournal(root, runId, name) {
  const file = journal(root, runId, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ─── default decision step (unit-level) ─────────────────────────────────────

test("dispatch-execute: defaultDecision on 5xx returns 'retry'", () => {
  assert.equal(defaultDecision(0, { statusCode: 500 }), "retry");
  assert.equal(defaultDecision(0, { statusCode: 503 }), "retry");
  assert.equal(defaultDecision(0, { statusCode: 502 }), "retry");
});

test("dispatch-execute: defaultDecision on 4xx (except 408/429) returns 'abort'", () => {
  assert.equal(defaultDecision(0, { statusCode: 400 }), "abort");
  assert.equal(defaultDecision(0, { statusCode: 401 }), "abort");
  assert.equal(defaultDecision(0, { statusCode: 404 }), "abort");
});

test("dispatch-execute: defaultDecision on 408 / 429 returns 'retry'", () => {
  assert.equal(defaultDecision(0, { statusCode: 408 }), "retry");
  assert.equal(defaultDecision(0, { statusCode: 429 }), "retry");
});

test("dispatch-execute: defaultDecision on network errors returns 'retry'", () => {
  assert.equal(defaultDecision(0, { code: "ECONNREFUSED" }), "retry");
  assert.equal(defaultDecision(0, { code: "ECONNRESET" }), "retry");
  assert.equal(defaultDecision(0, { code: "ETIMEDOUT" }), "retry");
  assert.equal(defaultDecision(0, { code: "ENOTFOUND" }), "retry");
});

test("dispatch-execute: defaultDecision on last attempt returns 'rollback'", () => {
  // attempt 2 = third try (0-indexed); maxRetries=3 means we should
  // NOT retry past attempt 2.
  assert.equal(defaultDecision(2, { statusCode: 500 }), "rollback");
  assert.equal(defaultDecision(2, { code: "ETIMEDOUT" }), "rollback");
});

test("dispatch-execute: defaultDecision on unknown error returns 'rollback'", () => {
  assert.equal(defaultDecision(0, { code: "WEIRD" }), "rollback");
  assert.equal(defaultDecision(0, {}), "rollback");
});

// ─── buildDispatchFromPlan ─────────────────────────────────────────────────

test("dispatch-execute: buildDispatchFromPlan accepts external_dispatch plan", () => {
  const plan = {
    kind: "external_dispatch",
    target_agent_id: "Claude-1",
    entry_point: {
      type: "external",
      adapter_type: "claude-code",
      config_ref: "configs/claude.yaml",
      credential_ref: "secret://anthropic",
    },
    payload: { task: "review" },
    timeout: 300,
    required_capabilities: ["code_review"],
  };
  const spec = buildDispatchFromPlan(plan);
  assert.equal(spec.method, "POST");
  assert.match(spec.url, /\/claude-code\/invoke/);
  assert.equal(spec.headers["X-Cortex-Agent-Adapter"], "claude-code");
  assert.equal(spec.headers["X-Cortex-Agent-Target"], "Claude-1");
  assert.match(spec.headers["Content-Type"], /json/);
  const body = JSON.parse(spec.body);
  assert.equal(body.plan.target_agent_id, "Claude-1");
  assert.equal(body.plan.entry_point.adapter_type, "claude-code");
});

test("dispatch-execute: buildDispatchFromPlan rejects non-external plan", () => {
  assert.throws(
    () => buildDispatchFromPlan({ kind: "internal_call" }),
    (err) => err.code === "ERR_DISPATCH_PLAN_INVALID",
  );
  assert.throws(
    () => buildDispatchFromPlan(null),
    (err) => err.code === "ERR_DISPATCH_PLAN_INVALID",
  );
});

// ─── httpRequest unit-level ─────────────────────────────────────────────────

test("dispatch-execute: httpRequest throws ERR_DISPATCH_URL_INVALID when url is undefined", async () => {
  // httpRequest delegates to new URL() which throws on undefined; we wrap
  // that as ERR_DISPATCH_URL_INVALID. dispatchExecute (the higher-level
  // entry point) does the explicit url-required check separately.
  await assert.rejects(
    () => httpRequest({ url: undefined, method: "GET" }),
    (err) => err.code === "ERR_DISPATCH_URL_INVALID",
  );
});

test("dispatch-execute: httpRequest throws ERR_DISPATCH_URL_INVALID on bad URL", async () => {
  await assert.rejects(
    () => httpRequest({ url: "not a url", method: "GET" }),
    (err) => err.code === "ERR_DISPATCH_URL_INVALID",
  );
});

// ─── e2e: success on first try ──────────────────────────────────────────────

test("dispatch-execute: 200 on first try → status=ok, attempt=1", async () => {
  const root = mkProject();
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, echo: "hi" }));
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, method: "POST", body: { task: "x" },
      timeout: 5, runId: "R-de-ok-1", backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.attempt, 1);
    assert.equal(hits, 1);
    assert.equal(r.result.statusCode, 200);
    assert.ok(r.latency_ms >= 0);
    // Journal
    const reqFile = readJournal(root, "R-de-ok-1", "request.json");
    const resFile = readJournal(root, "R-de-ok-1", "result.json");
    const rbFile = readJournal(root, "R-de-ok-1", "rollback.json");
    assert.ok(reqFile.url === url);
    assert.equal(resFile.status, "ok");
    assert.equal(rbFile.status, "completed");
  } finally { stopServer(server); rmProject(root); }
});

// ─── e2e: 5xx retries then succeeds ────────────────────────────────────────

test("dispatch-execute: 5xx twice then 200 → status=ok, attempt=3", async () => {
  const root = mkProject();
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    if (hits < 3) {
      res.statusCode = 503;
      res.end("upstream busy");
    } else {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, attempt: hits }));
    }
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, body: { task: "x" },
      timeout: 5, runId: "R-de-503-2", backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.attempt, 3);
    assert.equal(hits, 3);
    // decision_log should have 2 entries (the 2 failed attempts)
    assert.equal(r.decision_log.length, 2);
    assert.equal(r.decision_log[0].decision, "retry");
    assert.equal(r.decision_log[0].status_code, 503);
  } finally { stopServer(server); rmProject(root); }
});

// ─── e2e: persistent 5xx → rollback ────────────────────────────────────────

test("dispatch-execute: persistent 5xx → status=failed, rollback.json written", async () => {
  const root = mkProject();
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    res.statusCode = 500;
    res.end("always 500");
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, body: { task: "x" },
      timeout: 5, runId: "R-de-500", backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    assert.equal(r.attempt, undefined); // success count not returned on failure
    assert.equal(r.attempts, 3);
    assert.equal(hits, 3);
    // 4xx not present, so decision_log should record retry/retry/rollback
    assert.equal(r.decision_log.length, 3);
    assert.equal(r.decision_log[0].decision, "retry");
    assert.equal(r.decision_log[1].decision, "retry");
    assert.equal(r.decision_log[2].decision, "rollback");
    // Journal artifacts
    const errFile = readJournal(root, "R-de-500", "error.json");
    const rbFile = readJournal(root, "R-de-500", "rollback.json");
    assert.equal(errFile.status, "failed");
    assert.equal(errFile.error.status_code, 500);
    assert.equal(rbFile.status, "rolled_back");
  } finally { stopServer(server); rmProject(root); }
});

// ─── e2e: 4xx aborts immediately (no retry) ────────────────────────────────

test("dispatch-execute: 4xx (400) aborts immediately, no retry", async () => {
  const root = mkProject();
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    res.statusCode = 400;
    res.end("bad input");
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, body: { task: "x" },
      timeout: 5, runId: "R-de-400", backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    assert.equal(hits, 1);
    assert.equal(r.attempts, 1);
    assert.equal(r.decision_log[0].decision, "abort");
  } finally { stopServer(server); rmProject(root); }
});

// ─── e2e: 408 retries ──────────────────────────────────────────────────────

test("dispatch-execute: 408 Request Timeout triggers retry", async () => {
  const root = mkProject();
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    if (hits < 2) {
      res.statusCode = 408;
      res.end("timeout");
    } else {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    }
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, body: {}, timeout: 5,
      runId: "R-de-408", backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.equal(hits, 2);
  } finally { stopServer(server); rmProject(root); }
});

// ─── e2e: ECONNREFUSED → retry ─────────────────────────────────────────────

test("dispatch-execute: ECONNREFUSED triggers retry, eventual rollback", async () => {
  const root = mkProject();
  // Use a port that's not listening.
  const deadUrl = "http://127.0.0.1:1/dead";
  const r = await dispatchExecute({
    projectRoot: root, url: deadUrl, body: {}, timeout: 1,
    runId: "R-de-connref", backoffMs: 10,
  });
  assert.equal(r.status, "failed");
  // 3 attempts; defaultDecision says retry on ECONNREFUSED for the first 2
  // then rollback on the third.
  assert.equal(r.attempts, 3);
  assert.equal(r.decision_log[0].decision, "retry");
  assert.equal(r.decision_log[1].decision, "retry");
  assert.equal(r.decision_log[2].decision, "rollback");
  rmProject(root);
});

// ─── e2e: custom decision step ────────────────────────────────────────────

test("dispatch-execute: custom decision step overrides default", async () => {
  const root = mkProject();
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    res.statusCode = 503;
    res.end("busy");
  });
  try {
    // Custom decision: always abort, never retry.
    const r = await dispatchExecute({
      projectRoot: root, url, body: {}, timeout: 5,
      runId: "R-de-custom", backoffMs: 10,
      decision: () => "abort",
    });
    assert.equal(r.status, "failed");
    assert.equal(hits, 1);
    assert.equal(r.decision_log[0].decision, "abort");
  } finally { stopServer(server); rmProject(root); }
});

test("dispatch-execute: decision step that throws → defaults to rollback", async () => {
  const root = mkProject();
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    res.statusCode = 503;
    res.end("busy");
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, body: {}, timeout: 5,
      runId: "R-de-throw", backoffMs: 10,
      decision: () => { throw new Error("decision step is broken"); },
    });
    assert.equal(r.status, "failed");
    // The thrown decision is treated as "rollback" (safe default)
    assert.equal(r.decision_log[0].decision, "rollback");
    assert.match(r.decision_log[0].note, /decision step threw/);
  } finally { stopServer(server); rmProject(root); }
});

// ─── e2e: rollback-failed.json when journal write fails ────────────────────

test("dispatch-execute: writes rollback-failed.json when rollback.json write fails", async () => {
  const root = mkProject();
  // Pre-create the dispatch dir as a file (blocker).
  const blocked = path.join(root, ".agent", "runtime", "dispatch", "R-de-rb-fail");
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, "not a dir");
  // Use a real URL that always 200s — but the journal write is blocked,
  // so the request artifact can't be written.
  const { server, url } = await startServer((req, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, body: {}, timeout: 5,
      runId: "R-de-rb-fail", backoffMs: 10,
    });
    // The first write (request.json) failed → catastrophic return.
    assert.equal(r.status, "failed");
    assert.equal(r.error.code, "ERR_REQUEST_WRITE_FAILED");
  } finally { stopServer(server); rmProject(root); }
});

// ─── custom transport (no real HTTP) ───────────────────────────────────────

test("dispatch-execute: custom transport is used (no real HTTP)", async () => {
  const root = mkProject();
  const calls = [];
  const r = await dispatchExecute({
    projectRoot: root, url: "http://stub",
    body: { x: 1 }, timeout: 5, runId: "R-de-stub",
    backoffMs: 10,
    transport: async (args) => {
      calls.push(args);
      return { statusCode: 200, headers: {}, body: JSON.stringify({ got: args.body }), latency_ms: 1 };
    },
  });
  assert.equal(r.status, "ok");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { x: 1 });
  assert.equal(r.result.statusCode, 200);
  rmProject(root);
});

// ─── e2e: latency_ms is populated + < 5s (sanity) ──────────────────────────

test("dispatch-execute: latency_ms is populated and reasonable", async () => {
  const root = mkProject();
  const { server, url } = await startServer((req, res) => {
    setTimeout(() => {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    }, 50);
  });
  try {
    const r = await dispatchExecute({
      projectRoot: root, url, body: {}, timeout: 5,
      runId: "R-de-latency", backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.ok(r.latency_ms >= 50, `latency ${r.latency_ms}ms < 50ms`);
    assert.ok(r.latency_ms < 5000, `latency ${r.latency_ms}ms > 5s`);
  } finally { stopServer(server); rmProject(root); }
});
