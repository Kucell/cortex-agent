"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const wire = require("../../lib/coordination/permit-witness-v2-wire");
const v1 = require("../../lib/coordination/permit-witness-wire");
const contract = require("../../lib/coordination/permit-witness-contract");
const frame = require("../../lib/coordination/permit-witness-v2-frame");
const { ID, OTHER, args, request, outcome, raw, checkpoint } = require("./fixtures/permit-witness-v2");
const canonical = value => contract.canonicalBytes(value);

test("all three actions and four result categories retain full wire semantics and independent business keys", () => {
  for (const action of ["register", "issue", "consume"]) {
    const bytes = request(action), copy = Buffer.from(bytes); copy[4] = 1;
    assert.deepEqual(wire.decodeRequest(bytes), v1.decodeRequest(copy));
    assert.deepEqual(wire.toHostRequest(bytes), v1.toHostRequest(copy));
    const mapped = wire.toHostRequest(bytes);
    assert.equal(mapped.requestId, ID); assert.equal(Object.hasOwn(mapped, "identity"), false);
    assert.ok(Object.isFrozen(mapped.args));
    if (action === "register") assert.equal(mapped.args.requestId, "registration-1");
    if (action === "issue") {
      assert.equal(mapped.args.lease.idempotencyKey, "lease-key");
      assert.equal(mapped.args.permit.idempotencyKey, "permit-key");
    }
    for (const status of Object.keys(wire.STATUS)) {
      const body = outcome(status, action), reply = wire.encodeResponse(bytes, body);
      assert.equal(reply[4], 2); assert.equal(reply[22], wire.STATUS[status]);
      assert.deepEqual(wire.decodeResponse(reply, bytes), { format_version: 1, ...body });
      assert.equal(wire.decodeResponse(reply, bytes).executionAuthorized, false);
      assert.throws(() => v1.decodeResponse(reply, copy));
      const v1Reply = Buffer.from(reply); v1Reply[4] = 1;
      assert.throws(() => wire.decodeResponse(v1Reply, bytes));
    }
    assert.throws(() => wire.decodeRequest(copy));
  }
});

test("original UTF-8 and canonical JSON cannot be laundered through the version adapter", () => {
  const valid = canonical(wire.decodeRequest(request()).body).toString();
  for (const payload of [valid + "\n", " " + valid, "\uFEFF" + valid,
    valid.replace('"action":"register"', '"action":"register","action":"register"'),
    valid.replace('"targetId":"target-a"', '"targetId":"target-a","\\u0074argetId":"target-a"'),
    valid.replace('"format_version":1', '"format_version":1e0'),
    valid.replace('"action":"register"', '"action":"regist\\u0065r"'),
    '{}{}', '{"x":9007199254740993}', '{"x":-0}', '{"x":0.1}',
    '{"x":' + "[".repeat(18) + "0" + "]".repeat(18) + "}",
    '{"x":[' + Array(1025).fill("0").join(",") + "]}",
    '{"x":"' + "x".repeat(65537) + '"}']) {
    assert.throws(() => wire.decodeRequest(raw(payload)));
  }
  for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    assert.throws(() => wire.decodeRequest(raw(Buffer.concat([Buffer.from('{"x":"'), Buffer.from(invalid), Buffer.from('"}')]))),
      { code: "ERR_WITNESS_WIRE_JSON" });
  }
  const input = args(); input.pin.source_digest = "中文😀é e\u0301\ufffd";
  assert.equal(wire.toHostRequest(request("register", input)).args.pin.source_digest, input.pin.source_digest);
});

test("exact request schemas reject identity/facts/state, unknown nested fields and payload version changes", () => {
  const body = wire.decodeRequest(request()).body;
  for (const field of ["identity", "state", "facts", "providers", "executionAuthorized", "now_ms"]) {
    assert.throws(() => wire.decodeRequest(raw(canonical({ ...body, [field]: true }))));
    const input = args(); input[field] = true;
    assert.throws(() => request("register", input));
    const nested = args(); nested.pin[field] = true;
    assert.throws(() => request("register", nested));
  }
  for (const format_version of [0, 2, 3, "1"]) {
    assert.throws(() => wire.decodeRequest(raw(canonical({ ...body, format_version }))));
  }
  for (const action of ["accept_permit", "observe_clock", "deriveTransition", "query"]) {
    assert.throws(() => wire.decodeRequest(raw(canonical({ ...body, action }))));
  }
  for (const action of ["register", "issue", "consume"]) {
    const input = args(action); delete input.checkpoint;
    assert.throws(() => request(action, input));
  }
  let invoked = false;
  const accessor = args(); Object.defineProperty(accessor, "pin", { enumerable: true, get() { invoked = true; } });
  assert.throws(() => request("register", accessor)); assert.equal(invoked, false);
});

test("response correlation, canonical bytes, reflection and exact status/commit/result/code are mandatory", () => {
  const req = request();
  for (const status of Object.keys(wire.STATUS)) {
    const response = wire.encodeResponse(req, outcome(status));
    for (const field of [4, 5, 6, 22]) {
      const bad = Buffer.from(response); bad[field] = 255;
      assert.throws(() => wire.decodeResponse(bad, req));
    }
    for (const change of [b => { b.commit = "wrong"; }, b => { b.mode = "production"; },
      b => { b.executionAuthorized = true; }, b => { b.format_version = 2; },
      b => { b.status = status === "committed" ? "unknown" : "committed"; },
      b => { b.extra = true; }, b => { b[status === "committed" ? "code" : "result"] = "ERR_TEST"; }]) {
      const body = { format_version: 1, ...outcome(status) }; change(body);
      assert.throws(() => wire.decodeResponse(raw(canonical(body), true, { status: wire.STATUS[status] }), req));
    }
    const body = { format_version: 1, ...outcome(status) };
    assert.throws(() => wire.decodeResponse(raw(canonical(body).toString() + "\n", true, { status: wire.STATUS[status] }), req));
    assert.throws(() => wire.decodeResponse(response, request("register", args(), OTHER)));
  }
  assert.throws(() => wire.decodeResponse(req, req));
  assert.throws(() => wire.decodeResponse(Buffer.concat([wire.encodeResponse(req, outcome()), Buffer.from([0])]), req));
});

test("per-action committed results validate checkpoints, signature and all request bindings", () => {
  for (const action of ["register", "issue", "consume"]) {
    const req = request(action), body = outcome("committed", action);
    body.result.executionAuthorized = true;
    assert.throws(() => wire.encodeResponse(req, body));
  }
  for (const change of [b => { b.result.checkpoint.revision = 3; },
    b => { b.result.reused = true; }, b => { b.result.checkpoint.format_version = 2; }]) {
    const body = outcome(); change(body); assert.throws(() => wire.encodeResponse(request(), body));
  }
  const consumed = outcome("committed", "consume"); consumed.result.permitId = "other";
  assert.throws(() => wire.encodeResponse(request("consume"), consumed));
  const wrongBinding = outcome("committed", "consume"); wrongBinding.result.checkpoint.store_generation = "other";
  assert.throws(() => wire.encodeResponse(request("consume"), wrongBinding));
  for (const change of [b => { b.result.signedPermit.signature = Buffer.alloc(64).toString("base64"); },
    b => { b.result.signedPermit.message.host_identity = "other"; },
    b => { b.result.fingerprint = "0".repeat(64); },
    b => { b.result.signedPermit.sequence = 2; }]) {
    const body = outcome("committed", "issue"); change(body);
    assert.throws(() => wire.encodeResponse(request("issue"), body));
  }
  // A separately valid signed reply for different request bindings is refused.
  const req = request("issue"), changed = args("issue"); changed.lease.hostId = "other";
  const reply = wire.encodeResponse(req, outcome("committed", "issue"));
  assert.throws(() => wire.decodeResponse(reply, request("issue", changed)));
});

test("checkpoint is syntax only; v2 adds neither unknown recovery nor an alternate operation", () => {
  const req = wire.encodeRequest({ operation: 1, requestId: ID,
    body: { format_version: 1, targetId: "target-a", checkpoint: checkpoint() } });
  assert.equal(wire.decodeRequest(req).operation, frame.OPERATIONS.checkpoint);
  assert.throws(() => wire.toHostRequest(req), { code: "ERR_WITNESS_WIRE_CHECKPOINT_QUERY_UNSUPPORTED" });
  assert.throws(() => wire.encodeResponse(req, outcome()), { code: "ERR_WITNESS_WIRE_CHECKPOINT_QUERY_UNSUPPORTED" });
  assert.equal(Object.hasOwn(wire, "retry"), false);
});
