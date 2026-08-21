"use strict";

// ─── zip — minimal zero-dependency STORE zip (no compression) ────────────────
//
// Builds a .zip archive using only Node built-ins. Entries are stored
// uncompressed (method 0). Deterministic: same inputs → same bytes
// (uses fixed DOS timestamps for reproducibility).
//
// Layout per entry:
//   local file header + data
//   central directory
//   end of central directory record
//
// CRC-32 is computed with a small table. All integers are little-endian.

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime() {
  // Fixed date 2026-01-01 00:00:00 for deterministic output.
  const year = 2026;
  const month = 1; // 1-12
  const day = 1;
  const hour = 0;
  const minute = 0;
  const second = 0;
  const date = ((year - 1980) << 9) | (month << 5) | day;
  const time = (hour << 11) | (minute << 5) | (second >>> 1);
  return { date, time };
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value & 0xffff, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

// Build a zip buffer from { filename, data(Buffer|string) }[].
function buildZip(entries) {
  const normalized = entries.map((e) => ({
    name: String(e.filename || "entry.txt"),
    data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? "" : e.data), "utf8"),
  }));

  const parts = [];
  const central = [];
  let offset = 0;
  const { date, time } = dosDateTime();

  for (const entry of normalized) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.concat([
      u32(0x04034b50),           // local file header signature
      u16(20),                   // version needed
      u16(0),                    // general purpose bit flag
      u16(0),                    // compression method: STORE
      u16(time),
      u16(date),
      u32(crc),
      u32(entry.data.length),    // compressed size
      u32(entry.data.length),    // uncompressed size
      u16(nameBuf.length),
      u16(0),                    // extra field length
      nameBuf,
      entry.data,
    ]);
    parts.push(local);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),           // central directory signature
      u16(20),                   // version made by
      u16(20),                   // version needed
      u16(0),                    // flag
      u16(0),                    // method
      u16(time),
      u16(date),
      u32(crc),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(nameBuf.length),
      u16(0),                    // extra length
      u16(0),                    // comment length
      u16(0),                    // disk number
      u16(0),                    // internal attrs
      u32(0),                    // external attrs
      u32(offset),               // local header offset
      nameBuf,
    ]);
    central.push(centralHeader);
    offset += local.length;
  }

  const centralStart = offset;
  const centralBuffer = Buffer.concat(central);
  const centralSize = centralBuffer.length;

  const end = Buffer.concat([
    u32(0x06054b50),             // end of central directory signature
    u16(0),                      // disk number
    u16(0),                      // disk with central dir
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(centralStart),
    u16(0),                      // comment length
  ]);

  return Buffer.concat([...parts, centralBuffer, end]);
}

// Convenience: build a zip from an object of { filename: content }.
function buildZipFromObject(files) {
  const entries = Object.keys(files).map((name) => ({
    filename: name,
    data: files[name],
  }));
  return buildZip(entries);
}

module.exports = {
  buildZip,
  buildZipFromObject,
  crc32,
};
