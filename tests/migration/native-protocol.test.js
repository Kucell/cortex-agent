"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { decoder } = require("../../lib/offline-migration/native/protocol");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function encode(rows) {
  const digest = crypto.createHash("sha256");
  return Buffer.concat(rows.map((r, i) => {
    const row = { ...r, seq: i }; if (row.type === "end") row.digest = digest.digest("hex");
    const body = Buffer.from(JSON.stringify(row)); if (row.type !== "end") digest.update(body);
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]);
  }));
}
function rows() { return [
  { type: "header", protocol: 1 },
  { type: "entry", entry: { path: ".agent", type: "directory", mode: 448, size: 64, dev: 1, ino: 2 } },
  { type: "entry", entry: { path: ".agent/data", type: "file", mode: 384, size: 3, dev: 1, ino: 3, sha256: sha("abc") } },
  { type: "chunk", path: ".agent/data", offset: 0, data: "YWJj" },
  { type: "end", entries: 2, bytes: 3 },
]; }
function decode(data) { const d = decoder("/project"); d.write(data); return d.finish(); }
test("complete native stream reconstructs independently hashed inventory, split frames", () => {
  const d = decoder("/project"), bytes = encode(rows());
  for (const b of bytes) d.write(Buffer.from([b]));
  const result = d.finish(); assert.equal(result.content.get(".agent/data").toString(), "abc");
  assert.equal(result.digest, sha(JSON.stringify(result.entries)));
});
for (const [name, mutate] of [
  ["missing header", r => r.shift()], ["missing end", r => r.pop()],
  ["bad path", r => r[2].entry.path = ".agent/../secret"],
  ["unsafe identity number", r => r[2].entry.ino = Number.MAX_SAFE_INTEGER + 1],
  ["missing parent", r => r[2].entry.path = ".agent/missing/data"],
  ["bad data digest", r => r[2].entry.sha256 = "0".repeat(64)],
  ["wrong offset", r => r[3].offset = 1], ["missing data", r => r.splice(3, 1)],
  ["noncanonical base64", r => r[3].data = "YWJj\n"],
  ["extra fields", r => r[1].entry.extra = true],
  ["bad count", r => r[4].entries = 3], ["bad byte count", r => r[4].bytes = 4],
]) test(`reject ${name}`, () => { const r = rows(); mutate(r); assert.throws(() => decode(encode(r))); });
test("reject truncation and trailing garbage", () => {
  const b = encode(rows()); assert.throws(() => decode(b.subarray(0, -1)));
  assert.throws(() => decode(Buffer.concat([b, Buffer.from([0])])));
  assert.throws(() => decode(Buffer.concat([b, b])));
});
test("reject oversized frame before buffering body", () => {
  const b = Buffer.alloc(4); b.writeUInt32BE(1048577); assert.throws(() => decode(b));
});
