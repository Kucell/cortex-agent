"use strict";

// Offline v2 candidate. No TLS reader, identity, store, retry or enablement.
// v1 is used only as a private syntax validator of a detached complete frame;
// it is never negotiated or accepted on this candidate's wire.
const syntax = require("./permit-witness-frame");
const { LIMITS, HEADER_BYTES, OPERATIONS, RESPONSE_STATUSES, PermitWitnessFrameError } = syntax;
const VERSION = 2;
function fail(code) { throw new PermitWitnessFrameError(code); }

function encodeFrame(input) {
  if (!input || (input.version !== undefined && input.version !== VERSION)) fail("ERR_WITNESS_FRAME_PROTOCOL");
  const bytes = syntax.encodeFrame({ ...input, version: syntax.VERSION });
  bytes[4] = VERSION;
  return bytes;
}

// append returns at most one complete frame immediately, without EOF. It also
// reports ALL bytes outside that frame in this delivered batch, without copying
// or retaining them. The exchange owner decides the asymmetric request/response
// trailing policy. A completed/failed decoder is terminal, never a second reader.
class FrameDecoder {
  #options;
  #buffer = Buffer.alloc(4);
  #used = 0;
  #sized = false;
  #closed = false;
  constructor(options) {
    // Reuse the exact direction/correlation option validation, not its EOF rule.
    new syntax.FrameDecoder(options);
    this.#options = { ...options };
  }
  get bufferedBytes() { return this.#buffer ? this.#buffer.length : 0; }
  append(bytes) {
    if (this.#closed) fail("ERR_WITNESS_FRAME_CLOSED");
    try {
      if (!Buffer.isBuffer(bytes)) fail("ERR_WITNESS_FRAME_INPUT");
      let offset = 0;
      if (!this.#sized) {
        offset = bytes.copy(this.#buffer, this.#used, 0, 4 - this.#used);
        this.#used += offset;
        if (this.#used < 4) return null;
        const length = this.#buffer.readUInt32BE(0), response = this.#options.direction === "response";
        if (length < 19 + Number(response) || length > (response ? LIMITS.responseLength : LIMITS.requestLength)) {
          fail("ERR_WITNESS_FRAME_SIZE");
        }
        const buffer = Buffer.alloc(length + 4);
        this.#buffer.copy(buffer); this.#buffer = buffer; this.#sized = true;
      }
      const count = Math.min(bytes.length - offset, this.#buffer.length - this.#used);
      this.#used += bytes.copy(this.#buffer, this.#used, offset, offset + count);
      offset += count;
      if (this.#used >= 5 && this.#buffer[4] !== VERSION) fail("ERR_WITNESS_FRAME_PROTOCOL");
      if (this.#used >= 6 && !Object.values(OPERATIONS).includes(this.#buffer[5])) fail("ERR_WITNESS_FRAME_PROTOCOL");
      if (this.#options.direction === "response") {
        if (this.#used >= 6 && this.#buffer[5] !== this.#options.expectedOperation) fail("ERR_WITNESS_FRAME_MISMATCH");
        if (this.#used >= HEADER_BYTES && this.#buffer.subarray(6, HEADER_BYTES).toString("hex") !==
            this.#options.expectedRequestId.replace(/-/g, "").toLowerCase()) fail("ERR_WITNESS_FRAME_MISMATCH");
        if (this.#used > HEADER_BYTES && !RESPONSE_STATUSES.includes(this.#buffer[HEADER_BYTES])) fail("ERR_WITNESS_FRAME_PROTOCOL");
      } else if (this.#used > HEADER_BYTES && this.#buffer[HEADER_BYTES] !== 0x7b) fail("ERR_WITNESS_FRAME_PROTOCOL");
      if (this.#used !== this.#buffer.length) return null;
      const encoded = this.#buffer, copy = Buffer.from(encoded);
      copy[4] = syntax.VERSION;
      const frame = syntax.decodeFrame(copy, this.#options);
      frame.version = VERSION;
      this.dispose();
      return { frame, bytes: encoded, trailingBytes: bytes.length - offset };
    } catch (error) { this.dispose(); throw error; }
  }
  finish() {
    if (this.#closed) fail("ERR_WITNESS_FRAME_CLOSED");
    this.dispose();
    fail("ERR_WITNESS_FRAME_TRUNCATED");
  }
  dispose() { this.#closed = true; this.#buffer = null; }
}

function decodeFrame(bytes, options) {
  const decoder = new FrameDecoder(options), complete = decoder.append(bytes);
  if (!complete) return decoder.finish();
  if (complete.trailingBytes) fail("ERR_WITNESS_FRAME_PROTOCOL");
  return complete.frame;
}

module.exports = { VERSION, HEADER_BYTES, LIMITS, OPERATIONS, RESPONSE_STATUSES,
  PermitWitnessFrameError, encodeFrame, decodeFrame, FrameDecoder };
