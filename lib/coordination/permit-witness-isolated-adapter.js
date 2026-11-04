"use strict";

// Stage A development candidate. No production entry, host/store, key custody,
// write, retry or recovery capability. A managed identity authenticates the
// worker, NOT the truth of a hostile provider's history observation.
const fs = require("node:fs");
const path = require("node:path");
const { startManagedCallerSession } = require("../governed/managed-caller-supervisor");
const wire = require("./permit-witness-v2-history-wire");
const c = require("./permit-witness-isolated-contract");
const accounts = new WeakMap();
// No tree-exit proof API exists. Preserve charged accounts even when a caller
// drops its budget object; confirming direct exit never removes tree charges.
const chargedBudgets = new Set();
// Strong retention is intentional: dropping an adapter/budget must not discard
// unresolved startup or a live child handle. Only exact direct exit removes it.
const pendingLifecycles = new Set();
function positive(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError("isolated positive bounded integer required");
  return value;
}
class IsolationBudget {
  constructor({ maxWorkers = 1, maxDispatches = 1, maxReservedBytes = c.LIMITS.reservationBytes } = {}) {
    accounts.set(this, { maxWorkers: positive(maxWorkers, 64), maxDispatches: positive(maxDispatches, 64),
      maxReservedBytes: positive(maxReservedBytes, c.LIMITS.reservationBytes * 64), workers: 0, dispatches: 0, reservedBytes: 0 });
    Object.freeze(this);
  }
  snapshot() { return Object.freeze({ ...accounts.get(this), treeExitProven: false, chargesReleasable: false }); }
}
Object.freeze(IsolationBudget.prototype);
function reserve(budget) {
  const a = accounts.get(budget);
  if (!a || a.workers >= a.maxWorkers || a.dispatches >= a.maxDispatches ||
      a.reservedBytes + c.LIMITS.reservationBytes > a.maxReservedBytes) throw new Error("isolated budget exhausted");
  // Irreversible for this budget's lifetime, including failed startup. The
  // existing supervisor cannot prove tree exit and exposes no tree lease.
  chargedBudgets.add(budget);
  a.workers++; a.dispatches++; a.reservedBytes += c.LIMITS.reservationBytes;
}
function localPath(value, directory = false) {
  if (typeof value !== "string" || !path.isAbsolute(value) || fs.realpathSync(value) !== value ||
      !(directory ? fs.statSync(value).isDirectory() : fs.statSync(value).isFile())) throw new TypeError("isolated fixed absolute path required");
  return value;
}
class IsolatedHistoryAdapter {
  #provider; #directory; #budget; #timeout; #contexts = new WeakMap();
  constructor(options) {
    c.exact(options, ["providerPath", "runtimeDirectory", "budget", "timeoutMs"]);
    this.#provider = localPath(options.providerPath);
    this.#directory = localPath(options.runtimeDirectory, true);
    if (!accounts.has(options.budget)) throw new TypeError("isolated shared budget required");
    this.#budget = options.budget;
    this.#timeout = positive(options.timeoutMs, 5000);
    Object.freeze(this);
  }
  // Trusted LOCAL owner explicitly grants exactly one canonical history query.
  // A JSON token, normal write context, or another adapter cannot grant access.
  // This is admission authority only; no claim of independent store authority.
  authorizeHistory(bytes) {
    const request = c.request(bytes), context = Object.freeze(Object.create(null));
    this.#contexts.set(context, { request, used: false, revoked: false, terminal: null });
    return context;
  }
  revokeHistory(context) {
    const entry = this.#contexts.get(context);
    if (!entry) return false;
    entry.revoked = true;
    if (entry.fail) entry.fail("ERR_ISOLATED_REVOKED");
    return true;
  }
  // Local owner API, never sent to a worker or encoded on the history wire.
  // directExit never rejects or resolves from kill/close/startup rejection.
  historyLifecycle(context) {
    return this.#contexts.get(context)?.lifecycle ?? null;
  }
  async observeHistory(context, bytes) {
    const entry = this.#contexts.get(context), request = c.request(bytes);
    if (!entry || entry.revoked || entry.used || !entry.request.equals(request)) throw new Error("isolated history context unavailable");
    localPath(this.#provider); localPath(this.#directory, true);
    entry.used = true;
    reserve(this.#budget);
    const budget = this.#budget;
    const evidence = { managedSessionEstablished: false, identityAudited: false, sessionClosed: false,
      directExitObserved: false, directExitState: "pending", cleanupState: "pending",
      forcedTerminationAttempted: false, cleanupFailed: false, startupCleanupPending: true,
      treeExitProven: false, chargesRetained: true, lateResponseMessages: 0,
      receivedMessages: 0, stdioBytes: 0, parentOperationsExecuted: 0 };
    let runtime, timer, graceTimer, killTimer, onMessage, drain, onError, cleanupScheduled = false, cleanupStarted = false;
    let resolveTerminal, resolveExit;
    const terminal = new Promise(resolve => { resolveTerminal = resolve; });
    const directExit = new Promise(resolve => { resolveExit = resolve; });
    const startupController = new AbortController();
    const snapshot = () => Object.freeze({ ...evidence, budget: budget.snapshot() });
    const lifecycle = Object.freeze({ snapshot, directExit });
    entry.lifecycle = lifecycle;
    // This record keeps the actual runtime and observed startup/work promises
    // reachable even after callers discard the returned terminal snapshot.
    const retained = { lifecycle, budget, runtime: null, startup: null };
    pendingLifecycles.add(retained);
    function confirmExit(code, signal) {
      if (evidence.directExitObserved) return;
      evidence.directExitObserved = true;
      evidence.directExitState = "confirmed";
      evidence.cleanupState = "confirmed";
      evidence.directExit = Object.freeze({ code, signal });
      evidence.sessionClosed = runtime.session.closed;
      clearTimeout(graceTimer); clearTimeout(killTimer);
      const { child } = runtime;
      if (onMessage) (process.platform === "win32" ? runtime.transport : child).off("message", onMessage);
      // Keep the error guard through close: errors can arrive after exit.
      child.once("close", () => { if (onError) child.off("error", onError); });
      for (const stream of child.stdio) if (stream) stream.destroy();
      pendingLifecycles.delete(retained);
      retained.runtime = null; retained.startup = null;
      resolveExit(snapshot());
    }
    function cleanupError() { evidence.cleanupFailed = true; }
    function startCleanup() {
      cleanupScheduled = false;
      if (!runtime) {
        evidence.startupAbortRequested = true;
        try { startupController.abort(); } catch { cleanupError(); }
        return;
      }
      if (cleanupStarted || evidence.directExitObserved) return;
      cleanupStarted = true;
      const { child, session } = runtime;
      // Do not await close: even a stuck close Promise must not block the
      // retained-handle escalation, and no cleanup is awaited by the caller.
      try {
        void Promise.resolve(session.close("isolated-terminal")).then(() => {
          evidence.sessionClosed = session.closed;
        }, cleanupError);
        evidence.sessionClosed = session.closed;
      } catch { cleanupError(); }
      graceTimer = setTimeout(() => {
        if (evidence.directExitObserved) return;
        evidence.forcedTerminationAttempted = true;
        try {
          if (child.exitCode === null && child.signalCode === null) evidence.killAccepted = child.kill("SIGKILL");
        } catch { cleanupError(); }
        // A failed/timed out escalation remains pending. The exit listener and
        // strong retention survive this timer, so a later actual exit confirms.
        killTimer = setTimeout(() => {
          if (!evidence.directExitObserved) { evidence.cleanupTimedOut = true; cleanupError(); }
        }, 3000);
      }, 250);
    }
    function scheduleCleanup() {
      if (cleanupScheduled) return;
      cleanupScheduled = true;
      // Yield the business result first, including success. No 250ms/3s wait,
      // abort callback or session cleanup runs synchronously in its return path.
      setImmediate(() => { try { startCleanup(); } catch { cleanupError(); } });
    }
    function settle(outcome) {
      if (entry.terminal) return;
      entry.terminal = Object.freeze(outcome);
      clearTimeout(timer);
      resolveTerminal(entry.terminal);
      scheduleCleanup();
    }
    const fail = code => settle({ status: "unknown", code });
    entry.fail = fail;
    const deadline = performance.now() + this.#timeout;
    function deadlineExpired() {
      if (performance.now() < deadline) return false;
      fail("ERR_ISOLATED_TIMEOUT"); return true;
    }
    function attachRuntime(value) {
      runtime = value; retained.runtime = value;
      evidence.startupCleanupPending = false;
      const { child, session } = value;
      onError = () => fail("ERR_ISOLATED_CHILD_ERROR");
      child.on("error", onError);
      child.once("exit", confirmExit);
      session.onClose(() => { evidence.sessionClosed = true; fail("ERR_ISOLATED_SESSION_CLOSED"); });
      drain = chunk => {
        evidence.stdioBytes += chunk.length;
        if (evidence.stdioBytes > c.LIMITS.stdioBytes) fail("ERR_ISOLATED_STDIO_LIMIT");
      };
      child.stdout.on("data", drain); child.stderr.on("data", drain);
      onMessage = message => {
        evidence.receivedMessages++;
        if (entry.terminal && message?.type === "response") evidence.lateResponseMessages++;
        // These limits apply AFTER Node deserialization, never parser memory.
        const accepted = evidence.receivedMessages <= c.LIMITS.messages && c.admitMessage(message);
        if (!accepted) {
          if (message && typeof message === "object") message.type = "isolated-refused";
          fail("ERR_ISOLATED_MESSAGE_LIMIT");
        } else if (message?.type !== "response") {
          if (process.platform === "win32" && message && typeof message === "object") message.type = "isolated-refused";
          fail("ERR_ISOLATED_UNEXPECTED_MESSAGE");
        }
      };
      (process.platform === "win32" ? value.transport : child).prependListener("message", onMessage);
      evidence.managedSessionEstablished = session.established;
      if (child.exitCode !== null || child.signalCode !== null) confirmExit(child.exitCode, child.signalCode);
      if (entry.terminal) { scheduleCleanup(); return; }
      if (entry.revoked || session.closed) fail("ERR_ISOLATED_REVOKED");
      if (deadlineExpired() || entry.terminal) return;
      if (session.auditChannelHolders().ok !== true || session.auditProcessContinuity().ok !== true) fail("ERR_ISOLATED_IDENTITY");
      evidence.identityAudited = !entry.terminal;
    }
    // All detached promise chains are observed, including sync launch throws,
    // startup rejection and late runtime adoption. No unreviewed ticket API.
    timer = setTimeout(() => fail("ERR_ISOLATED_TIMEOUT"), this.#timeout);
    retained.startup = (async () => {
      const value = await startManagedCallerSession({
      modulePath: path.join(__dirname, "permit-witness-isolated-worker.js"), args: [this.#provider],
      allowedOperations: [c.OPERATIONS.denied], handshakeTimeoutMs: this.#timeout, requestTimeoutMs: this.#timeout,
      spawnOptions: { execPath: process.execPath, execArgv: ["--unhandled-rejections=strict"],
        cwd: this.#directory, env: c.environment(this.#directory), signal: startupController.signal, killSignal: "SIGKILL" },
      onAuthorizedRequest: () => { throw new Error("isolated worker has no parent authority"); },
      onIdentityUnavailable: () => fail("ERR_ISOLATED_IDENTITY"),
      });
      attachRuntime(value);
      if (deadlineExpired() || entry.terminal) return;
      const { session } = value;
      const ready = await session.request(c.OPERATIONS.ready, {});
      c.exact(ready, ["ready"]);
      if (deadlineExpired() || entry.terminal) return;
      if (ready.ready !== true) throw new Error("isolated worker not ready");
      const reply = await session.request(c.OPERATIONS.query, { request: request.toString("base64") });
      if (deadlineExpired() || entry.terminal || entry.revoked || !session.established) return;
      c.exact(reply, ["response"]);
      const observation = wire.decodeResponse(c.base64(reply.response), request);
      if (deadlineExpired() || entry.terminal) return;
      settle({ status: observation.status, observation });
    })().catch(error => {
      if (!runtime) {
        evidence.startupCleanupPending = false;
        evidence.startupCleanupUnverified = true;
        evidence.directExitState = "unverified";
        evidence.cleanupState = "unverified";
        evidence.supervisorCleanupError = Boolean(error?.cleanupError);
        // Keep this lifecycle pending forever: rejection is not exit evidence.
      }
      fail(runtime ? "ERR_ISOLATED_WORKER" : "ERR_ISOLATED_START_OR_AUDIT");
      if (entry.terminal) scheduleCleanup();
    });
    const outcome = await terminal;
    return Object.freeze({ ...outcome, mode: "development-only", provenance: "untrusted-provider",
      commit: "not-applicable", executionAuthorized: false, resumeAllowed: false, originalRequestOutcome: "unknown",
      evidence: snapshot(), budget: budget.snapshot() });
  }
}
Object.freeze(IsolatedHistoryAdapter.prototype);
module.exports = { IsolationBudget, IsolatedHistoryAdapter, LIMITS: c.LIMITS };
