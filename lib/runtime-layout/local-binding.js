"use strict";

// ─── Runtime Layout Local Binding Store (M-026 MS-001) ─────────────────────
//
// Per-host persistence of "workspace_id → absolute on-disk worktree path".
// These bindings are the ONLY legitimate carrier of absolute paths in the
// new layout (P-001 §4 final paragraph) and they live inside
// `.agent/runtime/hosts/<machine-id>/bindings.local.json`, which:
//   • is NOT shared (the agent-root `.gitignore` excludes everything under
//     `.agent/runtime/hosts/`);
//   • is NOT consulted for identity, dedupe, lease-scope, or fencing;
//   • is OPTIONAL: a workspace without a binding is reported as
//     `LOCAL_BINDING_UNRESOLVED` so callers can re-resolve it.
//
// Mirrors the discipline of `lib/coordination/local-host-binding.js`:
//   • No symlinks in any parent directory (defence in depth).
//   • 0o600 + atomic tmp → rename → dir fsync.
//   • Containment is enforced against the resolver-declared host dir.
//   • Receipts NEVER contain credentials, prompts, response bodies,
//     absolute paths belonging to other machines, or host-private
//     identifiers.

const fs = require("node:fs");
const path = require("node:path");

const {
  workspaceId: identityWorkspaceId,
  workspaceInstanceId: identityWorkspaceInstanceId,
  IdentityError,
} = require("./identity");
const {
  resolveLayout,
  hostBindingsPath,
  assertNoSymlinkAncestors,
  RuntimeLayoutError,
  exists,
} = require("./resolver");
const { validateLocalBinding, ID_SAFE } = require("./schemas");

const BINDING_FILE = "bindings.local.json";
const SCHEMA_VERSION = "1.0";
const MAX_BINDINGS = 256;
const MAX_ABSOLUTE_PATH_LEN = 4096;
const MAX_FIELD_LEN = 128;

class LocalBindingError extends Error {
  constructor(code, details) {
    super(`LOCAL_BINDING_ERROR:${code}`);
    this.name = "LocalBindingError";
    this.code = code;
    this.details = details || {};
  }
}

function assertAbsolutePath(value) {
  if (typeof value !== "string" || !value) {
    throw new LocalBindingError("empty_path");
  }
  if (value.length > MAX_ABSOLUTE_PATH_LEN) {
    throw new LocalBindingError("too_long", { length: value.length });
  }
  // POSIX root, Windows drive root, or UNC root. Anything else is not a
  // valid absolute path for the local-binding contract.
  const looksPosix = value.startsWith("/");
  const looksWindows = /^[A-Za-z]:[\\/]/.test(value);
  const looksUnc = value.startsWith("\\\\") || value.startsWith("//");
  if (!looksPosix && !looksWindows && !looksUnc) {
    throw new LocalBindingError("not_absolute", { value });
  }
}

function ensureHostDir(layout) {
  if (!layout.machineIdentity) {
    throw new LocalBindingError("missing_machine_identity");
  }
  const hostDirPath = path.join(layout.paths.runtimeDir, "hosts", layout.machineIdentity.value);
  // Bound the symlink inspection to the resolver-declared agent dir so
  // platform aliases above `.agent/` (macOS `/var` -> `/private/var`) do
  // not produce false positives.
  assertNoSymlinkAncestors(hostDirPath, layout.paths.agentDir);
  fs.mkdirSync(hostDirPath, { recursive: true });
  // Re-stat after mkdir so a concurrent symlink swap is caught.
  const lstat = fs.lstatSync(hostDirPath);
  if (lstat.isSymbolicLink()) {
    throw new LocalBindingError("symlink_host_dir", { dir: hostDirPath });
  }
  return hostDirPath;
}

function bindingsFile(layout) {
  if (!layout.machineIdentity) {
    throw new LocalBindingError("missing_machine_identity");
  }
  return hostBindingsPath(layout, layout.machineIdentity);
}

function readEnvelope(file) {
  if (!exists(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (cause) {
    throw new LocalBindingError("read_failed", { cause: cause && cause.code });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new LocalBindingError("corrupt", { cause: cause && cause.message });
  }
  const verdict = validateLocalBinding(parsed);
  if (!verdict.ok) {
    throw new LocalBindingError("schema_invalid", { errors: verdict.errors });
  }
  return parsed;
}

function writeEnvelopeAtomic(file, payload) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(tmp); } catch { /* renamed or already gone */ }
  }
}

class LocalBindingStore {
  constructor(layout, options = {}) {
    if (!layout || typeof layout !== "object") {
      throw new LocalBindingError("missing_layout");
    }
    if (!layout.machineIdentity) {
      throw new LocalBindingError("missing_machine_identity");
    }
    this.layout = layout;
    this.clock = options.clock || Date.now;
    this.machineId = layout.machineIdentity.value;
    ensureHostDir(layout);
    this.file = bindingsFile(layout);
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }

  _load() {
    const envelope = readEnvelope(this.file);
    if (!envelope) {
      return {
        schema_version: SCHEMA_VERSION,
        machine_id: this.machineId,
        bindings: [],
        updated_at: this._nowIso(),
      };
    }
    if (envelope.machine_id !== this.machineId) {
      throw new LocalBindingError("machine_mismatch", {
        expected: this.machineId,
        actual: envelope.machine_id,
      });
    }
    return envelope;
  }

  _save(envelope) {
    const verdict = validateLocalBinding(envelope);
    if (!verdict.ok) {
      throw new LocalBindingError("schema_invalid", { errors: verdict.errors });
    }
    writeEnvelopeAtomic(this.file, envelope);
  }

  list() {
    // Re-check the host binding-file chain BEFORE every read so a symlink
    // swap that lands between construction and `list` cannot downgrade this
    // read to a soft envelope-from-the-wrong-host outcome.
    assertNoSymlinkAncestors(this.file, this.layout.paths.agentDir);
    const env = this._load();
    return env.bindings.slice();
  }

  resolve(workspaceIdentity) {
    const ws = (workspaceIdentity && typeof workspaceIdentity === "object" && workspaceIdentity.kind)
      ? workspaceIdentity
      : identityWorkspaceId(workspaceIdentity);
    // Re-resolve containment BEFORE reading the envelope so a symlink swap
    // on the host dir cannot silently downgrade this read to a soft
    // `LOCAL_BINDING_UNRESOLVED`. When the host dir was a real directory
    // at construction time but a symlink at resolve time, the envelope
    // would either be missing (because the symlink target does not have it)
    // or come from a different machine — both are security failures that
    // must surface as exceptions, not as an "unresolved" verdict.
    assertNoSymlinkAncestors(this.file, this.layout.paths.agentDir);
    const env = this._load();
    const found = env.bindings.find((entry) => entry.workspace_id === ws.value);
    if (!found) return { ok: false, reason: "LOCAL_BINDING_UNRESOLVED" };
    // Validate the bound absolute_path on every read so a tampered binding
    // is refused. The binding is the ONLY place that legitimately carries
    // an absolute path, and the path is a read-only resolved location —
    // NOT a caller-controlled storage ancestor. The contract here is
    // therefore:
    //   * the path MUST be a valid local absolute path (POSIX / Windows
    //     drive / UNC); we do NOT require containment inside
    //     `runtimeDir` because the whole point of the binding is to
    //     point at an external worktree;
    //   * we do NOT walk or reject the absolute_path's ancestors. The
    //     worktree may live anywhere on the host, including outside
    //     `.agent/runtime/` and outside the project root entirely. It
    //     may also traverse a platform alias such as macOS `/var`
    //     (-> `/private/var`) or any user-chosen symlink worktree —
    //     those are OS-level path aliases, not binding-storage
    //     attacks, and refusing them would corrupt stable identity for
    //     a perfectly legal worktree.
    //
    // Defence in depth is enforced UPSTREAM: the
    // `.agent/runtime/hosts/<machine-id>/bindings.local.json` chain (the
    // caller-controlled storage ancestors) is re-validated at the top of
    // `resolve` above; that is the right place to refuse a symlink swap,
    // and it is the contract we keep. The bound absolute_path itself is
    // a stable identity reference, not a write target.
    assertAbsolutePath(found.absolute_path);
    return { ok: true, binding: { ...found } };
  }

  upsert(input) {
    if (!input || typeof input !== "object") {
      throw new LocalBindingError("empty_input");
    }
    const ws = input.workspaceIdentity
      || (input.workspace_id ? identityWorkspaceId(input.workspace_id) : null);
    if (!ws) throw new LocalBindingError("missing_workspace");
    assertAbsolutePath(input.absolute_path);
    const capturedAt = input.captured_at || this._nowIso();
    if (typeof capturedAt !== "string" || capturedAt.length > MAX_FIELD_LEN) {
      throw new LocalBindingError("bad_timestamp", { value: capturedAt });
    }
    // Re-check the host binding-file chain BEFORE both the read-merge and
    // the write-rename so a symlink swap that lands between construction
    // and `upsert` cannot route the new envelope through an attacker-
    // controlled host directory.
    assertNoSymlinkAncestors(this.file, this.layout.paths.agentDir);
    const env = this._load();
    const existingIndex = env.bindings.findIndex((entry) => entry.workspace_id === ws.value);
    const entry = {
      workspace_id: ws.value,
      workspace_instance_id: input.workspace_instance_id || null,
      absolute_path: input.absolute_path,
      captured_at: capturedAt,
    };
    if (existingIndex >= 0) {
      env.bindings[existingIndex] = entry;
    } else {
      if (env.bindings.length >= MAX_BINDINGS) {
        throw new LocalBindingError("too_many_bindings", { max: MAX_BINDINGS });
      }
      env.bindings.push(entry);
    }
    env.updated_at = this._nowIso();
    this._save(env);
    return { ...entry };
  }

  remove(workspaceIdentity) {
    const ws = (workspaceIdentity && typeof workspaceIdentity === "object" && workspaceIdentity.kind)
      ? workspaceIdentity
      : identityWorkspaceId(workspaceIdentity);
    // Re-check the host binding-file chain BEFORE the read-merge and the
    // write-rename so a symlink swap cannot redirect a `remove` to a
    // foreign host directory.
    assertNoSymlinkAncestors(this.file, this.layout.paths.agentDir);
    const env = this._load();
    const before = env.bindings.length;
    env.bindings = env.bindings.filter((entry) => entry.workspace_id !== ws.value);
    if (env.bindings.length === before) return false;
    env.updated_at = this._nowIso();
    this._save(env);
    return true;
  }
}

// Factory that composes the layout + store so most callers do not need to
// assemble the layout object by hand.
function openStore(input, options = {}) {
  const layout = resolveLayout(input);
  const store = new LocalBindingStore(layout, options);
  return { layout, store };
}

module.exports = {
  LocalBindingError,
  LocalBindingStore,
  openStore,
  BINDING_FILE,
  SCHEMA_VERSION,
};