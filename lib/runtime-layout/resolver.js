"use strict";

// ─── Runtime Layout Resolver (M-026 MS-001) ────────────────────────────────
//
// Single source of truth for every runtime data root in the project. Every
// other module is required by VC-001 to read its data location from this
// resolver instead of computing `path.join(root, ".agent-runtime", …)`
// themselves.
//
// Layered namespaces (per P-001 §2 目标目录):
//
//   <project>/.agent/contracts/runtime-state/        # frozen schemas + writer contracts
//   <project>/.agent/runtime/coordination/          # portable: tasks, leases, snapshots
//   <project>/.agent/runtime/dispatch/               # portable: dispatch plans, journals
//   <project>/.agent/runtime/cross-project/          # portable: inbox/outbox/subs
//   <project>/.agent/runtime/continuity/             # portable: continuity state
//   <project>/.agent/runtime/evidence/               # portable: evidence archives
//   <project>/.agent/runtime/hosts/<machine-id>/     # machine-local: PID, locks, binding
//   <project>/.agent/runtime/worktrees/<instance>/   # per-instance: cursor, lease state
//   <project>/.agent/handoffs/                      # portable: handoff records
//   <project>/.agent-runtime/                       # legacy: read-only fallback
//
// Strictly required by the validation contract:
//
//   * The resolver MUST be the ONLY place that hard-codes these segments.
//     Tests in tests/runtime-layout/runtime-layout.test.js assert that the
//     constants match the proposal P-001 §2 table.
//   * POSIX and Windows-shaped roots MUST serialise identically given the
//     same logical identity. The resolver does not convert drives/case on
//     its own — it is the local-binding step that translates logical URI
//     into a real, machine-specific filesystem path.
//   * `detectLegacyRuntime(root)` returns `true` ONLY when an on-disk
//     `.agent-runtime/` directory exists and contains at least one of the
//     recognised legacy segments. Empty directories or `.DS_Store` alone
//     are NOT considered a detected legacy layout.

const fs = require("node:fs");
const path = require("node:path");

const {
  ID_SAFE,
  PROJECT_ID_SAFE,
  REPOSITORY_ID_SAFE,
  WORKSPACE_ID_SAFE,
  MACHINE_ID_SAFE,
  IDENTITY_KINDS,
  MAX_PROJECT_ID_LEN,
  MAX_REPOSITORY_ID_LEN,
  MAX_WORKSPACE_ID_LEN,
  MAX_MACHINE_ID_LEN,
  MAX_INSTANCE_ID_LEN,
} = require("./schemas");
const {
  machineId: identityMachineId,
  workspaceId: identityWorkspaceId,
  workspaceInstanceId: identityWorkspaceInstanceId,
  projectId: identityProjectId,
  repositoryId: identityRepositoryId,
  coerceIdentityRecord,
  IdentityError,
} = require("./identity");

const LEGACY_RUNTIME_SEGMENT = ".agent-runtime";
const AGENT_DIR_SEGMENT = ".agent";
const CONTRACTS_DIR = "contracts";
const RUNTIME_DIR = "runtime";
const HOSTS_DIR = "hosts";
const WORKTREES_DIR = "worktrees";
const HANDOFFS_DIR = "handoffs";

const CONTRACTS_RUNTIME_STATE = path.posix.join(CONTRACTS_DIR, "runtime-state");

// Portable runtime namespaces that the proposal §2 enumerates. Any new
// portable namespace MUST be added here AND to the resolver's typed helper
// list, and the corresponding legacy mapping MUST be declared in
// LEGACY_PORTABLE_NAMESPACES so the migration planner in MS-002 can
// consume the same table.
const PORTABLE_NAMESPACES = Object.freeze([
  "coordination",
  "dispatch",
  "cross-project",
  "continuity",
  "evidence",
]);

const LEGACY_PORTABLE_NAMESPACES = Object.freeze({
  coordination: "coordination",
  "cross-project": "cross-project",
  dispatch: "dispatch",
  handoffs: "handoffs",
  "runtime-continuity": "continuity",
  "runtime-evidence": "evidence",
});

const LEGACY_RECOGNISED_SEGMENTS = Object.freeze([
  "coordination",
  "cross-project",
  "dispatch",
  "handoffs",
  "runtime-continuity",
  "runtime-evidence",
]);

class RuntimeLayoutError extends Error {
  constructor(code, details) {
    super(`RUNTIME_LAYOUT_ERROR:${code}`);
    this.name = "RuntimeLayoutError";
    this.code = code;
    this.details = details || {};
  }
}

function assertProjectRoot(root) {
  if (typeof root !== "string" || !root) {
    throw new RuntimeLayoutError("empty_root");
  }
  // The resolver accepts both an existing project root and a candidate
  // root that has not been created yet. We never `realpathSync` the input
  // — that would leak host-specific symlink resolution into shared state.
  return path.resolve(root);
}

function assertIdentityString(value, field, pattern, maxLen) {
  if (typeof value !== "string" || !value) {
    throw new RuntimeLayoutError("empty_identity", { field });
  }
  if (value.length > maxLen) {
    throw new RuntimeLayoutError("identity_too_long", { field, length: value.length, max: maxLen });
  }
  if (!pattern.test(value)) {
    throw new RuntimeLayoutError("unsafe_identity", { field, value });
  }
  return value;
}

// Composite `workspace_instance_id` builder that accepts the raw
// `${machine_id}::${workspace_id}` string shape — the format callers most
// commonly reach for when stitching together a layout. We split on `::`,
// validate each segment with the closed regex used by the identity
// factories, and refuse any malformed / extra-delimiter / wrong-identity
// input. The result is identical to the record-based path so consumers
// see a uniform identity record back from `resolveLayout`.
//
// Refuses (all fail closed):
//   * empty / non-string input
//   * missing `::` delimiter (single segment)
//   * empty machine_id half (`::WS-alpha`)
//   * empty workspace_id half (`M-hostA0001::`)
//   * extra delimiter (`M::WS::extra` — three or more segments)
//   * machine_id that does not match MACHINE_ID_SAFE
//   * workspace_id that does not match WORKSPACE_ID_SAFE
function buildCompositeInstanceIdFromString(value) {
  if (typeof value !== "string" || !value) {
    throw new RuntimeLayoutError("empty_identity", { field: "workspace_instance_id" });
  }
  const segments = value.split("::");
  if (segments.length !== 2) {
    throw new RuntimeLayoutError("malformed_instance", { value, segments: segments.length });
  }
  const [machineStr, workspaceStr] = segments;
  if (!machineStr || !workspaceStr) {
    throw new RuntimeLayoutError("malformed_instance", { value, reason: "empty_segment" });
  }
  // Validate each half against the closed regex BEFORE composing so the
  // failure is attributed to the right field (machine vs workspace).
  const machineValid = assertIdentityString(machineStr, "machine_id", MACHINE_ID_SAFE, MAX_MACHINE_ID_LEN);
  const workspaceValid = assertIdentityString(workspaceStr, "workspace_id", WORKSPACE_ID_SAFE, MAX_WORKSPACE_ID_LEN);
  const composite = `${machineValid}::${workspaceValid}`;
  if (composite.length > MAX_INSTANCE_ID_LEN) {
    throw new RuntimeLayoutError("identity_too_long", { field: "workspace_instance_id", length: composite.length, max: MAX_INSTANCE_ID_LEN });
  }
  // Reuse the typed factory so the returned record is byte-for-byte the
  // same shape consumers see on the record-based path.
  const machineRec = identityMachineId(machineValid);
  const workspaceRec = identityWorkspaceId(workspaceValid);
  return identityWorkspaceInstanceId(machineRec, workspaceRec);
}

function portableNamespace(name) {
  if (!PORTABLE_NAMESPACES.includes(name)) {
    throw new RuntimeLayoutError("unknown_namespace", { name, allowed: PORTABLE_NAMESPACES });
  }
  return name;
}

// Construct a layout object given the validated identities. Returned object
// is plain (not frozen) because callers sometimes want to extend it with
// their own metadata, but every `path` field is derived from the typed
// resolver helpers below.
//
// Identity-record inputs (`projectIdentity`, `repositoryIdentity`,
// `workspaceIdentity`, `machineIdentity`, `workspaceInstanceIdentity`)
// are validated against the same closed regex + path heuristics the
// string-input factories apply — passing a forged `{kind:"project_id",
// value:"/Users/forged"}` record is rejected with a typed
// `IDENTITY_ERROR:unsafe_chars` so callers cannot bypass the closed
// vocabulary by carrying the record shape itself.
function resolveLayout(input) {
  if (!input || typeof input !== "object") {
    throw new RuntimeLayoutError("empty_input");
  }
  const projectRoot = assertProjectRoot(input.projectRoot);
  // We accept either an already-typed identity record or a plain string.
  // When a string is passed, we delegate to the typed factory so the
  // closed regex + length checks are not duplicated. When a record is
  // passed, we route it through `coerceIdentityRecord` for the same
  // validation — record inputs MUST NOT bypass any of the closed checks
  // that string inputs also run.
  const projectIdRec = input.projectIdentity
    ? coerceIdentityRecord(input.projectIdentity, "project_id", "projectIdentity")
    : identityProjectId(input.projectId);
  const repositoryIdRec = input.repositoryIdentity
    ? coerceIdentityRecord(input.repositoryIdentity, "repository_id", "repositoryIdentity")
    : (input.repositoryId ? identityRepositoryId(input.repositoryId) : null);
  const workspaceIdRec = input.workspaceIdentity
    ? coerceIdentityRecord(input.workspaceIdentity, "workspace_id", "workspaceIdentity")
    : (input.workspaceId ? identityWorkspaceId(input.workspaceId) : null);
  const machineIdRec = input.machineIdentity
    ? coerceIdentityRecord(input.machineIdentity, "machine_id", "machineIdentity")
    : (input.machineId ? identityMachineId(input.machineId) : null);
  const workspaceInstanceIdRec = input.workspaceInstanceIdentity
    ? coerceIdentityRecord(input.workspaceInstanceIdentity, "workspace_instance_id", "workspaceInstanceIdentity")
    : (input.workspaceInstanceId ? buildCompositeInstanceIdFromString(input.workspaceInstanceId)
      : (machineIdRec && workspaceIdRec ? identityWorkspaceInstanceId(machineIdRec, workspaceIdRec) : null));
  return {
    projectIdentity: projectIdRec,
    repositoryIdentity: repositoryIdRec,
    workspaceIdentity: workspaceIdRec,
    machineIdentity: machineIdRec,
    workspaceInstanceIdentity: workspaceInstanceIdRec,
    paths: {
      projectRoot,
      agentDir: path.join(projectRoot, AGENT_DIR_SEGMENT),
      contractsDir: path.join(projectRoot, AGENT_DIR_SEGMENT, CONTRACTS_DIR),
      contractsRuntimeState: path.join(projectRoot, AGENT_DIR_SEGMENT, CONTRACTS_RUNTIME_STATE),
      runtimeDir: path.join(projectRoot, AGENT_DIR_SEGMENT, RUNTIME_DIR),
      handoffsDir: path.join(projectRoot, AGENT_DIR_SEGMENT, HANDOFFS_DIR),
      legacyRuntimeDir: path.join(projectRoot, LEGACY_RUNTIME_SEGMENT),
    },
  };
}

function portableRuntimePath(layout, namespace) {
  const name = portableNamespace(namespace);
  return path.join(layout.paths.runtimeDir, name);
}

function hostsDir(layout) {
  return path.join(layout.paths.runtimeDir, HOSTS_DIR);
}

function worktreesDir(layout) {
  return path.join(layout.paths.runtimeDir, WORKTREES_DIR);
}

function hostDir(layout, machineIdOrRecord) {
  const rec = (machineIdOrRecord && typeof machineIdOrRecord === "object" && machineIdOrRecord.kind)
    ? coerceIdentityRecord(machineIdOrRecord, "machine_id", "hostDir")
    : identityMachineId(machineIdOrRecord);
  const target = path.join(hostsDir(layout), rec.value);
  // After `path.join` normalises any `..` or `.` segments, the only way
  // to escape `hostsDir` is via traversal. Refuse to produce a path
  // that lands outside the resolver-declared hosts directory.
  return assertContained(target, hostsDir(layout));
}

function hostBindingsPath(layout, machineIdOrRecord) {
  return path.join(hostDir(layout, machineIdOrRecord), "bindings.local.json");
}

function workspaceInstanceDir(layout, instanceIdOrRecord) {
  let rec;
  if (typeof instanceIdOrRecord === "string") {
    if (!instanceIdOrRecord.includes("::")) {
      throw new RuntimeLayoutError("malformed_instance", { instanceId: instanceIdOrRecord });
    }
    // Route the composite string through the same builder that
    // `resolveLayout` uses so the validation (empty half, extra
    // delimiter, wrong identity) is consistent across the two call sites.
    rec = buildCompositeInstanceIdFromString(instanceIdOrRecord);
  } else {
    rec = coerceIdentityRecord(instanceIdOrRecord, "workspace_instance_id", "workspaceInstanceDir");
  }
  const target = path.join(worktreesDir(layout), rec.value);
  // Containment check: a forged record whose `value` is `../../escape`
  // would otherwise walk out of `worktrees/` after `path.join` collapses
  // the traversal segments. Refuse that outcome here.
  return assertContained(target, worktreesDir(layout));
}

// `exists` helpers wrap `fs` with the resolver signature so consumers can
// run the resolver without importing `fs` directly.

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function detectLegacyRuntime(root) {
  const projectRoot = assertProjectRoot(root);
  const legacy = path.join(projectRoot, LEGACY_RUNTIME_SEGMENT);
  if (!exists(legacy)) return false;
  let entries;
  try {
    entries = fs.readdirSync(legacy);
  } catch {
    return false;
  }
  // Recognise the legacy layout only when at least one of the proposal's
  // expected segments is present. Empty directory or `.DS_Store`/`.gitignore`
  // alone MUST NOT count as a detected legacy runtime.
  return entries.some((name) => LEGACY_RECOGNISED_SEGMENTS.includes(name));
}

// `portablePath` resolves a `runtime://<namespace>/<relative>` logical URI
// into a host filesystem path. This is the ONLY function that translates
// between a logical URI and an absolute path; everything else (cross-host
// state exchange, equality, dedupe, lease-scope, fencing) MUST stay on the
// logical URI side.
//
// The translation is intentionally trivial: prepend the resolver's runtime
// dir and replace `/` with `path.sep`. We do NOT `realpathSync` the result
// — that would introduce a per-host concrete path into shared state.
function portablePath(layout, logicalUri) {
  if (!logicalUri || typeof logicalUri !== "object" || logicalUri.kind !== "logical_uri") {
    throw new RuntimeLayoutError("not_logical_uri", { kind: logicalUri && logicalUri.kind });
  }
  if (logicalUri.scheme !== "runtime") {
    throw new RuntimeLayoutError("unsupported_scheme", { scheme: logicalUri.scheme });
  }
  const [namespace, ...rest] = logicalUri.segments;
  portableNamespace(namespace);
  const target = path.join(portableRuntimePath(layout, namespace), rest.join(path.sep));
  return assertContained(target, layout.paths.runtimeDir);
}

function handoffPath(layout, logicalUri) {
  if (!logicalUri || typeof logicalUri !== "object" || logicalUri.scheme !== "agent") {
    throw new RuntimeLayoutError("not_handoff_uri", { scheme: logicalUri && logicalUri.scheme });
  }
  const target = path.join(layout.paths.handoffsDir, logicalUri.segments.join(path.sep));
  return assertContained(target, layout.paths.handoffsDir);
}

// ─── Containment / traversal rejection ──────────────────────────────────────────────────────
//
// The resolver is the single point that decides what an absolute path can
// touch. Per VC-003:
//   • Resolved paths MUST be confined to the resolver-declared root.
//   • `..` segments are normalised by `path.join`/`path.resolve`, so the
//     only way to escape the root is via a symlink, a non-existent
//     absolute path or an absolute path with drive/UNC components. Each of
//     those is checked explicitly here.
function assertContained(target, root) {
  const resolvedRoot = path.resolve(root);
  // We intentionally do NOT call realpathSync: shared state must never
  // capture a host-specific resolved path. We instead check the syntactic
  // boundary, which is what VC-003 actually requires ("containment checks
  // reject traversal or cross-root resolution").
  const resolvedTarget = path.resolve(target);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    throw new RuntimeLayoutError("outside_root", { resolvedTarget, resolvedRoot });
  }
  return resolvedTarget;
}

// Symlink-aware variant used by the local-binding store. When a binding
// target or one of its parents is a symlink, we refuse to write through it
// so a malicious shared root cannot redirect writes into another host
// directory. Mirrors the discipline of lib/coordination/local-host-binding.js.
//
// We bound the inspection to the caller-declared `stopAt` (or, when absent,
// to `.agent/` so platform aliases such as macOS `/var` -> `/private/var` do
// not produce false positives — those are outside the caller's control).
function assertNoSymlinkAncestors(target, stopAt) {
  const resolved = path.resolve(target);
  const stop = stopAt ? path.resolve(stopAt) : null;
  const chain = [];
  let cursor = resolved;
  while (true) {
    chain.push(cursor);
    if (stop && cursor === stop) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // reached filesystem root
    cursor = parent;
    if (chain.length > 32) break; // hard cap, defence in depth
  }
  for (const candidate of chain) {
    let lstat;
    try {
      lstat = fs.lstatSync(candidate);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (lstat.isSymbolicLink()) {
      throw new RuntimeLayoutError("symlink_in_path", { path: candidate });
    }
  }
  return resolved;
}

module.exports = {
  RuntimeLayoutError,
  IdentityError,
  // Segments / namespaces — exported so MS-002 migration planner can
  // enumerate them without re-deriving them from string literals.
  LEGACY_RUNTIME_SEGMENT,
  AGENT_DIR_SEGMENT,
  CONTRACTS_DIR,
  RUNTIME_DIR,
  HOSTS_DIR,
  WORKTREES_DIR,
  HANDOFFS_DIR,
  CONTRACTS_RUNTIME_STATE,
  PORTABLE_NAMESPACES,
  LEGACY_PORTABLE_NAMESPACES,
  LEGACY_RECOGNISED_SEGMENTS,
  ID_SAFE,
  PROJECT_ID_SAFE,
  REPOSITORY_ID_SAFE,
  WORKSPACE_ID_SAFE,
  MACHINE_ID_SAFE,
  IDENTITY_KINDS,
  MAX_PROJECT_ID_LEN,
  MAX_REPOSITORY_ID_LEN,
  MAX_WORKSPACE_ID_LEN,
  MAX_MACHINE_ID_LEN,
  MAX_INSTANCE_ID_LEN,
  // Resolver API.
  resolveLayout,
  portableNamespace,
  portableRuntimePath,
  hostsDir,
  worktreesDir,
  hostDir,
  hostBindingsPath,
  workspaceInstanceDir,
  portablePath,
  handoffPath,
  assertContained,
  assertNoSymlinkAncestors,
  exists,
  detectLegacyRuntime,
};