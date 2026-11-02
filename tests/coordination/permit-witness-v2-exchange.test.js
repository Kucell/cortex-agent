"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const wire = require("../../lib/coordination/permit-witness-v2-wire");
const { SingleExchange, ExchangeBudget, BUFFER_RESERVATION, MAX_EVENTS, CLOSE_KINDS } =
  require("../../lib/coordination/permit-witness-v2-exchange");
const { request, outcome, exchange, sentClient, types, clock, checkpoint, ID } = require("./fixtures/permit-witness-v2");
function close(instance, time, kind = "dispose") {
  instance.beginClosing(time.now() + 100n); instance.close(kind);
}
function received() { const f = exchange("server"); f.instance.append(request()); return f; }

test("one open request/response completes without EOF, shutdown or a quiet window", () => {
  const client = exchange("client"), server = exchange("server");
  const req = client.instance.takeRequest(); client.instance.sent();
  assert.equal(client.instance.state, "awaiting-response"); assert.equal(client.instance.outcome, null);
  assert.throws(() => client.instance.beginClosing(2100n));
  server.instance.append(req); assert.equal(server.instance.state, "validated");
  assert.equal(server.instance.takeRequest().action, "register");
  assert.throws(() => server.instance.takeRequest());
  server.instance.complete(outcome());
  assert.throws(() => server.instance.beginClosing(2100n));
  const response = server.instance.takeResponse();
  assert.throws(() => server.instance.beginClosing(2100n));
  assert.throws(() => server.instance.takeResponse());
  server.instance.sent(); client.instance.append(response);
  assert.equal(client.instance.outcome.status, "committed");
  assert.equal(client.instance.outcome.source, "response");
  assert.equal(client.instance.outcome.executionAuthorized, false);
  assert.equal(client.instance.diagnostics.protocolViolation, false);
  assert.equal(types(server.instance).filter(t => t === "DISPATCHED").length, 1);
  assert.equal(types(client.instance).filter(t => t === "BUSINESS_RESULT_FIXED").length, 1);
  for (const f of [client, server]) {
    close(f.instance, f.time, "close_notify"); assert.equal(f.budget.snapshot.active, 0);
    const events = f.instance.diagnostics.events;
    assert.ok(events.every((e, i) => e.sequence === i + 1 && (i === 0 || BigInt(e.atNs) >= BigInt(events[i - 1].atNs))));
  }
});

test("same-batch request tails (byte, prefix, full frame) prevent all dispatch", () => {
  const req = request();
  for (const tail of [Buffer.from([0]), req.subarray(0, 3), req]) {
    const { instance, time } = exchange("server");
    instance.append(Buffer.concat([req, tail]));
    assert.equal(instance.takeRequest(), null);
    assert.equal(instance.outcome.status, "not-attempted");
    assert.equal(instance.outcome.source, "local");
    assert.equal(instance.diagnostics.protocolViolation, true);
    assert.ok(!types(instance).includes("DISPATCHED"));
    assert.equal(instance.diagnostics.events[0].bytes, tail.length);
    close(instance, time);
  }
});

test("same-batch response tails preserve all four validated results but mark protocol failure", () => {
  const req = request();
  for (const status of Object.keys(wire.STATUS)) {
    const response = wire.encodeResponse(req, outcome(status));
    for (const tail of [Buffer.from([0]), response.subarray(0, 3), response]) {
      const { instance, time } = sentClient();
      instance.append(Buffer.concat([response, tail]));
      const fixed = instance.outcome;
      assert.equal(fixed.status, status); assert.equal(fixed.source, "response");
      assert.equal(instance.diagnostics.protocolViolation, true);
      assert.ok(types(instance).indexOf("BUSINESS_RESULT_FIXED") < types(instance).indexOf("TRAILING_OBSERVED"));
      instance.abort("cancel"); instance.end("rst");
      instance.append(response); assert.equal(instance.outcome, fixed);
      assert.equal(types(instance).filter(t => t === "BUSINESS_RESULT_FIXED").length, 1);
      close(instance, time, "timeout"); assert.equal(instance.outcome, fixed);
    }
  }
});

test("delayed tails at explicit owner boundaries never dispatch twice or rewrite server commit facts", () => {
  for (const phase of ["before-dispatch", "after-dispatch", "after-commit", "after-send"]) {
    const { instance, time } = received();
    if (phase !== "before-dispatch") instance.takeRequest();
    if (["after-commit", "after-send"].includes(phase)) instance.complete(outcome());
    if (phase === "after-send") { instance.takeResponse(); instance.sent(); }
    instance.append(Buffer.from([0]));
    assert.equal(instance.diagnostics.protocolViolation, true);
    assert.equal(instance.takeRequest(), null);
    if (phase === "before-dispatch") assert.equal(instance.outcome.status, "not-attempted");
    else {
      if (phase === "after-dispatch") {
        assert.equal(instance.outcome.status, "unknown");
        // Executor returned confirmed after violation. Do not pretend cancelled.
        instance.complete(outcome());
      }
      assert.equal(instance.outcome.status, "committed");
      assert.equal(instance.takeResponse(), null);
      assert.equal(types(instance).filter(t => t === "DISPATCHED").length, 1);
    }
    close(instance, time);
  }
});

test("response validation followed by delayed tail/cancel/EOF/closing timeout fixes business exactly once", () => {
  const { instance, time } = sentClient();
  const response = wire.encodeResponse(request(), outcome()); instance.append(response);
  const fixed = instance.outcome; instance.append(Buffer.from([0])); instance.abort("cancel");
  instance.beginClosing(time.now() + 10n); time.advance(10n);
  assert.equal(instance.checkClosingDeadline(), false);
  assert.equal(instance.state, "closed"); assert.equal(instance.outcome, fixed);
  instance.append(response); // Not claimed to have observed bytes in a closed transport.
  assert.equal(types(instance).filter(t => t === "BUSINESS_RESULT_FIXED").length, 1);
  assert.ok(types(instance).includes("LATE_INPUT"));
});

test("cancel/deadline/error before validation latch local unknown; late valid response cannot recover it", () => {
  for (const fault of ["cancel", "deadline", "invalid", "fin", "rst"]) {
    const { instance, time } = sentClient();
    if (fault === "deadline") { time.set(2000n); instance.checkDeadline(); }
    else if (fault === "invalid") {
      const bad = wire.encodeResponse(request(), outcome()); bad[4] = 1;
      assert.throws(() => instance.append(bad));
    } else if (["fin", "rst"].includes(fault)) instance.end(fault);
    else instance.abort(fault);
    const fixed = instance.outcome;
    assert.equal(fixed.status, "unknown"); assert.equal(fixed.source, "local");
    instance.append(wire.encodeResponse(request(), outcome()));
    assert.equal(instance.outcome, fixed); assert.ok(!types(instance).includes("BUSINESS_RESULT_FIXED"));
    close(instance, time);
  }
  const unsent = exchange("client"); unsent.instance.abort();
  assert.equal(unsent.instance.outcome.status, "not-attempted");
});

test("fragment activity does not renew the absolute monotonic exchange deadline", () => {
  const { instance, time } = sentClient(), bytes = wire.encodeResponse(request(), outcome());
  for (let i = 0; i < 3; i++) { instance.append(bytes.subarray(i, i + 1)); time.advance(400n); }
  instance.append(bytes.subarray(3));
  assert.equal(instance.outcome.status, "unknown"); assert.ok(types(instance).includes("DEADLINE"));
  assert.ok(!types(instance).includes("RESPONSE_VALIDATED"));
  close(instance, time);
});

test("deadline rechecks before dispatch, response send and fixing a validated result", () => {
  const before = received(); before.time.set(2000n);
  assert.equal(before.instance.takeRequest(), null); assert.equal(before.instance.outcome.status, "not-attempted");
  const after = received(); after.instance.takeRequest(); after.instance.complete(outcome()); after.time.set(2000n);
  assert.equal(after.instance.takeResponse(), null); assert.equal(after.instance.outcome.status, "committed");
  // Clock seam is fixture-only: expire on the recheck AFTER full wire validation.
  let reads = 0, expireAt = Infinity;
  const now = () => ++reads >= expireAt ? 2000n : 1000n;
  const candidate = sentClient({ now }); expireAt = reads + 2;
  candidate.instance.append(Buffer.concat([wire.encodeResponse(request(), outcome()), Buffer.from([0])]));
  assert.equal(candidate.instance.outcome.status, "unknown");
  assert.ok(!types(candidate.instance).includes("BUSINESS_RESULT_FIXED"));
  assert.equal(candidate.instance.diagnostics.protocolViolation, true);
});

test("synchronous executor overrun is detected after return; it cannot prove non-commit or a hard deadline", () => {
  const budget = new ExchangeBudget(), start = process.hrtime.bigint();
  const instance = new SingleExchange({ role: "server", budget, deadlineNs: start + 100000000n });
  instance.append(request()); instance.takeRequest();
  // A deterministic blocking stand-in, not a real store/provider/cancellation proof.
  while (process.hrtime.bigint() < start + 110000000n) { /* block the owning thread */ }
  instance.complete(outcome());
  assert.equal(instance.outcome.status, "committed");
  assert.equal(instance.takeResponse(), null); assert.ok(types(instance).includes("DEADLINE"));
  assert.ok(types(instance).includes("LATE_TRANSACTION_RESULT"));
  instance.beginClosing(process.hrtime.bigint() + 100000000n); instance.close("dispose");
  assert.equal(budget.snapshot.active, 0);
});

test("server confirmed with response lost/truncated leaves client unknown; local send is not delivery", () => {
  for (const cut of [0, 1, 4, 22, -1]) {
    const server = received(), client = sentClient();
    server.instance.takeRequest(); server.instance.complete(outcome());
    const bytes = server.instance.takeResponse(); server.instance.sent();
    client.instance.append(bytes.subarray(0, cut < 0 ? bytes.length - 1 : cut)); client.instance.end("rst");
    assert.equal(server.instance.outcome.status, "committed"); assert.equal(client.instance.outcome.status, "unknown");
    close(server.instance, server.time); close(client.instance, client.time);
  }
});

test("invalid response/schema never yields committed, including a valid header plus request echo", () => {
  const req = request();
  for (const response of [req, Buffer.concat([wire.encodeResponse(req, outcome()).subarray(0, 23), Buffer.from("{}")])]) {
    const { instance } = sentClient();
    if (response === req) assert.throws(() => instance.append(response));
    else { instance.append(response); instance.end("fin"); }
    assert.equal(instance.outcome.status, "unknown");
  }
  const { instance } = received(); instance.takeRequest();
  assert.throws(() => instance.complete({ ...outcome(), executionAuthorized: true }));
  assert.equal(instance.outcome.status, "unknown"); assert.equal(instance.takeResponse(), null);
});

test("all early close types are distinct diagnostics with zero server dispatch", () => {
  for (const kind of CLOSE_KINDS) {
    const { instance } = exchange("server"); instance.append(request().subarray(0, 30)); instance.end(kind);
    assert.equal(instance.outcome.status, "not-attempted");
    assert.equal(instance.diagnostics.events.at(-1).kind, kind);
    assert.equal(instance.takeRequest(), null);
  }
});

test("no checkpoint recovery, automatic replay, production host context or duplicate sends", () => {
  const checkpointRequest = wire.encodeRequest({ operation: 1, requestId: ID,
    body: { format_version: 1, targetId: "target-a", checkpoint: checkpoint() } });
  const server = exchange("server"); server.instance.append(checkpointRequest);
  assert.throws(() => server.instance.takeRequest(), { code: "ERR_WITNESS_WIRE_CHECKPOINT_QUERY_UNSUPPORTED" });
  assert.equal(server.budget.snapshot.dispatches, 0);
  const client = exchange("client"); client.instance.takeRequest();
  assert.throws(() => client.instance.takeRequest());
  assert.equal(Object.hasOwn(client.instance, "retry"), false);
  client.instance.sendFailed("rst"); assert.equal(client.instance.outcome.status, "unknown");
});

test("active, dispatch, queue and frame budgets reject excess work and retain timed-out executor charges", () => {
  const budget = new ExchangeBudget({ maxActive: 2, maxDispatches: 1, maxBufferedBytes: 2 * BUFFER_RESERVATION });
  const time = clock(), make = () => new SingleExchange({ role: "server", budget, now: time.now, deadlineNs: 2000n });
  const first = make(), second = make();
  assert.equal(budget.snapshot.maxQueued, 0); assert.equal(budget.snapshot.bufferedBytes, 2 * BUFFER_RESERVATION);
  assert.throws(make);
  first.append(request()); first.takeRequest(); second.append(request());
  assert.equal(second.takeRequest(), null); assert.equal(second.outcome.status, "not-attempted");
  close(second, time); assert.equal(budget.snapshot.active, 1);
  time.set(2000n); first.checkDeadline(); close(first, time);
  assert.equal(budget.snapshot.active, 1); assert.equal(budget.snapshot.dispatches, 1);
  const third = make(); third.append(request());
  assert.equal(third.takeRequest(), null); // expired, cannot bypass original deadline
  first.complete(outcome()); // Actual exit releases charges, even after close.
  assert.equal(first.outcome.status, "committed"); assert.equal(budget.snapshot.dispatches, 0);
  assert.equal(budget.snapshot.active, 1); close(third, time);
  assert.equal(budget.snapshot.bufferedBytes, 0);
  const tiny = new ExchangeBudget({ maxBufferedBytes: BUFFER_RESERVATION - 1 });
  assert.throws(() => exchange("server", { budget: tiny })); assert.equal(tiny.snapshot.active, 0);
});

test("unfinished sends stay charged after timeout/close and release only at actual send exit", () => {
  for (const success of [false, true]) {
    const { instance, time, budget } = exchange("client"); instance.takeRequest();
    time.set(2000n); instance.checkDeadline(); close(instance, time);
    assert.equal(budget.snapshot.active, 1);
    if (success) instance.sent(); else instance.sendFailed("rst");
    assert.equal(budget.snapshot.active, 0); assert.equal(instance.outcome.status, "unknown");
  }
});

for (const history of [false, true]) for (const success of [false, true]) for (const fault of ["rollback", "invalid", "throws"]) {
  test(`closed ${history ? "history" : "format1"} late ${success ? "sent" : "sendFailed"} with ${fault} clock preserves terminal state and releases once`, () => {
    const historyWire = require("./fixtures/permit-witness-v2-history");
    let now = 1000n, broken = false;
    const budget = new ExchangeBudget({ maxActive: 1 });
    const instance = new SingleExchange({ role: "client", protocol: history ? "history" : "format1",
      requestBytes: history ? historyWire.request() : request(), deadlineNs: 2000n, budget,
      now: () => { if (broken && fault === "throws") throw new Error("controlled clock failure"); return broken ? fault === "invalid" ? NaN : 999n : now; } });
    instance.takeRequest(); instance.abort(); instance.beginClosing(1100n); instance.close("dispose");
    const fixed = instance.outcome; assert.equal(budget.snapshot.active, 1);
    broken = true;
    assert.throws(() => success ? instance.sent() : instance.sendFailed("rst"));
    assert.equal(instance.state, "closed"); assert.equal(instance.outcome, fixed);
    assert.equal(budget.snapshot.active, 0); assert.equal(budget.snapshot.bufferedBytes, 0);
    assert.throws(() => success ? instance.sent() : instance.sendFailed("rst"));
    assert.equal(budget.snapshot.active, 0);
    broken = false; now = 1001n;
    instance.append(Buffer.from([0])); instance.abort(); instance.end("fin");
    assert.equal(instance.state, "closed"); assert.equal(instance.outcome, fixed);
  });
}

test("clock failures during closing and close diagnostics cannot regress or strand terminal cleanup", () => {
  for (const throws of [false, true]) {
    let broken = false;
    const budget = new ExchangeBudget();
    const instance = new SingleExchange({ role: "client", requestBytes: request(), deadlineNs: 2000n, budget,
      now: () => { if (broken && throws) throw new Error("clock failure"); return broken ? 999n : 1000n; } });
    instance.takeRequest(); instance.abort(); instance.beginClosing(1100n); broken = true;
    assert.throws(() => instance.sent()); assert.equal(instance.state, "closing");
    assert.throws(() => instance.close("dispose")); assert.equal(instance.state, "closed");
    assert.equal(budget.snapshot.active, 0); assert.equal(budget.snapshot.bufferedBytes, 0);
  }
});

test("executor failure has local unknown and releases quota only when actual exit is reported", () => {
  const budget = new ExchangeBudget({ maxActive: 1, maxDispatches: 1 });
  for (let i = 0; i < 5; i++) {
    const { instance, time } = exchange("server", { budget });
    instance.append(request()); instance.takeRequest(); time.set(2000n); instance.checkDeadline();
    close(instance, time); assert.equal(budget.snapshot.active, 1);
    assert.equal(instance.executionFailed().status, "unknown");
    assert.equal(instance.outcome.source, "local"); assert.equal(budget.snapshot.active, 0);
    assert.equal(budget.snapshot.dispatches, 0); assert.throws(() => instance.executionFailed());
  }
});

test("failed construction releases all reservations; excess admission precedes parsing", () => {
  const budget = new ExchangeBudget({ maxActive: 1 });
  assert.throws(() => exchange("client", { budget, requestBytes: Buffer.alloc(0) }));
  assert.equal(budget.snapshot.active, 0); assert.equal(budget.snapshot.bufferedBytes, 0);
  const first = exchange("server", { budget });
  // Bad payload would produce FRAME_TRUNCATED if parsed. Admission refuses first.
  assert.throws(() => exchange("client", { budget, requestBytes: Buffer.alloc(0) }), { code: "ERR_WITNESS_V2_STATE" });
  first.instance.abort(); close(first.instance, first.time);
  assert.equal(budget.snapshot.active, 0);
});

test("repeated timeouts and late input keep diagnostics bounded and never clear unknown", () => {
  const { instance, time, budget } = sentClient(); time.set(2000n); instance.checkDeadline();
  const fixed = instance.outcome;
  for (let i = 0; i < 3 * MAX_EVENTS; i++) { instance.checkDeadline(); instance.append(Buffer.from([0])); }
  assert.equal(instance.outcome, fixed); assert.equal(instance.diagnostics.events.length, MAX_EVENTS);
  assert.ok(instance.diagnostics.droppedEvents > 0); close(instance, time);
  assert.equal(budget.snapshot.active, 0);
});

test("regressing/non-monotonic clock is rejected conservatively and cannot resume dispatch", () => {
  const { instance, time } = received(); time.set(999n);
  assert.throws(() => instance.takeRequest(), { code: "ERR_WITNESS_V2_STATE" });
  time.set(1001n); assert.equal(instance.takeRequest(), null);
  assert.equal(instance.outcome.status, "not-attempted");
  assert.throws(() => exchange("server", { deadlineNs: Date.now() }));
  assert.throws(() => exchange("server", { now: () => Date.now() }));
});
