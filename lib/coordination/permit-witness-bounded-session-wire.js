"use strict";

// Development binary protocol. A MAC proves possession of a synthetic session
// key, NOT OS identity, honest observations, sandboxing or execution authority.
const crypto = require("node:crypto");
const HEADER = 62, TAG = 32, OVERHEAD = 4 + HEADER + TAG;
// Local capacity policy only; the authenticated wire version/layout stays 1.
// A complete maximum v2 application frame (1 MiB + 23) is one session payload.
const CAPACITY_PROFILES = Object.freeze({
  default: Object.freeze({ maxPayloadBytes: 65536, payloadBytes: 4096, maxFrames: 16 }),
  v2: Object.freeze({ maxPayloadBytes: 1048599, payloadBytes: 1048599, maxFrames: 6 }),
});
const TYPES = Object.freeze({ HELLO: 1, HELLO_ACK: 2, REQUEST: 3, RESPONSE: 4, CLOSE: 5, CLOSE_ACK: 6 });
const zero = Buffer.alloc(32);
function failure(code) { const e = new Error(code); e.code = "ERR_BOUNDED_SESSION_" + code; return e; }
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest(); }
function encode(key, session, { direction, type, seq, requestId = 0, operation = 0, binding = zero, payload = Buffer.alloc(0) }) {
  const frame = Buffer.alloc(OVERHEAD + payload.length);
  frame.writeUInt32BE(frame.length - 4, 0);
  frame[4] = 1; frame[5] = direction; frame[6] = type;
  frame.writeUInt32BE(seq, 8); frame.writeUInt32BE(requestId, 12); frame.writeUInt16BE(operation, 16);
  session.copy(frame, 18); binding.copy(frame, 34); payload.copy(frame, 66);
  crypto.createHmac("sha256", key).update(frame.subarray(0, -TAG)).digest().copy(frame, frame.length - TAG);
  return frame;
}
function decode(key, session, frame, direction, seq) {
  const signed = frame.subarray(0, -TAG);
  const expected = crypto.createHmac("sha256", key).update(signed).digest();
  if (!crypto.timingSafeEqual(expected, frame.subarray(-TAG))) throw failure("MAC");
  if (frame[4] !== 1 || frame[7] !== 0 || frame[5] !== direction || !frame.subarray(18, 34).equals(session)) throw failure("DOMAIN");
  if (frame.readUInt32BE(8) !== seq) throw failure("SEQUENCE");
  return { type: frame[6], seq, requestId: frame.readUInt32BE(12), operation: frame.readUInt16BE(16),
    binding: frame.subarray(34, 66), payload: frame.subarray(66, -TAG), digest: digest(frame) };
}
module.exports = { HEADER, TAG, OVERHEAD, CAPACITY_PROFILES, TYPES, zero, failure, digest, encode, decode };
