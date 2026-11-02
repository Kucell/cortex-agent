"use strict";

// Read-only declaration observation, NOT admission, authentication or migration.
// Node has no portable openat2. Held directory descriptors + metadata checks
// detect observed changes only: same-UID replacement/ABA, hostile mounts and
// whole-machine rollback are NOT excluded. Every result remains unproven.
// Synchronous, bounded local-file IO; callers must not use this as an async
// event-loop watcher. No DB, binding expansion, HOME discovery or user hooks.
const fs = require("node:fs");
const path = require("node:path");
const { resolveLayout } = require("../runtime-layout/resolver");
const { resolveGovernanceRoot } = require("../governance/root");
const { LIMITS, PermitStoreDeclarationError, parsePermitStoreDeclaration } = require("./permit-store-declaration");

class PermitStoreDeclarationLoadError extends Error {
  constructor(code) { super(code); this.name = "PermitStoreDeclarationLoadError"; this.code = code; }
}
function fail(code) { throw new PermitStoreDeclarationLoadError(code); }
function sanitized(error) {
  if (error instanceof PermitStoreDeclarationLoadError || error instanceof PermitStoreDeclarationError) return error;
  // Native errors can contain paths. Never attach the original error/cause,
  // arbitrary properties, invalid JSON, resolver details or caller input.
  return new PermitStoreDeclarationLoadError("ERR_PERMIT_DECLARATION_READ");
}
const FIELDS = ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"];
function same(a, b) { return FIELDS.every(key => a[key] === b[key]); }
function identity(stat) {
  return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, String(stat[key])])));
}

// Only primitive arguments: no fs adapter, path override, options getter,
// callback, provider or controller credential can be supplied by a caller.
// expectedProjectId / minimumRevision are trusted caller CONTEXT, not proof of
// project ownership or an independently enforced anti-rollback lower bound.
function loadPermitStoreDeclaration(projectRoot, expectedProjectId, minimumRevision = 1) {
  if (typeof projectRoot !== "string" || !projectRoot || projectRoot.length > 4096 || projectRoot.includes("\0") ||
      typeof expectedProjectId !== "string" || !Number.isSafeInteger(minimumRevision) || minimumRevision < 1) {
    fail("ERR_PERMIT_DECLARATION_LOAD_INPUT");
  }
  const constants = fs.constants;
  if (!["darwin", "linux"].includes(process.platform) ||
      ![constants.O_NOFOLLOW, constants.O_DIRECTORY, constants.O_NONBLOCK].every(value => Number.isInteger(value) && value !== 0)) {
    fail("ERR_PERMIT_DECLARATION_READER_UNSUPPORTED");
  }
  const held = [], absent = [];
  let result, primary, root, governance, bindingBefore, bindingPath;
  let lexicalRoot;
  function stat(name) { return fs.lstatSync(name, { bigint: true }); }
  function optional(name) {
    try { return stat(name); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function open(name, directory) {
    const before = stat(name);
    if (!FIELDS.every(key => typeof before[key] === "bigint") || before.ino <= 0n || before.nlink <= 0n) {
      fail("ERR_PERMIT_DECLARATION_IDENTITY_UNPROVEN");
    }
    if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n)) {
      fail("ERR_PERMIT_DECLARATION_UNSAFE_FILE");
    }
    if (!directory && (before.size < 0n || before.size > BigInt(LIMITS.bytes))) fail("ERR_PERMIT_DECLARATION_LIMIT");
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0);
    const fd = fs.openSync(name, flags);
    // Register before fstat or any failure; each descriptor is closed once.
    const entry = { name, fd, before };
    held.push(entry);
    if (!same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, stat(name))) {
      fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
    }
    return entry;
  }
  function verify() {
    if (fs.realpathSync(lexicalRoot) !== root) fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
    for (const entry of held) {
      if (!same(entry.before, fs.fstatSync(entry.fd, { bigint: true })) || !same(entry.before, stat(entry.name))) {
        fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
      }
    }
    if (bindingBefore) {
      if (!same(bindingBefore, stat(bindingPath))) fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
      const current = resolveGovernanceRoot(root);
      if (current.agent_root !== governance.agent_root || current.mode !== governance.mode || current.project_root !== root) {
        fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
      }
    }
    for (const name of absent) if (optional(name)) fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
  }
  function observation(declaration, missingAt, file) {
    return Object.freeze({
      status: declaration ? "loaded-unproven" : "absent-unproven",
      path_binding: "path_binding_unproven",
      executionAuthorized: false,
      project_root: root,
      agent_root: governance ? governance.agent_root : null,
      governance_mode: governance ? governance.mode : null,
      missing_at: missingAt,
      file_identity: file ? identity(file.before) : null,
      declaration,
    });
  }
  try {
    // Pure layout validation prevents accidental use of an .agent checkout as
    // a project. Config is not a runtime URI; no database_ref is resolved here.
    lexicalRoot = resolveLayout({ projectRoot, projectId: expectedProjectId }).paths.projectRoot;
    root = fs.realpathSync(lexicalRoot);
    resolveLayout({ projectRoot: root, projectId: expectedProjectId });
    open(root, true);
    bindingPath = path.join(root, ".agent");
    bindingBefore = optional(bindingPath);
    if (!bindingBefore) {
      absent.push(bindingPath);
      result = observation(null, "governance-binding", null);
    } else {
      if (!(bindingBefore.isDirectory() || bindingBefore.isSymbolicLink()) ||
          (bindingBefore.isSymbolicLink() && bindingBefore.nlink !== 1n)) fail("ERR_PERMIT_DECLARATION_UNSAFE_FILE");
      // Sole supported symlink boundary: existing governance resolver owns
      // detached-local semantics, including platform canonical root aliases.
      governance = resolveGovernanceRoot(root);
      open(governance.agent_root, true);
      const config = path.join(governance.agent_root, "config");
      if (!optional(config)) {
        absent.push(config);
        result = observation(null, "config-directory", null);
      } else {
        open(config, true);
        const filename = path.join(config, "permit-stores.json");
        if (!optional(filename)) {
          absent.push(filename);
          result = observation(null, "declaration-file", null);
        } else {
          const file = open(filename, false), size = Number(file.before.size);
          // Validate the observed size before allocation; at most limit+1 bytes
          // are read, including a one-byte EOF probe. Growth never causes an
          // unbounded read or allocation. A short read is not silently parsed.
          const bytes = Buffer.alloc(size + 1);
          let used = 0;
          while (used < size) {
            const count = fs.readSync(file.fd, bytes, used, Math.min(8192, size - used), used);
            if (count === 0) fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
            used += count;
          }
          if (fs.readSync(file.fd, bytes, size, 1, size) !== 0) fail("ERR_PERMIT_DECLARATION_SOURCE_CHANGED");
          verify();
          const declaration = parsePermitStoreDeclaration(bytes.subarray(0, size), expectedProjectId, minimumRevision);
          result = observation(declaration, null, file);
        }
      }
    }
    verify();
  } catch (error) { primary = sanitized(error); }
  const cleanup = [];
  while (held.length) {
    const entry = held.pop(); // Never retry close, even if close released then threw.
    try { fs.closeSync(entry.fd); } catch { cleanup.push(new PermitStoreDeclarationLoadError("ERR_PERMIT_DECLARATION_CLOSE")); }
  }
  if (cleanup.length) {
    if (!primary) primary = cleanup.shift();
    if (cleanup.length) primary.cleanupError = cleanup[0];
  }
  if (primary) throw primary;
  return result;
}

module.exports = { PermitStoreDeclarationLoadError, loadPermitStoreDeclaration };
