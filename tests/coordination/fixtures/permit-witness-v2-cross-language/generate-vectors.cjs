"use strict";

// Fixture maintenance only. Independent layout oracle: DO NOT import a codec.
// Regeneration is explicit; the test reads the fixed JSON without rewriting it.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const id = "00112233-4455-6677-8899-aabbccddeeff";
function wire(direction, operation, payload, status = 0) {
  const body = Buffer.concat([Buffer.from([2, operation]), Buffer.from(id.replaceAll("-", ""), "hex"),
    direction === "response" ? Buffer.from([status]) : Buffer.alloc(0), payload]);
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
function vector(name, direction, operation, payload, status, recipe) {
  const bytes = wire(direction, operation, payload, status);
  return { name, direction, operation, request_id: id, ...(direction === "response" ? { status } : {}),
    ...(recipe || { payload_hex: payload.toString("hex") }), payload_bytes: payload.length,
    payload_sha256: sha(payload), wire_bytes: bytes.length, length: bytes.length - 4,
    header_hex: bytes.subarray(0, 22).toString("hex"), wire_sha256: sha(bytes),
    ...(!recipe ? { wire_hex: bytes.toString("hex") } : {}) };
}
const positive = [
  vector("checkpoint-empty-object", "request", 1, Buffer.from("{}")),
  vector("transition-minimum", "request", 2, Buffer.from("{")),
  vector("opaque-not-json", "request", 2, Buffer.from("7b00ff80", "hex")),
  vector("unicode-exact-bytes", "request", 2, Buffer.from('{"text":"中文😀é e\u0301"}')),
  ...[0, 1, 2, 3].map(status => vector(`response-status-${status}`, "response", 2,
    Buffer.from("7b00ff80", "hex"), status)),
  vector("checkpoint-response-minimum", "response", 1, Buffer.from([0xff]), 0),
];
const boundary = ["request", "response"].map(direction => {
  const payload = Buffer.alloc(1048576, 0xa5); if (direction === "request") payload[0] = 0x7b;
  return vector(`${direction}-maximum`, direction, 2, payload, 0,
    { payload_repeat_hex: "a5", payload_prefix_hex: direction === "request" ? "7b" : "" });
});
const negative = [];
function bad(name, direction, bytes, error) {
  negative.push({ name, direction, wire_hex: bytes.toString("hex"), expected: error });
}
for (const direction of ["request", "response"]) {
  const good = wire(direction, 2, Buffer.from("{}"));
  for (const length of [0, 18, ...(direction === "response" ? [19] : []),
    1048576 + (direction === "request" ? 19 : 20), 0xffffffff]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(length);
    bad(`${direction}-length-${length}`, direction, prefix, "size");
  }
  for (let cut = 0; cut < good.length; cut++) bad(`${direction}-truncated-${cut}`, direction, good.subarray(0, cut), "truncated");
  for (const version of [0, 1, 3, 255]) {
    const bytes = Buffer.from(good); bytes[4] = version;
    bad(`${direction}-version-${version}`, direction, bytes, "protocol");
  }
  for (const operation of [0, 3, 255]) {
    const bytes = Buffer.from(good); bytes[5] = operation;
    bad(`${direction}-operation-${operation}`, direction, bytes, "protocol");
  }
  if (direction === "response") for (const status of [4, 255]) {
    const bytes = Buffer.from(good); bytes[22] = status;
    bad(`response-status-${status}`, direction, bytes, "protocol");
  }
}
const trailing = ["request", "response"].flatMap(direction => {
  const base = wire(direction, 2, Buffer.from("{}"));
  return [Buffer.from([0]), base.subarray(0, 3), base].map((tail, index) => ({
    name: `${direction}-${["byte", "partial-second-prefix", "second-frame"][index]}`,
    direction, wire_hex: Buffer.concat([base, tail]).toString("hex"),
    first_wire_hex: base.toString("hex"), first_wire_bytes: base.length, trailing_bytes: tail.length,
  }));
});
fs.writeFileSync(path.join(__dirname, "vectors.json"), JSON.stringify({
  format: "permit-witness-offline-frame-v2-fixed-vectors-1",
  scope: "Opaque framing only. No payload policy, correlation policy in native codecs, TLS, identity, dispatch, commit or execution acceptance.",
  layout: "u32be length excluding prefix | version:u8=2 | operation:u8=1/2 | text-order UUID:16 | response status:u8=0..3 if response | nonempty payload <= 1048576",
  completion: "One complete frame is delivered without EOF; decoder reports same-batch tail. Exchange owns asymmetric request/response arbitration; no acceptance claim for trailing data.",
  response_correlation: { expected_operation: 2, expected_request_id: id }, positive, boundary, negative, trailing,
}, null, 2) + "\n");
