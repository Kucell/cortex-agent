"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const wire = require("../../lib/coordination/permit-witness-v2-history-wire");
const oldWire = require("../../lib/coordination/permit-witness-v2-wire");
const { SingleExchange, ExchangeBudget } = require("../../lib/coordination/permit-witness-v2-exchange");
const { createPermitWitnessHost } = require("../../lib/coordination/permit-witness-host");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const { query, request, outcome, raw, canonical } = require("./fixtures/permit-witness-v2-history");
const legacy = require("./fixtures/permit-witness-v2");

function fixture(role = "server", options = {}) {
  const q = options.query || query(), req = request(q), budget = options.budget || new ExchangeBudget();
  const controls = { now: 1000n, alive: true, calls: 0, revokes: 0, hook: null, checks: 0, checkHook: null };
  const context = Object.freeze({});
  const host = { queryHistory(actual, input) {
    assert.equal(actual, context); assert.deepEqual(input, q); controls.calls++;
    return controls.hook ? controls.hook() : outcome(q);
  }, revokeContext(actual) { assert.equal(actual, context); controls.revokes++; } };
  const history = { host, context, isCurrent: () => {
    controls.checks++; return controls.checkHook ? controls.checkHook() : controls.alive;
  } };
  const instance = new SingleExchange({ role, protocol: "history", ...(role === "client" ? { requestBytes: req } : { history }),
    deadlineNs: 2000n, budget, now: () => controls.now, ...options });
  return { instance, controls, budget, q, req, history, host, context };
}
function received(options) { const f = fixture("server", options); f.instance.append(f.req); return f; }
function client(options) { const f = fixture("client", options); f.instance.takeRequest(); f.instance.sent(); return f; }
function types(f) { return f.instance.diagnostics.events.map(e => e.type); }
function close(f) {
  if (!["terminated", "response-sent", "validated"].includes(f.instance.state)) f.instance.abort("dispose");
  f.instance.beginClosing(f.controls.now + 100n); f.instance.close("dispose");
}
function observed(value) {
  assert.equal(value.status, "observed"); assert.equal(value.commit, "not-applicable");
  assert.equal(value.originalRequestOutcome, "unknown"); assert.equal(value.executionAuthorized, false); assert.equal(value.resumeAllowed, false);
}

test("explicit development history route binds a separate context and fixes observation without business commit events", () => {
  for (const operation of ["register", "issue", "consume"]) {
    const q = query(operation), server = received({ query: q }), caller = client({ query: q });
    assert.equal(server.controls.calls, 0); // append validates only, never invokes authorization or host.
    assert.equal(server.controls.checks, 0);
    assert.throws(() => server.instance.takeRequest());
    assert.throws(() => server.instance.complete(outcome(q)));
    assert.throws(() => server.instance.executionFailed());
    observed(server.instance.observeHistory()); assert.equal(server.controls.calls, 1);
    assert.throws(() => server.instance.observeHistory());
    const response = server.instance.takeResponse(); server.instance.sent(); caller.instance.append(response);
    observed(caller.instance.outcome);
    assert.equal(types(server).includes("COMMIT_CONFIRMED"), false);
    assert.equal(types(caller).includes("BUSINESS_RESULT_FIXED"), false);
    assert.equal(types(server).filter(t => t === "HISTORY_OBSERVATION_RESULT").length, 1);
    assert.equal(types(caller).filter(t => t === "HISTORY_RESULT_FIXED").length, 1);
    close(server); close(caller); assert.equal(server.budget.snapshot.dispatches, 0); assert.equal(server.budget.snapshot.active, 0);
  }
});

test("format1 and history have explicit disjoint constructors and parsing, no fallback or checkpoint routing", () => {
  assert.throws(() => new SingleExchange({ role: "client", requestBytes: request(), deadlineNs: 2000n, budget: new ExchangeBudget() }));
  assert.throws(() => fixture("client", { requestBytes: legacy.request() }));
  for (const protocol of ["format1", "history"]) {
    const f = protocol === "history" ? fixture() : { instance: new SingleExchange({ role: "server", deadlineNs: 2000n, now: () => 1000n, budget: new ExchangeBudget() }) };
    assert.throws(() => f.instance.append(protocol === "history" ? legacy.request() : request()));
    assert.equal(f.instance.outcome.status, "not-attempted");
  }
  const v1 = request(); v1[4] = 1;
  const f = fixture(); assert.throws(() => f.instance.append(v1)); assert.equal(f.controls.calls, 0);
  for (const body of [{ format_version: 2, action: "history.query", args: query() },
    { format_version: 1, targetId: "target-a", checkpoint: legacy.checkpoint() }]) {
    const f = fixture(); assert.throws(() => f.instance.append(raw(canonical(body), false, { operation: 1 })));
    assert.equal(f.controls.calls, 0);
  }
  assert.throws(() => fixture("server", { protocol: "auto" }));
  assert.throws(() => fixture("server", { protocol: "format1" }));
  assert.throws(() => new SingleExchange({ role: "server", protocol: "history", deadlineNs: 2000n, budget: new ExchangeBudget() }));
});

test("binding snapshots reject accessors/injection and malformed identity capabilities before admission", () => {
  for (const binding of [null, {}, { host: {}, context: {}, isCurrent: () => true },
    { host: { queryHistory() {}, revokeContext() {} }, context: null, isCurrent: () => true },
    { host: { queryHistory() {}, revokeContext() {} }, context: {}, isCurrent: true }]) {
    assert.throws(() => fixture("server", { history: binding }));
  }
  let accessed = 0;
  const base = received(), history = { ...base.history };
  Object.defineProperty(history, "host", { enumerable: true, get() { accessed++; return base.host; } });
  assert.throws(() => fixture("server", { history })); assert.equal(accessed, 0);
  base.host.queryHistory = () => { throw new Error("mutated method must not run"); };
  base.history.context = {};
  observed(base.instance.observeHistory()); // Captured callable and original opaque context.
  close(base);
});

test("same-batch and delayed request tails never enter host or dispatch a second query", () => {
  const req = request();
  for (const tail of [Buffer.from([0]), req.subarray(0, 3), req]) {
    const f = fixture(); f.instance.append(Buffer.concat([req, tail]));
    assert.equal(f.instance.observeHistory().status, "not-attempted"); assert.equal(f.controls.calls, 0);
    assert.equal(f.instance.diagnostics.protocolViolation, true); close(f);
  }
  for (const phase of ["before-observe", "after-observe", "after-send"]) {
    const f = received();
    if (phase !== "before-observe") observed(f.instance.observeHistory());
    if (phase === "after-send") { f.instance.takeResponse(); f.instance.sent(); }
    const fixed = f.instance.outcome; f.instance.append(Buffer.from([0]));
    assert.equal(f.controls.calls, phase === "before-observe" ? 0 : 1);
    f.instance.observeHistory(); assert.equal(f.instance.diagnostics.protocolViolation, true);
    if (fixed) assert.equal(f.instance.outcome, fixed);
    assert.equal(f.instance.takeResponse(), null); close(f);
  }
});

test("segmented history frames validate only when complete, with no quiet window, EOF or renewed deadline", () => {
  const f = fixture();
  for (let i = 0; i < f.req.length - 1; i++) {
    f.instance.append(f.req.subarray(i, i + 1));
    assert.equal(f.controls.calls, 0); assert.equal(f.controls.checks, 0);
  }
  f.instance.append(f.req.subarray(-1)); observed(f.instance.observeHistory());
  const c = client(), response = f.instance.takeResponse(); f.instance.sent();
  for (let i = 0; i < response.length - 1; i++) {
    c.instance.append(response.subarray(i, i + 1)); assert.equal(c.instance.outcome, null);
  }
  c.instance.append(response.subarray(-1)); observed(c.instance.outcome); close(f); close(c);
  const expired = fixture(); expired.instance.append(expired.req.subarray(0, 10));
  expired.controls.now = 2000n; expired.instance.append(expired.req.subarray(10));
  assert.equal(expired.instance.observeHistory().status, "not-attempted"); assert.equal(expired.controls.calls, 0); close(expired);
});

test("all history response categories stay fixed with same-batch tails, never synthesize committed", () => {
  for (const status of Object.keys(wire.HISTORY_STATUS)) for (const tail of [Buffer.from([0]), request()]) {
    const f = client(), response = wire.encodeResponse(f.req, outcome(f.q, status));
    f.instance.append(Buffer.concat([response, tail])); const fixed = f.instance.outcome;
    assert.equal(fixed.status, status); assert.equal(fixed.originalRequestOutcome, "unknown");
    f.instance.abort(); f.instance.append(response); assert.equal(f.instance.outcome, fixed);
    assert.equal(types(f).includes("BUSINESS_RESULT_FIXED"), false); assert.equal(f.instance.diagnostics.protocolViolation, true);
    close(f);
  }
});

test("cancel/timeout/close before observing or before validating a reply are terminal without retry", () => {
  for (const kind of ["cancel", "timeout", "fin", "rst", "close_notify"]) {
    const f = received(); f.instance.abort(kind);
    assert.equal(f.instance.observeHistory().status, "not-attempted"); assert.equal(f.controls.calls, 0); close(f);
    const c = client(); const response = wire.encodeResponse(c.req, outcome(c.q));
    c.instance.abort(kind); const fixed = c.instance.outcome;
    c.instance.append(response); assert.equal(c.instance.outcome, fixed); assert.equal(fixed.status, "unknown");
    assert.equal(fixed.commit, "not-applicable"); assert.equal(fixed.originalRequestOutcome, "unknown"); close(c);
  }
  const f = received(); f.controls.now = 2000n;
  assert.equal(f.instance.observeHistory().status, "not-attempted"); assert.equal(f.controls.calls, 0); close(f);
});

test("slow or reentrantly cancelled observation cannot replace local unknown; budget remains charged to actual exit", () => {
  for (const event of ["deadline", "abort", "tail", "close"]) {
    const f = received();
    f.controls.hook = () => {
      assert.equal(f.budget.snapshot.dispatches, 1);
      assert.throws(() => f.instance.observeHistory());
      if (event === "deadline") f.controls.now = 2000n;
      else if (event === "tail") f.instance.append(Buffer.from([0]));
      else f.instance.abort("cancel");
      if (event === "close") { close(f); assert.equal(f.budget.snapshot.active, 1); }
      return outcome(f.q);
    };
    assert.equal(f.instance.observeHistory().status, "unknown");
    assert.equal(f.controls.calls, 1); assert.equal(f.budget.snapshot.dispatches, 0);
    assert.equal(types(f).includes("HISTORY_OBSERVATION_RESULT"), false);
    assert.equal(f.instance.takeResponse(), null);
    if (event !== "close") close(f);
    assert.equal(f.budget.snapshot.active, 0);
  }
});

test("history shares admission/dispatch budgets and releases capacity only at actual query/send exit", () => {
  const budget = new ExchangeBudget({ maxActive: 2, maxDispatches: 1 }), first = received({ budget }), second = received({ budget });
  assert.throws(() => fixture("server", { budget }));
  first.controls.hook = () => {
    assert.equal(second.instance.observeHistory().status, "not-attempted");
    assert.equal(second.controls.calls, 0); assert.equal(budget.snapshot.dispatches, 1);
    return outcome(first.q);
  };
  observed(first.instance.observeHistory()); first.instance.takeResponse();
  first.instance.abort(); close(first);
  assert.equal(budget.snapshot.active, 2); // pending send remains charged
  first.instance.sendFailed("rst"); assert.equal(budget.snapshot.active, 1);
  close(second); assert.equal(budget.snapshot.active, 0); assert.equal(budget.snapshot.dispatches, 0);
  const clientBudget = new ExchangeBudget({ maxActive: 1 });
  assert.throws(() => fixture("client", { budget: clientBudget, requestBytes: legacy.request() }));
  assert.equal(clientBudget.snapshot.active, 0);
  const serverBudget = new ExchangeBudget({ maxActive: 1 });
  assert.throws(() => fixture("server", { budget: serverBudget, history: {} }));
  assert.equal(serverBudget.snapshot.active, 0);
});

for (const step of [1, 2, 3, 4, 5]) test(`identity loss at history boundary ${step} is terminal and late clean identity cannot revive it`, () => {
  const f = received(); f.controls.checkHook = () => f.controls.checks !== step;
  const result = f.instance.observeHistory();
  if (step < 5) assert.equal(result.status, step === 1 ? "not-attempted" : "unknown");
  else { observed(result); assert.equal(f.instance.takeResponse(), null); }
  assert.equal(f.controls.revokes, 1); assert.equal(f.controls.calls, step <= 2 ? 0 : 1);
  f.controls.checkHook = () => true;
  f.instance.observeHistory(); assert.equal(f.instance.takeResponse(), null);
  assert.equal(f.controls.calls, step <= 2 ? 0 : 1); close(f);
});

test("identity promises, thrown predicates and reentrant cancellation cannot authorize an observation", () => {
  for (const value of [Promise.resolve(true), Promise.reject(new Error("test")), "true", true]) {
    if (value instanceof Promise) value.catch(() => {});
    const f = received();
    f.controls.checkHook = () => { if (value === true) f.instance.abort(); return value; };
    assert.equal(f.instance.observeHistory().status, "not-attempted"); assert.equal(f.controls.calls, 0); close(f);
  }
  const f = received(); f.controls.checkHook = () => { throw new Error("identity failure"); };
  assert.equal(f.instance.observeHistory().status, "not-attempted"); assert.equal(f.controls.revokes, 1); close(f);
});

test("invalid/async host returns never produce observations, retry or leak execution slots", async () => {
  for (const make of [() => legacy.outcome(), () => ({ ...outcome(), resumeAllowed: true }), () => Promise.resolve(outcome()),
    () => Promise.reject(new Error("test rejection")), () => null]) {
    const result = make();
    const f = received(); f.controls.hook = () => result;
    assert.throws(() => f.instance.observeHistory()); assert.equal(f.instance.outcome.status, "unknown");
    assert.equal(f.instance.takeResponse(), null);
    f.instance.observeHistory(); assert.equal(f.controls.calls, 1); close(f);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.budget.snapshot.dispatches, 0); assert.equal(f.budget.snapshot.active, 0);
  }
});

test("an unsettled pre-send identity check retains dispatch and active credits without releasing a response", async () => {
  const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 }), f = received({ budget });
  observed(f.instance.observeHistory());
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  f.controls.checkHook = () => pending;
  try {
    assert.equal(f.instance.takeResponse(), null);
    const fixed = f.instance.outcome;
    close(f);
    assert.equal(budget.snapshot.active, 1); assert.equal(budget.snapshot.dispatches, 1);
    assert.throws(() => fixture("server", { budget }));
    resolve(true); await new Promise(done => setImmediate(done));
    assert.equal(f.instance.outcome, fixed); assert.equal(f.instance.state, "closed");
    assert.equal(f.instance.takeResponse(), null); assert.equal(budget.snapshot.dispatches, 0); assert.equal(budget.snapshot.active, 0);
  } finally { resolve(true); await new Promise(done => setImmediate(done)); }
});

test("uncertain then-accessor completion fails closed and retains its work charge", () => {
  const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 }), f = received({ budget });
  const value = {};
  Object.defineProperty(value, "then", { get() { throw new Error("unknown work completion"); } });
  f.controls.hook = () => value;
  assert.throws(() => f.instance.observeHistory()); close(f);
  assert.equal(f.instance.state, "closed"); assert.equal(f.instance.outcome.status, "unknown");
  assert.equal(budget.snapshot.dispatches, 1); assert.equal(budget.snapshot.active, 1);
  assert.throws(() => fixture("server", { budget }));
});

test("async identity and revocation both remain charged until their last actual settlement, ignoring repeated then callbacks", async () => {
  const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 });
  let identityDone, revokeDone;
  const identity = { then(resolve) { identityDone = resolve; } };
  const revoked = new Promise(resolve => { revokeDone = resolve; });
  const second = fixture("server", { budget, history: {
    context: {}, isCurrent: () => identity,
    host: { queryHistory() { assert.fail("identity did not authorize"); }, revokeContext: () => revoked },
  } });
  try {
    second.instance.append(second.req); second.instance.observeHistory(); close(second);
    assert.equal(second.budget.snapshot.dispatches, 1); assert.equal(second.budget.snapshot.active, 1);
    identityDone(true); identityDone(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.budget.snapshot.dispatches, 1); assert.equal(second.budget.snapshot.active, 1);
    revokeDone(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.budget.snapshot.dispatches, 0); assert.equal(second.budget.snapshot.active, 0);
    assert.equal(second.instance.state, "closed"); assert.equal(second.instance.outcome.status, "not-attempted");
  } finally {
    if (identityDone) identityDone(true); revokeDone(); await new Promise(resolve => setImmediate(resolve));
  }
});

test("native promises with a throwing then getter are observed but remain charged", () => {
  for (const nested of [false, true]) {
    const script = `
      const { SingleExchange, ExchangeBudget } = require(${JSON.stringify(require.resolve("../../lib/coordination/permit-witness-v2-exchange"))});
      const fixture = require(${JSON.stringify(require.resolve("./fixtures/permit-witness-v2-history"))});
      let reject; const promise = new Promise((_, fail) => { reject = fail; });
      Object.defineProperty(promise, "then", { get() { throw Error("synthetic getter"); } });
      const item = ${nested} ? { then(resolve) { resolve(promise); } } : promise;
      const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 });
      const exchange = new SingleExchange({ role: "server", protocol: "history", budget, deadlineNs: 2000n,
        now: () => 1000n, history: { context: {}, isCurrent: () => true, host: { queryHistory: () => item, revokeContext() {} } } });
      exchange.append(fixture.request()); try { exchange.observeHistory(); } catch {}
      exchange.beginClosing(1100n); exchange.close("dispose");
      setImmediate(() => { if (budget.snapshot.active !== 1 || budget.snapshot.dispatches !== 1) process.exitCode = 2;
        reject(Error("synthetic rejection"));
        setImmediate(() => { if (budget.snapshot.active !== 1 || budget.snapshot.dispatches !== 1 ||
          exchange.state !== "closed") process.exitCode = 3; }); });`;
    const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", script], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
  }
});

test("an over-depth native promise rejection is observed without releasing credits", () => {
  const script = `
    const { SingleExchange, ExchangeBudget } = require(${JSON.stringify(require.resolve("../../lib/coordination/permit-witness-v2-exchange"))});
    const fixture = require(${JSON.stringify(require.resolve("./fixtures/permit-witness-v2-history"))});
    let reject, item = new Promise((_, fail) => { reject = fail; });
    for (let i = 0; i < 129; i++) { const next = item; item = { then(resolve) { resolve(next); } }; }
    const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 });
    const exchange = new SingleExchange({ role: "server", protocol: "history", budget, deadlineNs: 2000n,
      now: () => 1000n, history: { context: {}, isCurrent: () => true, host: { queryHistory: () => item, revokeContext() {} } } });
    exchange.append(fixture.request()); try { exchange.observeHistory(); } catch {}
    exchange.beginClosing(1100n); exchange.close("dispose");
    setImmediate(() => { if (budget.snapshot.active !== 1 || budget.snapshot.dispatches !== 1) process.exitCode = 2;
      reject(new Error("synthetic rejection")); });`;
  const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});

test("nested thenable work stays charged until the inner promise settles", async () => {
  const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = received({ budget });
  f.controls.hook = () => ({ then(resolve) { resolve(pending); } });
  assert.throws(() => f.instance.observeHistory());
  close(f);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(budget.snapshot.active, 1);
  assert.equal(budget.snapshot.dispatches, 1);
  assert.throws(() => fixture("server", { budget }));
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(budget.snapshot.active, 0);
  assert.equal(budget.snapshot.dispatches, 0);
  assert.equal(f.instance.state, "closed");
});

test("a throwing then subscription cannot release credits before explicit settlement", async () => {
  const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 });
  let finish;
  const f = received({ budget });
  f.controls.hook = () => ({ then(done) { finish = done; throw new Error("subscription failed"); } });
  assert.throws(() => f.instance.observeHistory());
  close(f);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(budget.snapshot.active, 1);
  assert.equal(budget.snapshot.dispatches, 1);
  assert.throws(() => fixture("server", { budget }));
  finish(); finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(budget.snapshot.active, 0);
  assert.equal(budget.snapshot.dispatches, 0);
  assert.equal(f.instance.state, "closed");
});

for (const source of ["host", "identity-before", "identity-after"]) for (const rejected of [false, true]) {
  test(`unsettled ${source} work retains all credits until ${rejected ? "rejection" : "resolution"} without adopting late results`, async () => {
    const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 });
    let settle;
    const pending = new Promise((resolve, reject) => { settle = rejected ? reject : resolve; });
    const f = received({ budget });
    if (source === "host") f.controls.hook = () => pending;
    else f.controls.checkHook = () => f.controls.checks === (source === "identity-before" ? 1 : 3) ? pending : true;
    try {
      if (source === "host") assert.throws(() => f.instance.observeHistory());
      else f.instance.observeHistory();
      const fixed = f.instance.outcome;
      assert.equal(fixed.status, source === "identity-before" ? "not-attempted" : "unknown");
      close(f);
      assert.equal(f.instance.state, "closed");
      assert.equal(budget.snapshot.active, 1); assert.equal(budget.snapshot.dispatches, 1);
      assert.ok(budget.snapshot.bufferedBytes > 0);
      for (let i = 0; i < 4; i++) assert.throws(() => fixture("server", { budget }));
      assert.equal(f.controls.calls, source === "identity-before" ? 0 : 1);
      settle(rejected ? new Error("controlled rejection") : source === "host" ? outcome(f.q) : true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.instance.outcome, fixed); assert.equal(f.instance.state, "closed");
      assert.equal(f.instance.takeResponse(), null); assert.equal(types(f).includes("HISTORY_OBSERVATION_RESULT"), false);
      assert.equal(budget.snapshot.dispatches, 0); assert.equal(budget.snapshot.active, 0); assert.equal(budget.snapshot.bufferedBytes, 0);
      const next = fixture("server", { budget }); next.instance.abort(); close(next);
    } finally {
      settle(rejected ? new Error("cleanup rejection") : true);
      await new Promise(resolve => setImmediate(resolve));
    }
  });
}

test("unsettled identity thenables keep a dispatch slot even when other active exchanges are allowed", async () => {
  const budget = new ExchangeBudget({ maxActive: 2, maxDispatches: 1 });
  let resolve;
  const pending = { then(done) { resolve = done; } };
  const first = received({ budget }); first.controls.checkHook = () => pending;
  try {
    first.instance.observeHistory(); close(first);
    const second = received({ budget });
    assert.equal(second.instance.observeHistory().status, "not-attempted");
    assert.equal(second.controls.calls, 0); close(second);
    assert.equal(budget.snapshot.dispatches, 1); assert.equal(budget.snapshot.active, 1);
    await new Promise(done => setImmediate(done));
    resolve(true); await new Promise(done => setImmediate(done));
    assert.equal(first.instance.state, "closed"); assert.equal(budget.snapshot.active, 0);
  } finally { if (resolve) resolve(true); await new Promise(done => setImmediate(done)); }
});

test("response codec mixup, queryDigest mismatch, noncanonical bytes and reflection cannot become observed", () => {
  const q = query();
  const changed = structuredClone(q); changed.request.requestId = "other";
  const valid = wire.encodeResponse(request(q), outcome(q));
  for (const bytes of [oldWire.encodeResponse(legacy.request(), legacy.outcome()),
    wire.encodeResponse(request(changed), outcome(changed)), request(q),
    raw(canonical(wire.decodeResponse(valid, request(q))).toString() + "\n", true)]) {
    const f = client(); assert.throws(() => f.instance.append(bytes));
    assert.equal(f.instance.outcome.status, "unknown"); assert.equal(types(f).includes("HISTORY_RESULT_FIXED"), false); close(f);
  }
});

test("history observation cannot alter the original format1 unknown or clear its terminal state", () => {
  const old = legacy.sentClient(); old.instance.abort("rst");
  const fixed = old.instance.outcome;
  const f = received(); observed(f.instance.observeHistory());
  assert.equal(old.instance.outcome, fixed); assert.equal(fixed.status, "unknown");
  old.instance.append(oldWire.encodeResponse(legacy.request(), legacy.outcome()));
  assert.equal(old.instance.outcome, fixed);
  for (const name of ["retry", "resume", "recover"]) assert.equal(typeof f.instance[name], "undefined");
  close(f);
});

const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || process.platform === "win32" };
function realHost(t) {
  const base = testRuntime("test-tmp"); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "history-exchange-"));
  const db = path.join(root, "db"), anchorDir = path.join(root, "anchor"); fs.mkdirSync(db); fs.mkdirSync(anchorDir);
  const file = path.join(db, "authority.sqlite"), q = query();
  const options = { backend: "development-witness", mode: "development-only", access: "initialize", file,
    authorityId: q.authorityId, clock: () => 1000, storeOptions: { decisionId: q.decisionId, anchorDir, anchorMode: "permissive" },
    providers: { observeTarget: () => ({ targetHasProcess: false, targetHasPriorRun: false }),
      signPermit: () => { throw new Error("no signer"); }, pullRevocation: () => { throw new Error("no revocation"); } } };
  const host = createPermitWitnessHost(options), identity = Object.freeze({});
  const writerInput = { identity, principal: "original-owner", actions: ["register", "issue"],
    resources: { targetId: "target-a", pin: q.request.pin, lease: { owner: "original-owner", sessionId: "session", hostId: "host",
      workerId: "worker", runId: "run", generation: "generation", desktopKey: "desktop", ownedAppId: "app" },
      permit: { operation: "invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64) }, maxLeaseTtlMs: 5000, maxPermitTtlMs: 2000 }, isCurrent: () => true };
  const writer = host.createContext(writerInput);
  assert.equal(host.dispatch(writer, "register", q.request).status, "committed");
  function state() { const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file, { readOnly: true });
    try { return JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id=1").get().body); } finally { db.close(); } }
  q.issuerStoreId = state().store_id;
  const reader = host.createHistoryContext({ identity: Object.freeze({}), principal: "independent-reviewer", query: q, isCurrent: () => true });
  t.after(() => { host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { host, writer, writerInput, q, reader, state, file, anchorDir };
}

test("real independent history context observes a blocked host without invoking any writer, signer, recovery or restoring grants", supported, t => {
  const f = realHost(t), issue = query("issue").request;
  issue.checkpoint = f.state().witness_authority.targets["target-a"].current.checkpoint;
  issue.checkpoint = { ...issue.checkpoint, full_state_digest: "f".repeat(64) };
  assert.equal(f.host.dispatch(f.writer, "issue", issue).status, "unknown");
  const before = f.state(), binding = { host: f.host, context: f.reader, isCurrent: () => true };
  const methods = ["snapshot", "registerWitnessTarget", "issueWitnessPermit", "consumeWithCheckpoint"];
  const originals = methods.map(k => Store.prototype[k]); let writes = 0;
  for (const key of methods) Store.prototype[key] = () => { writes++; throw new Error("forbidden write"); };
  try {
    const s = received({ query: f.q, history: binding }); observed(s.instance.observeHistory());
    const c = client({ query: f.q }); c.instance.append(s.instance.takeResponse()); s.instance.sent(); observed(c.instance.outcome);
    close(s); close(c);
  } finally { methods.forEach((key, i) => { Store.prototype[key] = originals[i]; }); }
  assert.equal(writes, 0); assert.deepEqual(f.state(), before);
  assert.equal(f.host.dispatch(f.writer, "issue", issue).status, "rejected");
  assert.throws(() => f.host.createContext(f.writerInput));
});

test("write contexts and forged history contexts cannot grant observation through the real host", supported, t => {
  const f = realHost(t);
  for (const context of [f.writer, {}, JSON.parse(JSON.stringify(f.reader))]) {
    const s = received({ query: f.q, history: { host: f.host, context, isCurrent: () => true } });
    assert.equal(s.instance.observeHistory().status, "rejected"); close(s);
  }
  const before = f.state();
  const s = received({ query: f.q, history: { host: f.host, context: f.reader, isCurrent: () => true } });
  observed(s.instance.observeHistory()); assert.deepEqual(f.state(), before); close(s);
});

test("real host query integrity failure stays unknown/unavailable after repair, never resumes writing", supported, t => {
  const f = realHost(t), audit = path.join(f.anchorDir, "protected-anchor-audit.log"), mode = fs.statSync(audit).mode & 0o777;
  fs.chmodSync(audit, 0o644);
  const before = f.state(), binding = { host: f.host, context: f.reader, isCurrent: () => true };
  const first = received({ query: f.q, history: binding });
  try { assert.equal(first.instance.observeHistory().status, "unknown"); } finally { fs.chmodSync(audit, mode); }
  close(first);
  const second = received({ query: f.q, history: binding });
  assert.equal(second.instance.observeHistory().status, "unavailable"); close(second);
  assert.equal(f.host.dispatch(f.writer, "register", f.q.request).status, "rejected");
  assert.deepEqual(f.state(), before);
});
