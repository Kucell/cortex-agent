"use strict";

// Offline, explicitly v2 outer framing / format 1 payload. No store migration,
// identity assertion, dispatch, recovery or production entry point. The private
// adapter preserves ORIGINAL payload bytes for all existing wire checks (fatal
// UTF-8, canonical JSON, limits, exact schemas, signatures and action binding).
// This is not a fallback: validate v2 first, never try v1 after an error.
const wire = require("./permit-witness-wire");
const frame = require("./permit-witness-v2-frame");

function payloadValidationCopy(bytes, options) {
  frame.decodeFrame(bytes, options);
  const copy = Buffer.from(bytes);
  copy[4] = 1;
  return copy;
}
function v2(bytes) { bytes[4] = frame.VERSION; return bytes; }
function encodeRequest(input) { return v2(wire.encodeRequest(input)); }
function decodeRequest(bytes) {
  return wire.decodeRequest(payloadValidationCopy(bytes, { direction: "request" }));
}
function toHostRequest(bytes) {
  return wire.toHostRequest(payloadValidationCopy(bytes, { direction: "request" }));
}
function encodeResponse(requestBytes, outcome) {
  return v2(wire.encodeResponse(payloadValidationCopy(requestBytes, { direction: "request" }), outcome));
}
function decodeResponse(bytes, requestBytes) {
  const request = decodeRequest(requestBytes);
  return wire.decodeResponse(payloadValidationCopy(bytes, { direction: "response",
    expectedOperation: request.operation, expectedRequestId: request.requestId }),
  payloadValidationCopy(requestBytes, { direction: "request" }));
}

module.exports = { STATUS: wire.STATUS, PermitWitnessWireError: wire.PermitWitnessWireError,
  encodeRequest, decodeRequest, toHostRequest, encodeResponse, decodeResponse };
