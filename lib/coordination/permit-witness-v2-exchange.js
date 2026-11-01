"use strict";

const frame = require("./permit-witness-v2-frame");
const wire = require("./permit-witness-v2-wire");
const historyWire = require("./permit-witness-v2-history-wire");
const { types: { isPromise } } = require("node:util");

// Await uses the intrinsic Promise path for an ordinary native Promise even
// when its own `then` getter throws. It does not make hostile constructors or
// species safe; untrusted callbacks still require a process boundary.
function observeNativeRejection(value) {
  if (!isPromise(value)) return;
  void (async () => { try { await value; } catch { /* Observation only. */ } })();
}

// In-process DEVELOPMENT candidate state machine, driven by ONE owner. These
// methods model delivered application events, not TLS reads or authentication.
// The owner must independently authenticate/authorize before using a host. No
// listener, transport hookup, automatic retry, checkpoint query or durable UUID
// replay history exists here. Explicit history mode uses an independently
// assigned host context, never a write context inferred from request bytes.
// Budget accounting covers these candidate instances and
// their frame buffers, not an unimplemented TLS listener or total JS heap.
// No callbacks run from append: takeRequest is the explicit dispatch boundary,
// complete records an executor result, takeResponse is the send boundary, and
// sent is ONLY local application-send completion (never peer acceptance).
// All budgets are absolute bigint nanoseconds in the same monotonic domain.
// A driving owner must call checkDeadline while idle. There is deliberately no
// Promise-race/timer claim that synchronous providers can be preempted.
const MAX_EVENTS = 128;
const CLOSE_KINDS = Object.freeze(["close_notify", "fin", "rst", "cancel", "timeout", "dispose"]);
// Conservative reservation for retained frames and transient detached validation
// copies. Caller-delivered buffers and bounded JSON objects are not frame storage.
const BUFFER_RESERVATION = 8 * frame.LIMITS.responseBytes + 4;
const budgets = new WeakMap();
class ExchangeBudget {
  constructor({ maxActive = 8, maxDispatches = 2, maxBufferedBytes = 8 * BUFFER_RESERVATION } = {}) {
    for (const limit of [maxActive, maxDispatches, maxBufferedBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 1) fail();
    }
    budgets.set(this, { maxActive, maxDispatches, maxBufferedBytes, active: 0, dispatches: 0, bufferedBytes: 0 });
  }
  get snapshot() { return Object.freeze({ ...budgets.get(this), maxQueued: 0 }); }
}
function fail() {
  const error = new Error("ERR_WITNESS_V2_STATE"); error.code = error.message; throw error;
}
function local(status, history = false) {
  // A local outcome is NOT a fabricated remote status byte or wire response.
  return Object.freeze({ source: "local", status, commit: history ? "not-applicable" : status === "unknown" ? "unknown" : "not-attempted",
    executionAuthorized: false, ...(history ? { mode: "development-only", resumeAllowed: false, originalRequestOutcome: "unknown" } : {}) });
}

// Trusted local composition only. Snapshot methods without invoking getters;
// neither the binding nor the context is ever accepted from a wire payload.
function historyBinding(input) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const keys = Reflect.ownKeys(input), names = ["host", "context", "isCurrent"];
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) fail();
  const data = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, "value")) fail();
    data[key] = d.value;
  }
  if (!data.host || typeof data.host !== "object" || !data.context || typeof data.context !== "object" || typeof data.isCurrent !== "function") fail();
  const methods = {};
  for (const key of ["queryHistory", "revokeContext"]) {
    const d = Object.getOwnPropertyDescriptor(data.host, key);
    if (!d || !Object.hasOwn(d, "value") || typeof d.value !== "function") fail();
    methods[key] = d.value.bind(data.host);
  }
  return Object.freeze({ ...methods, context: data.context, isCurrent: data.isCurrent });
}

class SingleExchange {
  #role; #now; #last; #deadline; #closingDeadline = null;
  #decoder; #request = null; #response = null;
  #state = "receiving"; #terminated = false; #frameComplete = false;
  #sendStarted = false; #dispatched = false; #completed = false;
  #outcome = null; #transactionOutcome = null;
  #events = []; #sequence = 0; #dropped = 0; #violation = false;
  #budget; #released = false; #pendingSend = false; #dispatchSlot = false;
  #history = false; #codec; #historyBinding = null; #identityLost = false; #authorizing = false;
  #pendingWork = 0; #historyRunning = false;

  constructor({ role, requestBytes, deadlineNs, budget, now = process.hrtime.bigint, protocol = "format1", history }) {
    if (!["client", "server"].includes(role) || typeof deadlineNs !== "bigint" ||
        deadlineNs < 0n || typeof now !== "function") fail();
    if (!budgets.has(budget) || !["format1", "history"].includes(protocol)) fail();
    this.#history = protocol === "history";
    this.#codec = this.#history ? historyWire : wire;
    if (this.#history && role === "server") this.#historyBinding = historyBinding(history);
    else if (history !== undefined) fail();
    this.#role = role; this.#now = now; this.#deadline = deadlineNs;
    this.#clock();
    const b = budgets.get(budget);
    if (b.active >= b.maxActive || BUFFER_RESERVATION > b.maxBufferedBytes - b.bufferedBytes) fail();
    this.#budget = b; b.active++; b.bufferedBytes += BUFFER_RESERVATION;
    try {
      if (role === "client") {
        const request = this.#codec.decodeRequest(requestBytes);
        this.#request = Buffer.from(requestBytes); this.#state = "ready-to-send";
        this.#decoder = new frame.FrameDecoder({ direction: "response", expectedOperation: request.operation,
          expectedRequestId: request.requestId });
      } else {
        if (requestBytes !== undefined) fail();
        this.#decoder = new frame.FrameDecoder({ direction: "request" });
      }
    } catch (error) { b.active--; b.bufferedBytes -= BUFFER_RESERVATION; throw error; }
  }
  #clock() {
    let at;
    try {
      at = this.#now();
      if (typeof at !== "bigint" || at < 0n || (this.#last !== undefined && at < this.#last)) fail();
    } catch (error) {
      this.#terminated = true;
      if (!["closing", "closed"].includes(this.#state)) this.#state = "terminated";
      this.#decoder?.dispose();
      if (!this.#outcome) this.#outcome = local(this.#sendStarted || this.#dispatched ? "unknown" : "not-attempted", this.#history);
      throw error;
    }
    this.#last = at; return at;
  }
  #record(type, detail = {}) {
    const event = Object.freeze({ sequence: ++this.#sequence, atNs: this.#clock().toString(), type, ...detail });
    if (this.#events.length < MAX_EVENTS) this.#events.push(event); else this.#dropped++;
  }
  get state() { return this.#state; }
  get outcome() { return this.#role === "server" ? this.#transactionOutcome || this.#outcome : this.#outcome; }
  get diagnostics() {
    return Object.freeze({ protocolViolation: this.#violation, events: Object.freeze([...this.#events]),
      droppedEvents: this.#dropped });
  }
  #release() {
    // Timed-out work remains charged until the owner reports actual exit.
    if (!this.#released && this.#state === "closed" && !this.#dispatchSlot && !this.#pendingSend && !this.#pendingWork && !this.#historyRunning) {
      this.#released = true; this.#budget.active--; this.#budget.bufferedBytes -= BUFFER_RESERVATION;
      this.#request = null; this.#response = null;
    }
  }
  #finishDispatch() {
    if (this.#dispatchSlot && !this.#pendingWork && !this.#historyRunning) {
      this.#budget.dispatches--; this.#dispatchSlot = false;
    }
    this.#release();
  }
  #trackAsync(value) {
    if (!value || !["object", "function"].includes(typeof value)) return false;
    let then;
    try { then = value.then; }
    catch (error) {
      // Unknown completion cannot be proved safe to release. Retain the charge.
      this.#pendingWork++;
      observeNativeRejection(value);
      throw error;
    }
    if (typeof then !== "function") return false;
    this.#pendingWork++;
    const settled = () => { this.#pendingWork--; this.#finishDispatch(); };
    // Observe the captured then exactly once; settlement never supplies a result
    // or runs diagnostics/clock code, only reports actual work exit for billing.
    const seen = new WeakSet();
    const observe = (item, method, depth) => {
      if (depth > 128 || seen.has(item)) {
        // Observe native rejection without treating an unbounded or cyclic
        // chain as completed. Never call an arbitrary thenable at this bound.
        // A hostile Promise species can still prevent attaching this handler;
        // callers cannot treat the development candidate as process isolation.
        if (isPromise(item)) {
          try { Promise.prototype.then.call(item, undefined, () => {}); } catch { /* Keep the charge. */ }
        }
        return;
      }
      seen.add(item);
      let signaled = false;
      const reject = () => {
        if (signaled) return;
        signaled = true;
        queueMicrotask(settled);
      };
      const resolve = (next) => {
        if (signaled) return;
        signaled = true;
        if (next && ["object", "function"].includes(typeof next)) {
          let nested;
          // A throwing getter can leave a rejecting Promise unobserved. This
          // candidate cannot guarantee process survival for hostile thenables.
          try { nested = next.then; } catch { observeNativeRejection(next); return; }
          if (typeof nested === "function") {
            queueMicrotask(() => observe(next, nested, depth + 1));
            return;
          }
        }
        queueMicrotask(settled);
      };
      try { Reflect.apply(method, item, [resolve, reject]); }
      catch { /* A failed subscription does not prove work has stopped. */ }
    };
    observe(value, then, 0);
    return true;
  }
  #stop(type, detail = {}) {
    this.#record(type, detail);
    if (!this.#terminated) {
      this.#terminated = true;
      if (!["closing", "closed"].includes(this.#state)) this.#state = "terminated";
      this.#decoder.dispose(); this.#response = null;
      if (!this.#outcome) this.#outcome = local(this.#sendStarted || this.#dispatched ? "unknown" : "not-attempted", this.#history);
    }
  }
  #trailing(count) {
    this.#violation = true;
    this.#stop("TRAILING_OBSERVED", { bytes: count, dispatched: this.#dispatched,
      resultFixed: this.#outcome !== null || this.#transactionOutcome !== null });
  }
  checkDeadline() {
    if (this.#state === "closed") return false;
    if (!this.#terminated && this.#clock() >= this.#deadline) this.#stop("DEADLINE");
    return !this.#terminated;
  }
  // No shutdown occurs when a client takes/sends its request. It stays open.
  takeRequest() {
    if (this.#history && this.#role === "server") fail(); // Only observeHistory may enter the read host.
    return this.#takeRequest();
  }
  #takeRequest() {
    if (!this.checkDeadline()) return null;
    if (this.#role === "client") {
      if (this.#state !== "ready-to-send") fail();
      this.#sendStarted = true; this.#pendingSend = true; this.#state = "awaiting-response";
      this.#record("REQUEST_SEND_STARTED"); return Buffer.from(this.#request);
    }
    if (this.#state !== "validated") fail();
    let mapped;
    try { mapped = this.#codec.toHostRequest(this.#request); } // checkpoint stays unsupported
    catch (error) { this.#stop("UNSUPPORTED_REQUEST", { code: error.code }); throw error; }
    if (!this.checkDeadline()) return null;
    if (!this.#dispatchSlot) {
      if (this.#budget.dispatches >= this.#budget.maxDispatches) { this.#stop("DISPATCH_LIMIT"); return null; }
      this.#budget.dispatches++; this.#dispatchSlot = true;
    }
    this.#dispatched = true; this.#state = "dispatched";
    this.#record("DISPATCHED"); return mapped;
  }
  #currentHistory() {
    if (this.#identityLost || this.#authorizing) return false;
    const binding = this.#historyBinding;
    let valid = false;
    this.#authorizing = true;
    try {
      const value = binding.isCurrent();
      valid = !this.#trackAsync(value) && value === true;
    } catch { /* Identity uncertainty is terminal, never permission to retry. */ }
    finally { this.#authorizing = false; }
    if (!valid) {
      this.#identityLost = true;
      try { this.#trackAsync(binding.revokeContext(binding.context)); } catch { /* Revocation cannot revive this exchange. */ }
      this.#stop("HISTORY_IDENTITY_LOST");
    }
    return valid;
  }
  observeHistory() {
    if (!this.#history || this.#role !== "server" || this.#authorizing) fail();
    if (!this.checkDeadline()) return this.outcome;
    if (this.#state !== "validated") fail();
    // Identity callbacks are work too: reserve before invoking any host code.
    if (this.#budget.dispatches >= this.#budget.maxDispatches) { this.#stop("DISPATCH_LIMIT"); return this.outcome; }
    this.#budget.dispatches++; this.#dispatchSlot = true;
    this.#historyRunning = true;
    try {
      if (!this.#currentHistory() || !this.checkDeadline()) { this.#historyFailed(); return this.outcome; }
      const mapped = this.#takeRequest();
      if (!mapped) { this.#historyFailed(); return this.outcome; }
      if (!this.#currentHistory() || !this.checkDeadline()) { this.#historyFailed(); return this.outcome; }
      const value = this.#historyBinding.queryHistory(this.#historyBinding.context, mapped.query);
      if (this.#trackAsync(value)) fail();
      if (!this.#currentHistory()) { this.#historyFailed(); return this.outcome; }
      this.#complete(value);
    } catch (error) {
      if (!this.#completed) this.#historyFailed();
      throw error;
    } finally { this.#historyRunning = false; this.#finishDispatch(); }
    return this.outcome;
  }
  #historyFailed() {
    this.#completed = true;
    try { this.#stop("HISTORY_OBSERVATION_FAILED"); }
    finally { this.#finishDispatch(); }
  }
  append(bytes) {
    if (!Buffer.isBuffer(bytes)) fail();
    if (!bytes.length) { this.checkDeadline(); return; }
    if (this.#state === "closed") { this.#record("LATE_INPUT", { bytes: bytes.length }); return; }
    if (!this.checkDeadline()) {
      this.#record("LATE_INPUT", { bytes: bytes.length });
      if (this.#frameComplete) this.#trailing(bytes.length);
      return;
    }
    if (this.#frameComplete) { this.#trailing(bytes.length); return; }
    if (this.#role === "client" && !this.#sendStarted) { this.#stop("UNEXPECTED_RESPONSE"); return; }
    let complete;
    try { complete = this.#decoder.append(bytes); }
    catch (error) { this.#violation = true; this.#stop("INVALID_FRAME", { code: error.code }); throw error; }
    if (!complete) return;
    this.#frameComplete = true;
    if (this.#role === "server") {
      // Inspect this entire delivered batch BEFORE request release/dispatch.
      if (complete.trailingBytes) { this.#trailing(complete.trailingBytes); return; }
      try { this.#codec.decodeRequest(complete.bytes); }
      catch (error) { this.#violation = true; this.#stop("INVALID_REQUEST", { code: error.code }); throw error; }
      if (!this.checkDeadline()) return;
      this.#request = complete.bytes; this.#state = "validated";
      this.#record("FRAME_VALIDATED");
    } else {
      try {
        const result = this.#codec.decodeResponse(complete.bytes, this.#request);
        if (!this.checkDeadline()) return;
        this.#outcome = Object.freeze({ source: "response", ...result });
        this.#state = "validated"; this.#record("RESPONSE_VALIDATED");
        this.#record(this.#history ? "HISTORY_RESULT_FIXED" : "BUSINESS_RESULT_FIXED");
      } catch (error) { this.#violation = true; this.#stop("INVALID_RESPONSE", { code: error.code }); throw error; }
      finally {
        // Validated committed remains fixed even with a same-batch second frame.
        if (complete.trailingBytes) this.#trailing(complete.trailingBytes);
      }
    }
  }
  complete(outcome) {
    if (this.#history) fail(); // Caller-supplied observations cannot bypass the bound context.
    return this.#complete(outcome);
  }
  #complete(outcome) {
    if (this.#role !== "server" || !this.#dispatched || this.#completed) fail();
    this.#completed = true;
    // The owner must supply a separately trusted/authorized executor's result;
    // schema checks here cannot establish its authority or persistence.
    // Recheck after possibly blocking executor work. Expiry prevents sends but
    // cannot erase a real server commit. Invalid/throwing results stay unknown.
    let response, validated;
    try {
      this.checkDeadline();
      response = this.#codec.encodeResponse(this.#request, outcome);
      validated = this.#codec.decodeResponse(response, this.#request);
    } catch (error) { this.#stop("INVALID_EXECUTOR_RESULT", { code: error.code }); throw error; }
    finally {
      this.#finishDispatch();
    }
    if (this.#history && (!this.#currentHistory() || !this.checkDeadline())) { this.#record("LATE_OBSERVATION_RESULT"); return; }
    this.#transactionOutcome = Object.freeze({ source: "executor", ...validated });
    this.#record(this.#history ? "HISTORY_OBSERVATION_RESULT" : validated.status === "committed" ? "COMMIT_CONFIRMED" : "TRANSACTION_RESULT",
      { status: validated.status });
    if (!this.checkDeadline()) { this.#record("LATE_TRANSACTION_RESULT"); return; }
    this.#response = response; this.#state = "response-ready";
  }
  executionFailed() {
    if (this.#history) fail();
    if (this.#role !== "server" || !this.#dispatched || this.#completed) fail();
    this.#completed = true;
    try { this.#stop("EXECUTOR_FAILED"); }
    finally { this.#budget.dispatches--; this.#dispatchSlot = false; this.#release(); }
    return this.outcome;
  }
  takeResponse() {
    if (this.#role !== "server") fail();
    if (!this.checkDeadline()) return null;
    if (this.#state !== "response-ready") fail();
    if (this.#history) {
      if (this.#budget.dispatches >= this.#budget.maxDispatches) { this.#stop("DISPATCH_LIMIT"); return null; }
      this.#budget.dispatches++; this.#dispatchSlot = true;
      this.#historyRunning = true;
      try { if (!this.#currentHistory() || !this.checkDeadline()) return null; }
      finally { this.#historyRunning = false; this.#finishDispatch(); }
    }
    this.#sendStarted = true; this.#pendingSend = true; this.#state = "sending-response";
    const bytes = this.#response; this.#response = null;
    this.#record("RESPONSE_SEND_STARTED"); return bytes;
  }
  sent() {
    if (!this.#pendingSend) fail();
    this.#pendingSend = false;
    try {
      if (this.#state === "closed") { this.#record("LATE_SEND_COMPLETION"); return; }
      if (!this.checkDeadline()) { this.#record("LATE_SEND_COMPLETION"); return; }
      if (this.#role === "client") {
        this.#record("REQUEST_SENT"); // No EOF/shutdown or business completion.
      } else {
        if (this.#state !== "sending-response") fail();
        this.#state = "response-sent"; this.#record("RESPONSE_SENT");
      }
    } finally { this.#release(); }
  }
  sendFailed(kind) {
    if (!this.#pendingSend || !CLOSE_KINDS.includes(kind)) fail();
    this.#pendingSend = false;
    try {
      if (this.#state === "closed") { this.#record("LATE_SEND_FAILURE", { kind }); return; }
      this.abort(kind);
    } finally { this.#release(); }
  }
  abort(kind = "cancel") {
    if (!CLOSE_KINDS.includes(kind)) fail();
    this.#stop("ABORT", { kind }); return this.outcome;
  }
  end(kind) {
    if (!CLOSE_KINDS.includes(kind)) fail();
    if (!this.#frameComplete) this.#stop("TRUNCATED", { kind });
    else this.#stop("PEER_CLOSE", { kind });
    return this.outcome;
  }
  beginClosing(deadlineNs) {
    if (typeof deadlineNs !== "bigint" || deadlineNs < this.#clock() || this.#closingDeadline !== null ||
        (!this.#terminated && !(this.#role === "client" ? this.#outcome : this.#state === "response-sent"))) fail();
    this.#closingDeadline = deadlineNs; this.#state = "closing";
    // This is ONLY a modeled boundary. Actual pending reader cancellation,
    // ownership handoff and native TLS shutdown compatibility remain BLOCKED.
    this.#record("CLOSING_STARTED");
  }
  checkClosingDeadline() {
    if (this.#closingDeadline === null) fail();
    if (this.#state === "closed") return false;
    if (this.#clock() >= this.#closingDeadline) { this.close("timeout"); return false; }
    return true;
  }
  close(kind) {
    if (!CLOSE_KINDS.includes(kind) || this.#closingDeadline === null || this.#state === "closed") fail();
    try { this.#record("CLOSED", { kind }); }
    finally {
      this.#decoder.dispose(); this.#state = "closed"; this.#terminated = true;
      this.#release();
    }
    return this.outcome;
  }
}

module.exports = { SingleExchange, ExchangeBudget, BUFFER_RESERVATION, MAX_EVENTS, CLOSE_KINDS };
