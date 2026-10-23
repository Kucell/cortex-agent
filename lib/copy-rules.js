"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ─── Copy hygiene rules (one source of truth) ────────────────────────────────
//
// A distributable template tree carries neither OS junk nor symlinks.
//
// `.DS_Store` is macOS litter: it appears in any folder a developer visits in
// Finder, and a source checkout carries it into every project it installs.
//
// Symlinks do not survive packaging — `npm pack` drops them — so a template
// that ships one behaves differently depending on how it was installed. A
// symlink pointing outside the tree (a developer's own `~/.agent/skills`) is
// machine-specific: copying it puts that machine's content into the project.
//
// The two installs must therefore produce the same project: "installed from
// npm" and "copied from a checkout" must not differ by a junk file or by a
// directory that only exists on the developer's machine.
//
// Every copy path (init / upgrade / update / scaffold / state-sync) uses these
// rules — restating them per path is how one path ends up shipping junk the
// others filter out.

const JUNK_ENTRIES = new Set([".DS_Store"]);

function isJunkEntry(name) {
  return JUNK_ENTRIES.has(String(name || ""));
}

// lstat, never stat: stat follows symlinks, and following one is exactly how
// a machine-specific path accident becomes a directory in the project.
function statEntry(entryPath) {
  try {
    return fs.lstatSync(entryPath);
  } catch (_) {
    return null;
  }
}

function isSymlink(stat) {
  return Boolean(stat && stat.isSymbolicLink());
}

// The entry names a copy path must skip, or null when the entry is
// copyable. Callers still apply their own rules (e.g. "never overwrite").
function skipReason(entryPath, name) {
  if (isJunkEntry(name)) return "junk";
  if (isSymlink(statEntry(entryPath))) return "symlink";
  return null;
}

module.exports = {
  JUNK_ENTRIES,
  isJunkEntry,
  statEntry,
  isSymlink,
  skipReason,
};
