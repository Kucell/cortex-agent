"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const frame = require("../../lib/coordination/permit-witness-v2-frame");
const v1 = require("../../lib/coordination/permit-witness-frame");
const vectors = require("./fixtures/permit-witness-frames.json");
const { ID, raw } = require("./fixtures/permit-witness-v2");
const options = direction => ({ direction, ...(direction === "response" ? { expectedOperation: 2, expectedRequestId: ID } : {}) });

test("v2 layout preserves fixed text-order UUID vectors, four statuses and exact length limits", () => {
  assert.equal(frame.VERSION, 2);
  assert.deepEqual(frame.LIMITS, v1.LIMITS);
  for (const vector of vectors.positive) {
    const bytes = Buffer.from(vector.wire_hex, "hex"); bytes[4] = 2;
    const opts = { direction: vector.direction, ...(vector.direction === "response" ? {
      expectedOperation: vector.operation, expectedRequestId: ID } : {}) };
    const decoded = frame.decodeFrame(bytes, opts);
    assert.equal(decoded.version, 2); assert.equal(decoded.requestId, ID);
    assert.deepEqual(frame.encodeFrame(decoded), bytes);
    // Every split releases as soon as length is satisfied; no end/finish call.
    for (let split = 0; split < bytes.length; split++) {
      const decoder = new frame.FrameDecoder(opts);
      assert.equal(decoder.append(bytes.subarray(0, split)), null);
      const result = decoder.append(bytes.subarray(split));
      assert.deepEqual(result.frame, decoded); assert.equal(result.trailingBytes, 0);
      assert.equal(decoder.bufferedBytes, 0);
      assert.throws(() => decoder.append(Buffer.alloc(0)), { code: "ERR_WITNESS_FRAME_CLOSED" });
    }
    const decoder = new frame.FrameDecoder(opts);
    for (let i = 0; i < bytes.length; i++) {
      const result = decoder.append(bytes.subarray(i, i + 1));
      if (i < bytes.length - 1) assert.equal(result, null); else assert.deepEqual(result.bytes, bytes);
    }
  }
});

test("length limits reject before frame allocation and failures latch closed", () => {
  for (const direction of ["request", "response"]) {
    const max = direction === "request" ? frame.LIMITS.requestLength : frame.LIMITS.responseLength;
    for (const length of [0, 18, direction === "response" ? 19 : 17, max + 1, 0xffffffff]) {
      const decoder = new frame.FrameDecoder(options(direction));
      const header = Buffer.alloc(4); header.writeUInt32BE(length);
      decoder.append(header.subarray(0, 3)); assert.equal(decoder.bufferedBytes, 4);
      assert.throws(() => decoder.append(header.subarray(3)), { code: "ERR_WITNESS_FRAME_SIZE" });
      assert.equal(decoder.bufferedBytes, 0);
      assert.throws(() => decoder.finish(), { code: "ERR_WITNESS_FRAME_CLOSED" });
    }
    const payload = Buffer.alloc(frame.LIMITS.payloadBytes, 0x7b);
    const bytes = raw(payload, direction === "response");
    const decoder = new frame.FrameDecoder(options(direction));
    for (let i = 0; i < bytes.length - 1; i += 8192) {
      assert.equal(decoder.append(bytes.subarray(i, Math.min(i + 8192, bytes.length - 1))), null);
      assert.ok(decoder.bufferedBytes <= max + 4);
    }
    assert.equal(decoder.append(bytes.subarray(-1)).frame.payload.length, payload.length);
    assert.throws(() => raw(Buffer.alloc(payload.length + 1, 0x7b), direction === "response"));
  }
});

test("same-batch tail is counted, never buffered or parsed as a second frame", () => {
  const bytes = raw("{}");
  for (const tail of [Buffer.from([0]), bytes.subarray(0, 3), bytes, Buffer.alloc(2 * frame.LIMITS.requestBytes)]) {
    const decoder = new frame.FrameDecoder(options("request"));
    const result = decoder.append(Buffer.concat([bytes, tail]));
    assert.deepEqual(result.bytes, bytes); assert.equal(result.trailingBytes, tail.length);
    assert.equal(decoder.bufferedBytes, 0);
    assert.throws(() => frame.decodeFrame(Buffer.concat([bytes, tail]), options("request")));
  }
});

test("no v1 fallback, incorrect direction, operation, status and correlation fail early", () => {
  for (const version of [0, 1, 3, 255]) {
    const bytes = raw("{}"); bytes[4] = version;
    const decoder = new frame.FrameDecoder(options("request"));
    assert.throws(() => decoder.append(bytes.subarray(0, 5)), { code: "ERR_WITNESS_FRAME_PROTOCOL" });
  }
  assert.throws(() => v1.decodeFrame(raw("{}"), options("request")));
  assert.throws(() => frame.encodeFrame({ version: 1 }));
  for (const position of [5, 6, 22]) {
    const bytes = raw("{}", true); bytes[position] = 255;
    assert.throws(() => frame.decodeFrame(bytes, options("response")));
  }
  assert.throws(() => frame.decodeFrame(raw("{}"), options("response")));
  assert.throws(() => frame.decodeFrame(raw("{}", true), options("request")));
  assert.throws(() => new frame.FrameDecoder({ direction: "response" }));
});

test("all prefix/body truncations are terminal and cannot manufacture a completed frame", () => {
  for (const response of [false, true]) {
    const bytes = raw("{}", response);
    for (let cut = 0; cut < bytes.length; cut++) {
      const decoder = new frame.FrameDecoder(options(response ? "response" : "request"));
      assert.equal(decoder.append(bytes.subarray(0, cut)), null);
      assert.throws(() => decoder.finish(), { code: "ERR_WITNESS_FRAME_TRUNCATED" });
      assert.equal(decoder.bufferedBytes, 0);
      assert.throws(() => decoder.append(bytes.subarray(cut)), { code: "ERR_WITNESS_FRAME_CLOSED" });
    }
  }
});
