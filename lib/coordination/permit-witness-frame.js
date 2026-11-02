"use strict";

// OFFLINE FRAMING CANDIDATE ONLY. No I/O, JSON/business schema, authentication,
// persistence, retry, permit consumption or execution authorization. Importing
// this module cannot enable either native helper or a production witness.
// Wire: u32be(length excluding itself), version:u8, operation:u8, UUID:16,
// payload. A response adds status:u8 BEFORE its opaque payload. The status
// values below are syntax only; they do not establish commit/authorization facts.
// Requests must start with '{' (0x7b), the first byte of a canonical JSON object;
// responses start with status 0..3. These disjoint prefixes prevent reflection.
// Only this discriminator is checked, NOT JSON validity/canonicality/schema.
// Direction is supplied out of band; neither prefix authenticates the sender.
const VERSION = 1;
const HEADER_BYTES = 22;
const BODY_OVERHEAD = HEADER_BYTES - 4;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const LIMITS = Object.freeze({
  payloadBytes: MAX_PAYLOAD_BYTES,
  requestLength: BODY_OVERHEAD + MAX_PAYLOAD_BYTES,
  responseLength: BODY_OVERHEAD + 1 + MAX_PAYLOAD_BYTES,
  requestBytes: HEADER_BYTES + MAX_PAYLOAD_BYTES,
  responseBytes: HEADER_BYTES + 1 + MAX_PAYLOAD_BYTES,
});
const OPERATIONS = Object.freeze({ checkpoint: 1, transition: 2 });
const RESPONSE_STATUSES = Object.freeze([0, 1, 2, 3]);

class PermitWitnessFrameError extends Error {
  constructor(code) { super(code); this.name = "PermitWitnessFrameError"; this.code = code; }
}
function fail(code = "ERR_WITNESS_FRAME_INPUT") { throw new PermitWitnessFrameError(code); }
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
}
function direction(value) {
  if (value !== "request" && value !== "response") fail();
  return value;
}
function operation(value) {
  if (value !== OPERATIONS.checkpoint && value !== OPERATIONS.transition) fail();
  return value;
}
function uuid(value) {
  if (typeof value !== "string" || value.length !== 36 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) fail();
  return value.toLowerCase();
}
function uuidText(bytes) {
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

// payload is always the opaque data, WITHOUT the response status byte. Both
// directions permit 1..1 MiB data bytes. UUID bytes follow text hex order, never
// Windows Guid's default mixed-endian memory representation. No UUID version or
// variant is assumed, and the UUID is not an idempotency or identity proof.
function encodeFrame(frame) {
  object(frame);
  const response = direction(frame.direction) === "response";
  if (frame.version !== undefined && frame.version !== VERSION) fail();
  operation(frame.operation);
  const requestId = uuid(frame.requestId);
  if (!Buffer.isBuffer(frame.payload)) fail();
  if (frame.payload.length < 1 || frame.payload.length > MAX_PAYLOAD_BYTES) fail("ERR_WITNESS_FRAME_SIZE");
  if (!response && frame.payload[0] !== 0x7b) fail("ERR_WITNESS_FRAME_PROTOCOL");
  if (response ? !RESPONSE_STATUSES.includes(frame.status) : Object.hasOwn(frame, "status")) fail();
  const wire = Buffer.alloc(HEADER_BYTES + Number(response) + frame.payload.length);
  wire.writeUInt32BE(wire.length - 4, 0);
  wire[4] = VERSION;
  wire[5] = frame.operation;
  Buffer.from(requestId.replace(/-/g, ""), "hex").copy(wire, 6);
  if (response) wire[HEADER_BYTES] = frame.status;
  frame.payload.copy(wire, HEADER_BYTES + Number(response));
  return wire;
}

// One frame per directional stream. append() NEVER releases a frame: only
// finish(), called on a clean EOF by the future transport owner, can return it.
// A reset/TLS error/timeout must discard the decoder, not be treated as EOF.
// Length is checked after four bytes and BEFORE frame-sized allocation. The
// raw buffer is bounded by the directional wire limit, independent of chunking.
// Every failure is terminal; partial data must never be reused or retried.
class FrameDecoder {
  #direction;
  #expectedOperation;
  #expectedRequestId;
  #buffer = Buffer.alloc(4);
  #used = 0;
  #sized = false;
  #closed = false;

  constructor(options) {
    object(options);
    this.#direction = direction(options.direction);
    if (this.#direction === "response") {
      // Mandatory correlation, even for a syntactically valid error response.
      this.#expectedOperation = operation(options.expectedOperation);
      this.#expectedRequestId = uuid(options.expectedRequestId);
    } else if (options.expectedOperation !== undefined || options.expectedRequestId !== undefined) fail();
  }

  append(bytes) {
    if (this.#closed) fail("ERR_WITNESS_FRAME_CLOSED");
    try {
      if (!Buffer.isBuffer(bytes)) fail();
      let offset = 0;
      if (!this.#sized) {
        offset = bytes.copy(this.#buffer, this.#used, 0, 4 - this.#used);
        this.#used += offset;
        if (this.#used < 4) return;
        const length = this.#buffer.readUInt32BE(0);
        const response = this.#direction === "response";
        const maximum = response ? LIMITS.responseLength : LIMITS.requestLength;
        if (length < BODY_OVERHEAD + 1 + Number(response) || length > maximum) fail("ERR_WITNESS_FRAME_SIZE");
        if (bytes.length - offset > length) fail("ERR_WITNESS_FRAME_PROTOCOL");
        const buffer = Buffer.alloc(length + 4);
        this.#buffer.copy(buffer);
        this.#buffer = buffer;
        this.#sized = true;
      }
      if (bytes.length - offset > this.#buffer.length - this.#used) fail("ERR_WITNESS_FRAME_PROTOCOL");
      this.#used += bytes.copy(this.#buffer, this.#used, offset);
      if (this.#used >= 5 && this.#buffer[4] !== VERSION) fail("ERR_WITNESS_FRAME_PROTOCOL");
      if (this.#used >= 6 && !Object.values(OPERATIONS).includes(this.#buffer[5])) fail("ERR_WITNESS_FRAME_PROTOCOL");
      if (this.#direction === "response") {
        if (this.#used >= 6 && this.#buffer[5] !== this.#expectedOperation) fail("ERR_WITNESS_FRAME_MISMATCH");
        if (this.#used >= HEADER_BYTES && uuidText(this.#buffer.subarray(6, HEADER_BYTES)) !== this.#expectedRequestId) {
          fail("ERR_WITNESS_FRAME_MISMATCH");
        }
        if (this.#used > HEADER_BYTES && !RESPONSE_STATUSES.includes(this.#buffer[HEADER_BYTES])) fail("ERR_WITNESS_FRAME_PROTOCOL");
      } else if (this.#used > HEADER_BYTES && this.#buffer[HEADER_BYTES] !== 0x7b) fail("ERR_WITNESS_FRAME_PROTOCOL");
    } catch (error) {
      this.#closed = true;
      this.#buffer = null;
      throw error;
    }
  }

  finish() {
    if (this.#closed) fail("ERR_WITNESS_FRAME_CLOSED");
    this.#closed = true;
    const buffer = this.#buffer;
    this.#buffer = null;
    if (!this.#sized || this.#used !== buffer.length) fail("ERR_WITNESS_FRAME_TRUNCATED");
    const response = this.#direction === "response";
    return {
      direction: this.#direction, version: VERSION, operation: buffer[5],
      requestId: uuidText(buffer.subarray(6, HEADER_BYTES)),
      ...(response ? { status: buffer[HEADER_BYTES] } : {}),
      payload: Buffer.from(buffer.subarray(HEADER_BYTES + Number(response))),
    };
  }
}

// For an already complete, EOF-delimited byte sequence; not a stream read API.
function decodeFrame(bytes, options) {
  const decoder = new FrameDecoder(options);
  decoder.append(bytes);
  return decoder.finish();
}

module.exports = { VERSION, HEADER_BYTES, LIMITS, OPERATIONS, RESPONSE_STATUSES,
  PermitWitnessFrameError, encodeFrame, FrameDecoder, decodeFrame };
