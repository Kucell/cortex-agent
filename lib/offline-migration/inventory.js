"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function fail(code) { const e = new Error(code); e.code = code; throw e; }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const dirFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
// Node has no portable openat API. Linux proc-fd paths anchor each lookup to
// an already opened directory. Never fall back to an absolute path traversal.
function inventory(project) {
  if (process.platform !== "linux") fail("MIGRATION_SAFE_READER_UNSUPPORTED");
  const root = path.resolve(project), handles = [], entries = [], content = new Map(); let bytes = 0;
  function openDirectory(name) { const fd = fs.openSync(name, dirFlags); handles.push(fd); return fd; }
  function visit(parent, name, rel) {
    if (entries.length >= 20000) fail("MIGRATION_INVENTORY_LIMIT");
    const anchored = `/proc/self/fd/${parent}/${name}`, before = fs.lstatSync(anchored);
    if (before.isSymbolicLink() || (!before.isDirectory() && (!before.isFile() || before.nlink !== 1))) fail("MIGRATION_UNSAFE_PATH");
    const fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (before.isDirectory() ? fs.constants.O_DIRECTORY : 0));
    try {
      if (!same(before, fs.fstatSync(fd))) fail("MIGRATION_SOURCE_CHANGED");
      const row = { path: rel, type: before.isDirectory() ? "directory" : "file", mode: before.mode & 0o7777, size: before.size, dev: before.dev, ino: before.ino };
      entries.push(row);
      if (before.isDirectory()) {
        for (const child of fs.readdirSync(`/proc/self/fd/${fd}`).sort()) visit(fd, child, rel + "/" + child);
      } else {
        bytes += before.size;
        if (before.size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024) fail("MIGRATION_INVENTORY_LIMIT");
        const chunks = []; let count = 0;
        while (count <= before.size) {
          const buffer = Buffer.alloc(Math.min(65536, before.size + 1 - count));
          const n = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!n) break;
          count += n;
          if (count > before.size) fail("MIGRATION_SOURCE_CHANGED");
          chunks.push(buffer.subarray(0, n));
        }
        const data = Buffer.concat(chunks); row.sha256 = hash(data); content.set(rel, data);
      }
      if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(anchored))) fail("MIGRATION_SOURCE_CHANGED");
    } finally { fs.closeSync(fd); }
  }
  try {
    let fd = openDirectory("/");
    for (const part of root.split("/").filter(Boolean)) fd = openDirectory(`/proc/self/fd/${fd}/${part}`);
    visit(fd, ".agent", ".agent");
    return { root, entries, content, digest: hash(JSON.stringify(entries)) };
  } finally { for (const fd of handles.reverse()) fs.closeSync(fd); }
}
module.exports = { inventory, hash, fail };
