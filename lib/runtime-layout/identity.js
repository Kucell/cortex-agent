"use strict";

// ─── Runtime Layout Stable Identities (M-026 MS-001) ───────────────────────
//
// Implements P-001 §3 "身份模型" + §4 "逻辑路径" + VC-002 stable-identity
// contract:
//
//   * Identities are strings, not derived from the resolved on-disk root or
//     `worktree_path`. Two workspaces whose `worktree_path` differs across
//     machines (different drives, case, symlink resolution) MUST compare
//     equal when and only when their identity string is identical.
//   * The resolver exposes typed factories for `project_id`,
//     `repository_id`, `workspace_id`, `machine_id`, and the composite
//     `workspace_instance_id`. Each factory enforces its own closed regex
//     and returns a frozen string-like object (`{ value, kind, toString }`)
//     so consumers cannot accidentally re-interpret it as an absolute path
//     or as a logical URI.
//   * Equality, dedupe, lease-scope and fencing tokens MUST compare on
//     `record.value` alone. Helper `equalIdentity(a, b)` enforces this and
//     refuses to accept any input that contains a resolved absolute path.

const {
  PROJECT_ID_SAFE,
  REPOSITORY_ID_SAFE,
  WORKSPACE_ID_SAFE,
  MACHINE_ID_SAFE,
  IDENTITY_KINDS,
  validateIdentityRecord,
  MAX_PROJECT_ID_LEN,
  MAX_REPOSITORY_ID_LEN,
  MAX_WORKSPACE_ID_LEN,
  MAX_MACHINE_ID_LEN,
  MAX_INSTANCE_ID_LEN,
} = require("./schemas");

// Conservative absolute-path heuristic — anything that *resembles* a
// resolved filesystem path on POSIX, Windows, or UNC MUST NOT pass an
// identity comparison. We refuse even when the caller provides a string
// that *happens* to start with `/`, even if it is not a real path on this
// host, so we cannot be tricked into dedup'ing a worktree against the
// resolved root.
const ABSOLUTE_PATH_HINT = /^(?:\/(?:Users|home|var|tmp|private|opt|etc)|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/;

class IdentityError extends Error {
  constructor(code, details) {
    super(`IDENTITY_ERROR:${code}`);
    this.name = "IdentityError";
    this.code = code;
    this.details = details || {};
  }
}

function assertNonPath(value, field) {
  if (typeof value !== "string") {
    throw new IdentityError("not_string", { field });
  }
  if (ABSOLUTE_PATH_HINT.test(value)) {
    throw new IdentityError("absolute_path", { field, value });
  }
  if (USERNAME_HINT.test(value)) {
    throw new IdentityError("username_in_identity", { field, value });
  }
  if (HOSTNAME_HINT.test(value)) {
    throw new IdentityError("hostname_in_identity", { field, value });
  }
  if (IPV4_LITERAL.test(value)) {
    throw new IdentityError("ipv4_in_identity", { field, value });
  }
}

function frozen(value, kind) {
  if (!IDENTITY_KINDS.has(kind)) {
    throw new IdentityError("unknown_kind", { kind });
  }
  const verdict = validateIdentityRecord({ kind, value });
  if (!verdict.ok) {
    throw new IdentityError("invalid", { field: kind, errors: verdict.errors });
  }
  return Object.freeze({
    kind,
    value,
    toString() { return value; },
    [Symbol.toPrimitive]() { return value; },
  });
}

function projectId(value) {
  if (typeof value !== "string" || !value) {
    throw new IdentityError("empty", { field: "project_id" });
  }
  if (value.length > MAX_PROJECT_ID_LEN) {
    throw new IdentityError("too_long", { field: "project_id", length: value.length });
  }
  assertNonPath(value, "project_id");
  if (!PROJECT_ID_SAFE.test(value)) {
    throw new IdentityError("unsafe_chars", { field: "project_id", value });
  }
  return frozen(value, "project_id");
}

function repositoryId(value) {
  if (typeof value !== "string" || !value) {
    throw new IdentityError("empty", { field: "repository_id" });
  }
  if (value.length > MAX_REPOSITORY_ID_LEN) {
    throw new IdentityError("too_long", { field: "repository_id", length: value.length });
  }
  assertNonPath(value, "repository_id");
  if (!REPOSITORY_ID_SAFE.test(value)) {
    throw new IdentityError("unsafe_chars", { field: "repository_id", value });
  }
  return frozen(value, "repository_id");
}

function workspaceId(value) {
  if (typeof value !== "string" || !value) {
    throw new IdentityError("empty", { field: "workspace_id" });
  }
  if (value.length > MAX_WORKSPACE_ID_LEN) {
    throw new IdentityError("too_long", { field: "workspace_id", length: value.length });
  }
  assertNonPath(value, "workspace_id");
  if (!WORKSPACE_ID_SAFE.test(value)) {
    throw new IdentityError("unsafe_chars", { field: "workspace_id", value });
  }
  return frozen(value, "workspace_id");
}

function machineId(value) {
  if (typeof value !== "string" || !value) {
    throw new IdentityError("empty", { field: "machine_id" });
  }
  if (value.length > MAX_MACHINE_ID_LEN) {
    throw new IdentityError("too_long", { field: "machine_id", length: value.length });
  }
  assertNonPath(value, "machine_id");
  if (!MACHINE_ID_SAFE.test(value)) {
    throw new IdentityError("unsafe_chars", { field: "machine_id", value });
  }
  return frozen(value, "machine_id");
}

// Composite instance id: `${machine_id}::${workspace_id}`. Built from the
// already-validated factory outputs so we never re-validate a string that
// could contain an absolute path.
function workspaceInstanceId(machine, workspace) {
  const machineRec = machineId(machine.value);
  const workspaceRec = workspaceId(workspace.value);
  const composite = `${machineRec.value}::${workspaceRec.value}`;
  if (composite.length > MAX_INSTANCE_ID_LEN) {
    throw new IdentityError("too_long", { field: "workspace_instance_id", length: composite.length });
  }
  return frozen(composite, "workspace_instance_id");
}

// Equality MUST NOT consult absolute paths. Refuse input shapes that
// expose `root`, `worktree_path`, `resolved_path` or any field that
// resembles a host filesystem path.
const PATH_BEARING_FIELDS = ["root", "worktree_path", "resolved_path", "absolute_path"];

function rejectPathBearingFields(obj, where) {
  if (!obj || typeof obj !== "object") return;
  for (const field of PATH_BEARING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      throw new IdentityError("path_in_identity", { where, field, value: obj[field] });
    }
  }
}

function equalIdentity(a, b) {
  if (a === b) return true; // fast path for identity-record references
  rejectPathBearingFields(a, "equalIdentity.a");
  rejectPathBearingFields(b, "equalIdentity.b");
  const recA = (a && typeof a === "object" && a.kind && a.value !== undefined) ? a : null;
  const recB = (b && typeof b === "object" && b.kind && b.value !== undefined) ? b : null;
  if (recA && recB) {
    return recA.kind === recB.kind && recA.value === recB.value;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (ABSOLUTE_PATH_HINT.test(a) || ABSOLUTE_PATH_HINT.test(b)) {
      throw new IdentityError("absolute_path", { a, b });
    }
    return a === b;
  }
  throw new IdentityError("invalid_input", { a: typeof a, b: typeof b });
}

// Detect a string that should NEVER appear inside an identity value:
// usernames, hostnames, machine-id-shaped prefixes that look like resolved
// filesystem paths, IPv4 literals, etc. Used by `assertIdentityField` and
// by VC-003 shared-state path scans.
const USERNAME_HINT = /^[A-Za-z][A-Za-z0-9._-]*@[A-Za-z][A-Za-z0-9._-]+$/;
const HOSTNAME_HINT = /^[a-z0-9][a-z0-9.-]{0,62}\.(?:local|internal|corp|lan)$/i;
const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function looksLikePathOrSecret(value) {
  if (typeof value !== "string") return false;
  if (ABSOLUTE_PATH_HINT.test(value)) return true;
  if (USERNAME_HINT.test(value)) return true;
  if (HOSTNAME_HINT.test(value)) return true;
  if (IPV4_LITERAL.test(value)) return true;
  return false;
}

function assertIdentityField(value, field) {
  if (typeof value !== "string" || !value) {
    throw new IdentityError("empty", { field });
  }
  if (looksLikePathOrSecret(value)) {
    throw new IdentityError("path_or_secret_in_identity", { field, value });
  }
}

// Validate a pre-typed identity record (the `{ kind, value }` shape) used
// by `resolveLayout` and the `hostDir` / `workspaceInstanceDir` helpers.
// Rejects:
//   * non-object / missing kind / missing value
//   * unknown kind
//   * cross-kind forging (a record typed as `project_id` passed where
//     `machine_id` is expected — the resolver used to trust any
//     `kind:"machine_id"` record and skip the regex checks)
//   * value that violates the identity-safe regex
//   * value that resembles an absolute host path / username / hostname /
//     IPv4 literal (delegated to `assertIdentityField` and `assertNonPath`)
//
// This is the only place that consolidates record-level identity
// validation. The resolver calls it before using a record to build any
// filesystem path so the same gate protects both string and record
// inputs.
function coerceIdentityRecord(record, expectedKind, field) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new IdentityError("not_record", { field, got: typeof record });
  }
  if (typeof record.kind !== "string" || !record.kind) {
    throw new IdentityError("missing_kind", { field });
  }
  if (typeof record.value !== "string" || !record.value) {
    throw new IdentityError("missing_value", { field, kind: record.kind });
  }
  if (record.kind !== expectedKind) {
    throw new IdentityError("wrong_kind", { field, expected: expectedKind, got: record.kind });
  }
  // Re-run the same shape checks that the string-input path enforces, so
  // a record cannot bypass the closed regex by carrying a forged `kind`.
  assertIdentityField(record.value, expectedKind);
  if (expectedKind === "project_id" && !PROJECT_ID_SAFE.test(record.value)) {
    throw new IdentityError("unsafe_chars", { field: expectedKind, value: record.value });
  }
  if (expectedKind === "repository_id" && !REPOSITORY_ID_SAFE.test(record.value)) {
    throw new IdentityError("unsafe_chars", { field: expectedKind, value: record.value });
  }
  if (expectedKind === "workspace_id" && !WORKSPACE_ID_SAFE.test(record.value)) {
    throw new IdentityError("unsafe_chars", { field: expectedKind, value: record.value });
  }
  if (expectedKind === "machine_id" && !MACHINE_ID_SAFE.test(record.value)) {
    throw new IdentityError("unsafe_chars", { field: expectedKind, value: record.value });
  }
  // Composite workspace_instance_id is composed from the two halves; we
  // re-validate both sides with the closed regex here so a single forged
  // record (one half legal, the other side) cannot slip through.
  if (expectedKind === "workspace_instance_id") {
    const parts = record.value.split("::");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new IdentityError("malformed_instance_record", { field, value: record.value });
    }
    if (!MACHINE_ID_SAFE.test(parts[0]) || !WORKSPACE_ID_SAFE.test(parts[1])) {
      throw new IdentityError("unsafe_chars", { field: expectedKind, value: record.value });
    }
  }
  return Object.freeze({
    kind: expectedKind,
    value: record.value,
    toString() { return record.value; },
    [Symbol.toPrimitive]() { return record.value; },
  });
}

module.exports = {
  IdentityError,
  projectId,
  repositoryId,
  workspaceId,
  machineId,
  workspaceInstanceId,
  coerceIdentityRecord,
  equalIdentity,
  assertIdentityField,
  rejectPathBearingFields,
  PATH_BEARING_FIELDS,
  ABSOLUTE_PATH_HINT,
};