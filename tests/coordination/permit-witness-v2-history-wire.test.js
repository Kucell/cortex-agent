"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const wire = require("../../lib/coordination/permit-witness-v2-history-wire");
const v1 = require("../../lib/coordination/permit-witness-wire");
const old = require("../../lib/coordination/permit-witness-v2-wire");
const frame = require("../../lib/coordination/permit-witness-v2-frame");
const { SingleExchange, ExchangeBudget } = require("../../lib/coordination/permit-witness-v2-exchange");
const legacy = require("./fixtures/permit-witness-v2");
const { ID, OTHER, query, checkpoint, request, outcome, raw, canonical, digest } = require("./fixtures/permit-witness-v2-history");
function responseBody(q = query(), status = "observed", found = true) {
  return { format_version: 2, queryDigest: digest(q), ...outcome(q, status, found) };
}
function rejectsQuery(q) {
  const body = { format_version: 2, action: "history.query", args: q };
  assert.throws(() => request(q));
  assert.throws(() => wire.decodeRequest(raw(canonical(body))));
}
function rejectsResponse(q, mutate) {
  const body = responseBody(q); mutate(body);
  const { format_version, queryDigest, ...value } = body;
  assert.throws(() => wire.encodeResponse(request(q), value));
  assert.throws(() => wire.decodeResponse(raw(canonical(body), true), request(q)));
}
function assertFrozen(value) {
  if (value && typeof value === "object") { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(assertFrozen); }
}

test("three original query types map without defaults to an immutable, explicitly historical request", () => {
  for (const action of ["register", "issue", "consume"]) {
    const q = query(action), bytes = request(q), decoded = wire.decodeRequest(bytes), mapped = wire.toHostRequest(bytes);
    assert.equal(bytes[4], 2); assert.equal(bytes[5], 2);
    assert.deepEqual(decoded, { operation: 2, requestId: ID, body: { format_version: 2, action: "history.query", args: q } });
    assert.deepEqual(mapped, { kind: "history", requestId: ID, query: q }); assertFrozen(mapped);
    assert.equal(Object.hasOwn(mapped, "identity"), false); assert.equal(Object.hasOwn(mapped, "action"), false);
  }
});

test("all history outcomes retain original unknown, never committed, with queryDigest at every response boundary", () => {
  assert.deepEqual(wire.HISTORY_STATUS, { observed: 0, rejected: 1, unknown: 2, unavailable: 3 });
  assert.equal(Object.hasOwn(wire.HISTORY_STATUS, "committed"), false);
  for (const action of ["register", "issue", "consume"]) for (const status of Object.keys(wire.HISTORY_STATUS)) {
    const q = query(action), req = request(q), value = outcome(q, status), reply = wire.encodeResponse(req, value);
    const result = wire.decodeResponse(reply, req);
    assert.equal(reply[22], wire.HISTORY_STATUS[status]);
    assert.deepEqual(result, { format_version: 2, queryDigest: digest(q), ...value }); assertFrozen(result);
    assert.equal(result.originalRequestOutcome, "unknown"); assert.equal(result.resumeAllowed, false);
    assert.equal(result.commit, "not-applicable");
    assert.equal(Object.hasOwn(result, status === "observed" ? "code" : "result"), false);
  }
});

test("bounded absence and older checkpoints are observations only, including poisoned authority", () => {
  for (const action of ["register", "issue", "consume"]) {
    const q = query(action), value = outcome(q, "observed", false); value.result.clockPoisoned = true;
    if (action === "register") value.result.currentCheckpoint = null;
    const result = wire.decodeResponse(wire.encodeResponse(request(q), value), request(q));
    assert.equal(result.result.effect, null); assert.equal(result.result.status, "not-found-at-boundary");
    assert.equal(result.result.clockPoisoned, true); assert.equal(result.originalRequestOutcome, "unknown");
  }
  const q = query("consume"), value = outcome(q);
  value.result.currentCheckpoint.revision = 9;
  value.result.effect.checkpoint.revision = 3;
  assert.equal(wire.decodeResponse(wire.encodeResponse(request(q), value), request(q)).result.effect.checkpoint.revision, 3);
});

test("v1 and old v2 entrypoints reject new requests and responses, with no byte-version laundering", () => {
  const q = query(), req = request(q), response = wire.encodeResponse(req, outcome(q));
  for (const codec of [v1, old]) {
    assert.throws(() => codec.encodeRequest(wire.decodeRequest(req)));
    assert.throws(() => codec.decodeRequest(req)); assert.throws(() => codec.toHostRequest(req));
    assert.throws(() => codec.decodeResponse(response, req));
    const business = legacy.request(); business[4] = codec === v1 ? 1 : 2;
    assert.throws(() => codec.encodeResponse(business, outcome(q)));
  }
  const changedReq = Buffer.from(req), changedResponse = Buffer.from(response); changedReq[4] = 1; changedResponse[4] = 1;
  assert.throws(() => v1.decodeRequest(changedReq)); assert.throws(() => wire.decodeRequest(changedReq));
  assert.throws(() => wire.decodeResponse(changedResponse, req));
  assert.throws(() => v1.decodeResponse(changedResponse, changedReq));
  for (const action of ["register", "issue", "consume"]) {
    assert.throws(() => wire.decodeRequest(legacy.request(action)));
    const body = { format_version: 2, action, args: legacy.args(action) };
    assert.throws(() => wire.decodeRequest(raw(canonical(body))));
  }
});

test("old business bytes/statuses remain compatible and every checkpoint dispatch stays refused", () => {
  for (const action of ["register", "issue", "consume"]) for (const status of Object.keys(old.STATUS)) {
    const req = legacy.request(action), v1req = Buffer.from(req); v1req[4] = 1;
    const reply = old.encodeResponse(req, legacy.outcome(status, action));
    const v1reply = v1.encodeResponse(v1req, legacy.outcome(status, action));
    const expected = Buffer.from(v1reply); expected[4] = 2; assert.deepEqual(reply, expected);
    assert.equal(old.decodeResponse(reply, req).status, status);
    assert.throws(() => wire.decodeResponse(reply, req));
  }
  const cp = { format_version: 1, targetId: "target-a", checkpoint: legacy.checkpoint() };
  const req = old.encodeRequest({ operation: 1, requestId: ID, body: cp });
  const v1req = Buffer.from(req); v1req[4] = 1;
  assert.throws(() => v1.toHostRequest(v1req)); assert.throws(() => old.toHostRequest(req));
  assert.throws(() => wire.decodeRequest(req));
  assert.throws(() => wire.encodeRequest({ operation: 1, requestId: ID,
    body: { format_version: 2, action: "history.query", args: query() } }));
  assert.throws(() => wire.decodeRequest(raw(canonical({ format_version: 2, action: "history.query", args: query() }), false, { operation: 1 })));
  const exchange = new SingleExchange({ role: "server", budget: new ExchangeBudget(), deadlineNs: 2000n, now: () => 1000n });
  exchange.append(req); assert.throws(() => exchange.takeRequest());
  assert.equal(exchange.diagnostics.events.some(e => e.type === "DISPATCHED"), false);
  const history = new SingleExchange({ role: "server", budget: new ExchangeBudget(), deadlineNs: 2000n, now: () => 1000n });
  assert.throws(() => history.append(request()));
  assert.equal(history.diagnostics.events.some(e => e.type === "DISPATCHED"), false);
});

test("original canonical UTF-8 is mandatory for both request and response, not a parsed/reencoded substitute", () => {
  const reqBody = { format_version: 2, action: "history.query", args: query() }, resBody = responseBody(reqBody.args);
  for (const [body, response] of [[reqBody, false], [resBody, true]]) {
    const valid = canonical(body).toString();
    const payloads = [valid + "\n", " " + valid, "\ufeff" + valid,
      valid.replace('"format_version":2', '"format_version":2e0'),
      valid.replace('"mode":"development-only"', '"mode":"development-only","mode":"development-only"'),
      valid.replace('"targetId":"target-a"', '"targetId":"target-a","\\u0074argetId":"target-a"'),
      '{"x":-0}', '{"x":9007199254740993}', '{"x":0.1}', '{}{}',
      '{"x":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}',
      '{"x":[' + Array(1025).fill('0').join(',') + ']}', '{"x":"' + 'x'.repeat(65537) + '"}'];
    for (const payload of payloads) {
      if (payload === valid) continue;
      assert.throws(() => response ? wire.decodeResponse(raw(payload, true), request(reqBody.args)) : wire.decodeRequest(raw(payload)));
    }
    for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
      const payload = Buffer.concat([Buffer.from('{"x":"'), Buffer.from(invalid), Buffer.from('"}')]);
      assert.throws(() => response ? wire.decodeResponse(raw(payload, true), request(reqBody.args)) : wire.decodeRequest(raw(payload)));
    }
  }
  const q = query(); q.request.pin.source_digest = "中文😀é e\u0301\ufffd";
  assert.equal(wire.toHostRequest(request(q)).query.request.pin.source_digest, q.request.pin.source_digest);
  assert.equal(wire.decodeResponse(wire.encodeResponse(request(q), outcome(q)), request(q)).queryDigest, digest(q));
  const q2 = query("issue"); q2.request.permit.targetDigest = q2.resources.permit.targetDigest = "A".repeat(64);
  assert.deepEqual(wire.toHostRequest(request(q2)).query, q2);
  // Historical pin records preserve signed safe integers without applying
  // current-signing eligibility or an interval-order policy on the read path.
  const historical = query(); historical.request.pin.valid_from = 10; historical.request.pin.valid_until = -1;
  assert.deepEqual(wire.toHostRequest(request(historical)).query, historical);
});

test("request exact schemas and every resource/target/generation binding reject substitutions", () => {
  for (const action of ["register", "issue", "consume"]) {
    const q = query(action);
    const objects = [q, q.resources, q.request, ...(action === "register" ? [q.request.pin] :
      [q.resources.lease, q.resources.permit, q.request.checkpoint,
        ...(action === "issue" ? [q.request.lease, q.request.permit] : [q.request.message])])];
    for (let i = 0; i < objects.length; i++) for (const field of ["identity", "facts", "state", "providers", "executionAuthorized"]) {
      objects[i][field] = true; rejectsQuery(q); delete objects[i][field];
    }
    for (const field of Object.keys(q)) { const bad = structuredClone(q); delete bad[field]; rejectsQuery(bad); }
    const bad = structuredClone(q); bad.operation = [action]; rejectsQuery(bad);
  }
  const issue = query("issue");
  const mutations = [q => { q.targetGeneration = null; }, q => { q.request.checkpoint = null; },
    q => { q.request.checkpoint.authority_id = "other"; }, q => { q.request.checkpoint.target_id = "other"; },
    q => { q.request.checkpoint.store_generation = "old"; }, q => { q.request.checkpoint.revision = 0; },
    q => { q.request.checkpoint.full_state_digest = "A".repeat(64); }, q => { q.resources.fingerprint = "A".repeat(64); },
    q => { q.request.batchFingerprint = "f".repeat(64); }, q => { q.request.lease.idempotencyKey = "__proto__"; },
    q => { q.request.permit.ttlMs = 0; },
    ...Object.keys(issue.resources.lease).map(k => q => { q.request.lease[k] = "other"; }),
    ...Object.keys(issue.resources.permit).map(k => q => { q.request.permit[k] = k === "operation" ? "other" : "f".repeat(64); })];
  for (const mutate of mutations) { const q = structuredClone(issue); mutate(q); rejectsQuery(q); }
  for (const change of [q => { q.resources.lease = {}; }, q => { q.request.pin.fingerprint = "f".repeat(64); },
    q => { q.request.pin.instance_id = "other"; }, q => { q.request.pin.decision_id = "other"; },
    q => { q.request.pin.valid_until = 0.5; }, q => { q.request.pin.public_key_pem = "PRIVATE KEY"; }]) {
    const q = query(); change(q); rejectsQuery(q);
  }
  for (const change of [q => { q.request.signature = "invalid"; }, q => { q.request.message.sequence = 0; },
    q => { q.request.message.deadline_ms = 1000; }, q => { q.request.message.host_identity = "other"; },
    q => { q.request.message.params_digest = "f".repeat(64); }]) {
    const q = query("consume"); change(q); rejectsQuery(q);
  }
});

test("response state words, safety flags, digests and frame correlation cannot be mixed", () => {
  const q = query(), req = request(q), reply = wire.encodeResponse(req, outcome(q));
  for (const mutate of [b => { b.status = "committed"; }, b => { b.commit = "confirmed"; },
    b => { b.commit = "unknown"; }, b => { b.executionAuthorized = true; }, b => { b.resumeAllowed = true; },
    b => { b.originalRequestOutcome = "committed"; }, b => { b.mode = "production"; },
    b => { b.result.executionAuthorized = true; }, b => { b.result.resumeAllowed = true; },
    b => { b.result.originalRequestOutcome = "failed"; }, b => { b.code = "ERR_ECHO"; }]) rejectsResponse(q, mutate);
  for (const mutate of [b => { b.queryDigest = "f".repeat(64); }, b => { b.format_version = 1; }]) {
    const body = responseBody(q); mutate(body); assert.throws(() => wire.decodeResponse(raw(canonical(body), true), req));
  }
  for (const status of [1, 2, 3]) assert.throws(() => wire.decodeResponse(raw(canonical(responseBody(q)), true, { status }), req));
  for (const status of ["rejected", "unknown", "unavailable"]) {
    const value = outcome(q, status); value.commit = status === "unknown" ? "unknown" : "not-attempted";
    assert.throws(() => wire.encodeResponse(req, value));
    const body = responseBody(q, status); body.result = outcome(q).result;
    assert.throws(() => wire.decodeResponse(raw(canonical(body), true, { status: wire.HISTORY_STATUS[status] }), req));
    for (const code of ["", "private error", "ERR_" + "X".repeat(129), 42]) {
      const invalid = outcome(q, status); invalid.code = code;
      assert.throws(() => wire.encodeResponse(req, invalid));
      assert.throws(() => wire.decodeResponse(raw(canonical({ format_version: 2, queryDigest: digest(q), ...invalid }), true,
        { status: wire.HISTORY_STATUS[status] }), req));
    }
  }
  const changed = query(); changed.request.requestId = "different";
  assert.throws(() => wire.decodeResponse(reply, request(changed))); // same UUID, different complete query
  assert.throws(() => wire.decodeResponse(reply, request(q, OTHER)));
  for (const overrides of [{ requestId: OTHER }, { operation: 1 }]) assert.throws(() => wire.decodeResponse(raw(canonical(responseBody(q)), true, overrides), req));
  assert.throws(() => wire.decodeResponse(req, req));
  assert.throws(() => wire.decodeResponse(Buffer.concat([reply, Buffer.from([0])]), req));
});

test("response whitelist rejects signature/key/state/request echoes at EVERY object boundary", () => {
  for (const action of ["register", "issue", "consume"]) {
    const q = query(action), original = responseBody(q);
    const paths = [[], ["result"], ["result", "boundary"], ["result", "effect"], ["result", "currentCheckpoint"],
      ...(action === "issue" ? [] : [["result", "effect", "checkpoint"]])];
    for (const path of paths) for (const field of ["signature", "signedPermit", "signedIssuance", "message_bytes", "message", "bytes", "publicKeyPem", "public_key_pem", "state", "request", "extra"]) {
      rejectsResponse(q, body => { let object = body; for (const key of path) object = object[key]; object[field] = "injected"; });
    }
    for (const key of Object.keys(original.result.effect)) rejectsResponse(q, body => { delete body.result.effect[key]; });
    rejectsResponse(q, body => { body.result.effect.historicalPrincipal = "original-owner"; });
  }
});

test("boundary, checkpoint and per-effect semantics cannot exaggerate the persisted observation", () => {
  for (const action of ["register", "issue", "consume"]) {
    const q = query(action);
    for (const change of [b => { b.result.operation = "other"; }, b => { b.result.status = "committed"; },
      b => { b.result.clockPoisoned = "false"; }, b => { b.result.boundary.decisionId = "other"; },
      b => { b.result.boundary.authorityId = "other"; }, b => { b.result.boundary.issuerStoreId = "other"; },
      b => { b.result.boundary.bodyDigest = "invalid"; }, b => { b.result.boundary.anchorSequence++; },
      b => { b.result.boundary.highWaterSequence = 6; }, b => { b.result.currentCheckpoint = null; },
      b => { b.result.currentCheckpoint.target_id = "other"; }, b => { b.result.effect.kind = "other"; },
      b => { b.result.effect.requestMatch = "exact-original-success"; }]) rejectsResponse(q, change);
    const absent = outcome(q, "observed", false); absent.result.effect = outcome(q).result.effect;
    assert.throws(() => wire.encodeResponse(request(q), absent));
    if (action !== "issue") for (const change of [b => { b.result.effect.checkpoint.revision = 5; },
      b => { b.result.effect.checkpoint.store_generation = "old"; },
      b => { b.result.effect.checkpoint.revision = 4; b.result.effect.checkpoint.full_state_digest = "e".repeat(64); }]) rejectsResponse(q, change);
    if (action !== "consume") rejectsResponse(q, b => { b.result.effect.requestDigest = "f".repeat(64); });
  }
  rejectsResponse(query(), b => { b.result.effect.reused = true; });
  rejectsResponse(query("issue"), b => { b.result.effect.status = "reserved"; });
  rejectsResponse(query("issue"), b => { b.result.effect.inputCheckpoint = "verified"; });
  for (const change of [b => { b.result.effect.permitId = "other"; }, b => { b.result.effect.atMs = -1; },
    b => { b.result.effect.atMs = 3000; }, b => { b.result.effect.fullRequestDigest = "verified"; }]) rejectsResponse(query("consume"), change);
});

test("encoding rejects accessors, toJSON, cycles, malformed format/action and oversized input without invoking callbacks", () => {
  let invoked = false;
  const q = query(); Object.defineProperty(q, "request", { enumerable: true, get() { invoked = true; } });
  assert.throws(() => request(q)); assert.equal(invoked, false);
  assert.throws(() => request({ toJSON() { invoked = true; } })); assert.equal(invoked, false);
  const cycle = query(); cycle.request = cycle; assert.throws(() => request(cycle));
  const req = request(), value = outcome();
  Object.defineProperty(value, "result", { enumerable: true, get() { invoked = true; } });
  assert.throws(() => wire.encodeResponse(req, value)); assert.equal(invoked, false);
  for (const version of [0, 1, 3, "2"]) assert.throws(() => wire.decodeRequest(raw(canonical({ format_version: version, action: "history.query", args: query() }))));
  for (const action of ["query", "register", "consume", "deriveTransition"]) assert.throws(() => wire.decodeRequest(raw(canonical({ format_version: 2, action, args: query() }))));
  const target = { operation: 2, requestId: ID, body: { format_version: 2, action: "history.query", args: query() }, extra: true };
  let reads = 0;
  const proxy = new Proxy(target, { ownKeys: o => ++reads === 1 ? Reflect.ownKeys(o).filter(k => k !== "extra") : Reflect.ownKeys(o) });
  assert.throws(() => wire.encodeRequest(proxy));
  const nested = { body: { format_version: 2, action: "history.query", args: query() }, extra: true };
  assert.throws(() => wire.encodeRequest({ operation: 2, requestId: ID, ...nested }));
  assert.throws(() => wire.decodeRequest(Buffer.alloc(frame.LIMITS.requestBytes + 1)));
  assert.throws(() => wire.decodeResponse(Buffer.alloc(frame.LIMITS.responseBytes + 1), req));
});

test("an accepted maximum payload can be encoded without charging the API wrapper to the wire budget", () => {
  // Populate only legal original labels; body size is the actual framing limit.
  const q = query("issue"), fields = Object.keys(q.resources.lease);
  let left = 1024 * 1024 - canonical({ format_version: 2, action: "history.query", args: q }).length;
  for (const k of fields) {
    const add = Math.min(Math.floor(left / 2), 65536 - Buffer.byteLength(q.resources.lease[k]));
    q.resources.lease[k] += "x".repeat(add); q.request.lease[k] = q.resources.lease[k]; left -= add * 2;
  }
  q.issuerStoreId += "x".repeat(left); left = 0;
  assert.equal(left, 0);
  const body = { format_version: 2, action: "history.query", args: q }, payload = canonical(body);
  assert.equal(payload.length, 1024 * 1024);
  const bytes = raw(payload);
  assert.deepEqual(wire.encodeRequest(wire.decodeRequest(bytes)), bytes);
});

test("offline encode/decode never calls filesystem, process, network, host/store or recovery effects", () => {
  const fs = require("node:fs"), cp = require("node:child_process"), net = require("node:net"), tls = require("node:tls");
  const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
  const targets = [[fs, ["openSync", "readFileSync", "writeFileSync", "appendFileSync", "mkdirSync"]],
    [cp, ["spawn", "fork", "execSync"]], [net, ["connect", "createConnection"]], [tls, ["connect"]],
    [Store, ["initialize", "open", "recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]],
    [Store.prototype, ["snapshot", "queryWitnessHistory", "registerWitnessTarget", "issueWitnessPermit", "consumeWithCheckpoint"]]];
  const originals = targets.flatMap(([object, names]) => names.map(name => [object, name, object[name]]));
  const cases = ["register", "issue", "consume"].map(action => { const q = query(action); return { q, value: outcome(q) }; });
  let effects = 0;
  for (const [object, name] of originals) object[name] = () => { effects++; throw new Error("forbidden offline effect"); };
  try {
    for (const { q, value } of cases) {
      const req = request(q); wire.toHostRequest(req);
      assert.equal(wire.decodeResponse(wire.encodeResponse(req, value), req).status, "observed");
    }
  } finally { for (const [object, name, value] of originals) object[name] = value; }
  assert.equal(effects, 0);
});

test("offline history decoding cannot revive a terminated original exchange or expose executable/recovery surfaces", () => {
  const originalRequest = legacy.request("issue"), original = new SingleExchange({ role: "client", requestBytes: originalRequest,
    deadlineNs: 2000n, now: () => 1000n, budget: new ExchangeBudget() });
  original.takeRequest(); original.sendFailed("rst"); const unknown = original.outcome;
  assert.equal(unknown.status, "unknown");
  const q = query("issue"), req = request(q), bytes = wire.encodeResponse(req, outcome(q));
  assert.equal(wire.decodeResponse(bytes, req).status, "observed");
  assert.equal(original.outcome, unknown); assert.equal(original.outcome.status, "unknown");
  original.append(old.encodeResponse(originalRequest, legacy.outcome("committed", "issue")));
  assert.equal(original.outcome, unknown);
  for (const method of ["retry", "recover", "resume", "dispatch", "queryHistory", "WireExchange"]) {
    assert.equal(Object.hasOwn(wire, method), false);
  }
});
