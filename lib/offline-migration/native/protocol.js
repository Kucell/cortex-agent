"use strict";
const crypto = require("node:crypto");
const { parse } = require("../json");
const MAX_FRAME = 1024 * 1024, MAX_OUTPUT = 96 * 1024 * 1024;
function fail() { throw Object.assign(new Error("MIGRATION_NATIVE_PROTOCOL_INVALID"), { code: "MIGRATION_NATIVE_PROTOCOL_INVALID" }); }
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",")) fail();
}
function safePath(p) {
  if (typeof p !== "string" || Buffer.byteLength(p) > 4096 || p.includes("\0") || p.includes("\\") || !/^\.agent(?:\/|$)/.test(p) || p.split("/").some(x => !x || x === "." || x === "..")) fail();
}
// A successful process exit is insufficient: authenticate the entire bounded
// stream, its complete files and terminal record before returning any inventory.
function decoder(root) {
  const digest = crypto.createHash("sha256"), entries = [], content = new Map(), paths = new Set();
  let pending = Buffer.alloc(0), output = 0, sequence = 0, ended = false, bytes = 0, current = null;
  function finishFile() {
    if (!current) return;
    const data = Buffer.concat(current.chunks);
    if (data.length !== current.row.size || sha(data) !== current.row.sha256) fail();
    content.set(current.row.path, data); current = null;
  }
  function frame(raw) {
    if (ended) fail();
    let row;
    try { row = parse(raw.toString("utf8")); } catch { fail(); }
    if (!Buffer.from(raw.toString("utf8")).equals(raw)) fail();
    if (row.seq !== sequence++) fail();
    if (row.type === "end") {
      exact(row, ["type", "seq", "entries", "bytes", "digest"]);
      finishFile();
      if (row.entries !== entries.length || row.bytes !== bytes || row.digest !== digest.digest("hex")) fail();
      ended = true; return;
    }
    digest.update(raw);
    if (row.type === "header") {
      exact(row, ["type", "seq", "protocol"]);
      if (row.seq !== 0 || row.protocol !== 1) fail();
    } else if (row.type === "entry") {
      if (row.seq === 0) fail();
      exact(row, ["type", "seq", "entry"]); finishFile();
      const r = row.entry;
      exact(r, r.type === "file" ? ["path", "type", "mode", "size", "dev", "ino", "sha256"] : ["path", "type", "mode", "size", "dev", "ino"]);
      safePath(r.path);
      if (!["file", "directory"].includes(r.type) || entries.length >= 20000 || paths.has(r.path)) fail();
      if (entries.length === 0 && (r.path !== ".agent" || r.type !== "directory")) fail();
      if (r.path !== ".agent" && !entries.some(e => e.path === r.path.slice(0, r.path.lastIndexOf("/")) && e.type === "directory")) fail();
      for (const key of ["mode", "size", "dev", "ino"]) if (!Number.isSafeInteger(r[key]) || r[key] < 0) fail();
      if (r.mode > 0o7777) fail();
      // Preserve the exact Linux inventory key order used for plan identity.
      const entry = { path: r.path, type: r.type, mode: r.mode, size: r.size, dev: r.dev, ino: r.ino };
      if (r.type === "file") {
        if (r.size > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(r.sha256)) fail();
        bytes += r.size; if (bytes > 64 * 1024 * 1024) fail();
        entry.sha256 = r.sha256; current = { row: entry, chunks: [], received: 0 };
      }
      paths.add(r.path); entries.push(entry);
    } else if (row.type === "chunk") {
      exact(row, ["type", "seq", "path", "offset", "data"]);
      if (!current || row.path !== current.row.path || row.offset !== current.received || typeof row.data !== "string") fail();
      const data = Buffer.from(row.data, "base64");
      if (data.toString("base64") !== row.data || data.length === 0 || data.length > 65536) fail();
      current.received += data.length;
      if (current.received > current.row.size) fail();
      current.chunks.push(data);
    } else fail();
  }
  return {
    write(data) {
      if (!Buffer.isBuffer(data)) fail();
      output += data.length; if (output > MAX_OUTPUT || ended && data.length) fail();
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4) {
        const n = pending.readUInt32BE(0); if (n === 0 || n > MAX_FRAME) fail();
        if (pending.length < 4 + n) break;
        frame(pending.subarray(4, 4 + n)); pending = pending.subarray(4 + n);
      }
    },
    finish() {
      if (!ended || pending.length || entries.length === 0) fail();
      return { root, entries, content, digest: sha(JSON.stringify(entries)) };
    },
  };
}
module.exports = { decoder, MAX_FRAME, MAX_OUTPUT };
