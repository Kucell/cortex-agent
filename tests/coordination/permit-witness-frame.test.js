"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const frames = require("../../lib/coordination/permit-witness-frame");
const vectors = require("./fixtures/permit-witness-frames.json");
const { encodeFrame, decodeFrame, FrameDecoder, PermitWitnessFrameError, LIMITS } = frames;
const ID = "00112233-4455-6677-8899-aabbccddeeff";

function options(direction) {
  return direction === "request" ? { direction } : { direction,
    expectedOperation: vectors.response_correlation.expected_operation,
    expectedRequestId: vectors.response_correlation.expected_request_id };
}
function input(vector, payload = Buffer.from(vector.payload_hex, "hex")) {
  return { direction: vector.direction, operation: vector.operation,
    requestId: vector.request_id, payload,
    ...(vector.direction === "response" ? { status: vector.status } : {}) };
}
function expected(vector, payload) { return { version: 1, ...input(vector, payload) }; }
function refuses(fn, code) {
  assert.throws(fn, error => error instanceof PermitWitnessFrameError && (!code || error.code === code));
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function request(overrides = {}) {
  return { direction: "request", operation: 2, requestId: ID, payload: Buffer.from("{}"), ...overrides };
}
function response(overrides = {}) { return request({ direction: "response", status: 0, ...overrides }); }

test("shared constants reserve a full MiB plus a separate response status byte", () => {
  assert.equal(frames.VERSION, 1);
  assert.equal(frames.HEADER_BYTES, 22);
  assert.deepEqual(frames.OPERATIONS, { checkpoint: 1, transition: 2 });
  assert.deepEqual(frames.RESPONSE_STATUSES, [0, 1, 2, 3]);
  assert.deepEqual(LIMITS, { payloadBytes: 1048576, requestLength: 1048594,
    responseLength: 1048595, requestBytes: 1048598, responseBytes: 1048599 });
});

// Expected bytes/hashes are stored in language-neutral fixtures, generated with
// Python struct/hashlib independently of the JS encoder. No business module,
// native helper, certificate store, network or persistent store is imported.
for (const vector of vectors.positive) {
  test(`fixed bytes and every split require EOF: ${vector.name}`, () => {
    const wire = Buffer.from(vector.wire_hex, "hex");
    const frame = input(vector);
    assert.equal(sha256(wire), vector.wire_sha256);
    assert.deepEqual(encodeFrame(frame), wire);
    assert.equal(wire.readUInt32BE(0), wire.length - 4);
    assert.deepEqual(wire.subarray(6, 22), Buffer.from("00112233445566778899aabbccddeeff", "hex"));
    assert.deepEqual(decodeFrame(wire, options(vector.direction)), expected(vector));
    for (let split = 0; split <= wire.length; split++) {
      const decoder = new FrameDecoder(options(vector.direction));
      assert.equal(decoder.append(wire.subarray(0, split)), undefined);
      assert.equal(decoder.append(wire.subarray(split)), undefined);
      assert.equal(decoder.append(Buffer.alloc(0)), undefined);
      assert.deepEqual(decoder.finish(), expected(vector));
      refuses(() => decoder.finish(), "ERR_WITNESS_FRAME_CLOSED");
      refuses(() => decoder.append(Buffer.alloc(0)), "ERR_WITNESS_FRAME_CLOSED");
    }
    const decoder = new FrameDecoder(options(vector.direction));
    for (const byte of wire) assert.equal(decoder.append(Buffer.from([byte])), undefined);
    assert.deepEqual(decoder.finish(), expected(vector));
  });
}

for (const vector of vectors.negative) {
  test(`shared rejection, whole and bytewise: ${vector.name}`, () => {
    const wire = Buffer.from(vector.wire_hex, "hex");
    refuses(() => decodeFrame(wire, options(vector.direction)), vector.error);
    const decoder = new FrameDecoder(options(vector.direction));
    refuses(() => {
      for (const byte of wire) decoder.append(Buffer.from([byte]));
      decoder.finish();
    }, vector.error);
    refuses(() => decoder.append(Buffer.from([0])), "ERR_WITNESS_FRAME_CLOSED");
    refuses(() => decoder.finish(), "ERR_WITNESS_FRAME_CLOSED");
  });
}

for (const vector of vectors.boundary) {
  test(`shared maximum capacity: ${vector.name}`, () => {
    // prefix + repeated pattern fills payload_bytes TOTAL, not in addition to it.
    const prefix = Buffer.from(vector.payload_prefix_hex || "", "hex");
    const payload = Buffer.alloc(vector.payload_bytes, Buffer.from(vector.payload_repeat_hex, "hex"));
    prefix.copy(payload);
    const wire = encodeFrame(input(vector, payload));
    assert.equal(wire.length, vector.wire_bytes);
    assert.equal(wire.readUInt32BE(0), vector.length);
    assert.equal(wire.subarray(0, 22).toString("hex"), vector.header_hex);
    assert.equal(sha256(wire), vector.wire_sha256);
    const decoder = new FrameDecoder(options(vector.direction));
    for (let offset = 0; offset < wire.length; offset += 16384) {
      assert.equal(decoder.append(wire.subarray(offset, offset + 16384)), undefined);
    }
    assert.deepEqual(decoder.finish(), expected(vector, payload));
    refuses(() => encodeFrame(input(vector, Buffer.concat([payload, Buffer.from([0])]))), "ERR_WITNESS_FRAME_SIZE");
    refuses(() => encodeFrame(input(vector, Buffer.alloc(0))), "ERR_WITNESS_FRAME_SIZE");
    // Even the exact response maximum is invalid in the request direction.
    if (vector.direction === "response") refuses(() => decodeFrame(wire, options("request")), "ERR_WITNESS_FRAME_SIZE");
  });
}

test("disjoint first bytes reject request/response reflection for both operations and all statuses", () => {
  for (const operation of [1, 2]) {
    const replyOptions = { direction: "response", expectedOperation: operation, expectedRequestId: ID };
    const outgoing = encodeFrame(request({ operation }));
    refuses(() => decodeFrame(outgoing, replyOptions), "ERR_WITNESS_FRAME_PROTOCOL");
    for (const status of [0, 1, 2, 3]) {
      const reply = encodeFrame(response({ operation, status }));
      assert.equal(reply[22], status);
      refuses(() => decodeFrame(reply, options("request")), "ERR_WITNESS_FRAME_PROTOCOL");
      refuses(() => encodeFrame(request({ operation, payload: reply.subarray(22) })), "ERR_WITNESS_FRAME_PROTOCOL");
    }
  }
});

test("request constructor and incremental parser both enforce 0x7b immediately", () => {
  for (const first of [0, 1, 2, 3, 0x20, 0x5b, 0x73, 0xef, 0xff]) {
    refuses(() => encodeFrame(request({ payload: Buffer.from([first]) })), "ERR_WITNESS_FRAME_PROTOCOL");
    const wire = encodeFrame(request({ payload: Buffer.from("{") }));
    wire[22] = first;
    const decoder = new FrameDecoder(options("request"));
    decoder.append(wire.subarray(0, 22));
    refuses(() => decoder.append(wire.subarray(22)), "ERR_WITNESS_FRAME_PROTOCOL");
  }
  // Only a framing discriminator, not a JSON parser or canonicality validator.
  for (const payload of [Buffer.from("{"), Buffer.from('{"verified":true,"facts":{}}'),
    Buffer.from('{ "duplicate":1,"duplicate":2 }'), Buffer.from([0x7b, 0xff])]) {
    assert.deepEqual(decodeFrame(encodeFrame(request({ payload })), options("request")).payload, payload);
  }
});

test("UUID has strict text syntax and text-order bytes, without version/variant policy", () => {
  const wire = encodeFrame(request({ requestId: ID.toUpperCase() }));
  assert.equal(decodeFrame(wire, options("request")).requestId, ID);
  assert.equal(decodeFrame(encodeFrame(response()), { direction: "response",
    expectedOperation: 2, expectedRequestId: ID.toUpperCase() }).requestId, ID);
  for (const requestId of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    assert.equal(decodeFrame(encodeFrame(request({ requestId })), options("request")).requestId, requestId);
  }
  for (const requestId of [undefined, null, 1, Buffer.alloc(16), "", ID.replace(/-/g, ""),
    `{${ID}}`, ` ${ID}`, `${ID}\n`, ID.slice(1), ID.replace("a", "g")]) {
    refuses(() => encodeFrame(request({ requestId })));
    refuses(() => new FrameDecoder({ direction: "response", expectedOperation: 2, expectedRequestId: requestId }));
  }
  // C# default Guid memory order must not accidentally match the canonical UUID.
  const mixedEndian = encodeFrame(response());
  Buffer.from("33221100554477668899aabbccddeeff", "hex").copy(mixedEndian, 6);
  refuses(() => decodeFrame(mixedEndian, options("response")), "ERR_WITNESS_FRAME_MISMATCH");
});

test("all responses require exact UUID and operation, including error-status frames", () => {
  refuses(() => new FrameDecoder({ direction: "response" }));
  refuses(() => new FrameDecoder({ direction: "response", expectedOperation: 2 }));
  refuses(() => new FrameDecoder({ direction: "request", expectedRequestId: ID }));
  for (const status of [0, 1, 2, 3]) {
    const wire = encodeFrame(response({ status }));
    refuses(() => decodeFrame(wire, { direction: "response", expectedOperation: 1, expectedRequestId: ID }), "ERR_WITNESS_FRAME_MISMATCH");
    refuses(() => decodeFrame(wire, { direction: "response", expectedOperation: 2,
      expectedRequestId: "10112233-4455-6677-8899-aabbccddeeff" }), "ERR_WITNESS_FRAME_MISMATCH");
  }
});

test("trailing bytes fail even in a later chunk, and partial EOF permanently closes the decoder", () => {
  for (const direction of ["request", "response"]) {
    const wire = encodeFrame(direction === "request" ? request() : response());
    for (const trailing of [Buffer.from([0]), wire]) {
      const decoder = new FrameDecoder(options(direction));
      assert.equal(decoder.append(wire), undefined);
      refuses(() => decoder.append(trailing), "ERR_WITNESS_FRAME_PROTOCOL");
      refuses(() => decoder.finish(), "ERR_WITNESS_FRAME_CLOSED");
    }
    for (let length = 0; length < wire.length; length++) {
      const decoder = new FrameDecoder(options(direction));
      decoder.append(wire.subarray(0, length));
      refuses(() => decoder.finish(), "ERR_WITNESS_FRAME_TRUNCATED");
      refuses(() => decoder.append(wire.subarray(length)), "ERR_WITNESS_FRAME_CLOSED");
    }
  }
});

test("hostile length is rejected on the fourth byte before any body is required", () => {
  for (const direction of ["request", "response"]) {
    const minimum = direction === "response" ? 20 : 19;
    const maximum = direction === "response" ? LIMITS.responseLength : LIMITS.requestLength;
    for (const length of [0, minimum - 1, maximum + 1, 0x80000000, 0xffffffff]) {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(length);
      const decoder = new FrameDecoder(options(direction));
      decoder.append(prefix.subarray(0, 3));
      refuses(() => decoder.append(prefix.subarray(3)), "ERR_WITNESS_FRAME_SIZE");
    }
  }
});

test("direction, operation, version, buffer and status inputs have no coercion or defaults", () => {
  for (const direction of [undefined, null, "", "Request", "exchange", 1]) {
    refuses(() => encodeFrame(request({ direction })));
    refuses(() => new FrameDecoder({ direction }));
  }
  for (const operation of [undefined, null, 0, 3, 255, "1", true, NaN, 1.5]) {
    refuses(() => encodeFrame(request({ operation })));
    refuses(() => new FrameDecoder({ direction: "response", expectedOperation: operation, expectedRequestId: ID }));
  }
  for (const status of [undefined, null, -1, 4, 255, "0", false, NaN, 0.5]) refuses(() => encodeFrame(response({ status })));
  for (const status of [undefined, 0, 1, 2, 3]) refuses(() => encodeFrame(request({ status })));
  for (const version of [null, 0, 2, "1", true]) refuses(() => encodeFrame(request({ version })));
  for (const payload of [undefined, null, "{}", [0x7b], new Uint8Array([0x7b])]) {
    refuses(() => encodeFrame(request({ payload })));
    const decoder = new FrameDecoder(options("request"));
    refuses(() => decoder.append(payload));
    refuses(() => decoder.finish(), "ERR_WITNESS_FRAME_CLOSED");
  }
  for (const value of [undefined, null, [], "request"]) {
    refuses(() => encodeFrame(value));
    refuses(() => new FrameDecoder(value));
  }
});

test("codec owns its byte snapshots and returned values carry no authentication or execution facts", () => {
  const original = response({ payload: Buffer.from([0xff, 0x00]) });
  const wire = encodeFrame(original);
  original.payload.fill(0);
  const decoder = new FrameDecoder(options("response"));
  decoder.append(wire);
  wire.fill(0);
  const frame = decoder.finish();
  assert.deepEqual(frame.payload, Buffer.from([0xff, 0x00]));
  assert.deepEqual(Object.keys(frame).sort(), ["direction", "operation", "payload", "requestId", "status", "version"]);
  assert.deepEqual(decodeFrame(encodeFrame(frame), options("response")), frame);
});
