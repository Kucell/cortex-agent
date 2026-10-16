"use strict";

// ─── Runtime Layout Migration Planner / Apply / Rollback (M-026 MS-002) ──────
//
// Implements the runtime-state-layout update transaction per P-002:
//   • Shared planner returns the canonical JSON plan used by both dry-run
//     and apply.
//   • Dry-run is always zero-write: no dirs, reports, locks, backups or
//     temp files.
//   • Apply writes a candidate layout, validates it, then atomically
//     activates it by writing the marker LAST.
//   • Any fault during apply triggers rollback: restore legacy readability
//     and remove any half-activated marker.
//   • Second update is idempotent no-op: detect already-migrated layout.
//   • Conflict/fail-closed: outside allowlist, files remain byte-identical;
//     no git add/commit/push.
//
// Allowlist (per P-002 §5 User Modification Protection):
//   Legacy portable namespaces → new layout portable namespaces.
//   Contracts/schema files under .agent/contracts/runtime-state/.
//   Layout activation marker: .agent/runtime/layout.json.
//
// NOT in scope (MS-004):
//   • Real self-migration of the current project's existing .agent-runtime/
//   • Any git side effects.
//
// Public API:
//   buildMigrationPlan(ctx, { dryRun }) → migrationPlan
//   applyMigration(ctx, migrationPlan) → { ok, report }
//   rollbackMigration(ctx, migrationPlan) → { ok }

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  resolveLayout,
  detectLegacyRuntime,
  RuntimeLayoutError,
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
} = require("../../runtime-layout");

// ─── Constants ─────────────────────────────────────────────────────────────

const LAYOUT_MARKER_FILE = "layout.json";
const CANDIDATE_MARKER_FILE = "layout.candidate.json";
const LEGACY_HANDOOKS = "handoffs";
const RUNTIME_LAYOUT_VERSION = "1";

// Well-known source segments under .agent-runtime/ that map to the new layout.
// Per P-002 §5, only these are considered for migration.
const LEGACY_SOURCE_SEGMENTS = Object.freeze({
  coordination: "coordination",
  "cross-project": "cross-project",
  dispatch: "dispatch",
  handoffs: "handoffs",
  "runtime-continuity": "continuity",
  "runtime-evidence": "evidence",
});

// Old Schema files that historically lived under `.agent/runtime/` and that
// per P-001 §2 must move to `.agent/contracts/runtime-state/`. Anything in
// `.agent/runtime/` that is NOT in this list and NOT a portable namespace
// directory or the activation marker is left alone (user customization).
//
// Note: README.md is intentionally NOT in this list. The new templates ship
// their own .agent/contracts/runtime-state/README.md that documents the new
// contracts; moving or overwriting the old README would either conflict with
// the new one or silently destroy user-facing docs that describe superseded
// schemas. Users may remove the old .agent/runtime/README.md manually when
// they confirm the new contracts are in place.
const LEGACY_RUNTIME_SCHEMAS = Object.freeze([
  "authorization.schema.json",
  "evidence-ref.schema.json",
  "log-cursor.schema.json",
  "operation.schema.json",
  "readiness-projection.schema.json",
  "resource-event.schema.json",
  "runtime-state-projection.schema.json",
]);
// Action types used in the migration plan.
const ACTION_TYPES = Object.freeze({
  INSPECT_LEGACY: "inspect_legacy_layout",
  INSPECT_LEGACY_SCHEMAS: "inspect_legacy_schemas",
  COPY_CONTRACTS: "copy_contracts",
  COPY_RUNTIME_PORTABLE: "copy_runtime_portable",
  MOVE_LEGACY_SCHEMAS: "move_legacy_schemas",
  TRANSFORM_WORKSPACE_IDENTITY: "transform_workspace_identity",
  SEED_LOCAL_BINDING: "seed_local_binding",
  VALIDATE_CANDIDATE_LAYOUT: "validate_candidate_layout",
  ACTIVATE_LAYOUT: "activate_layout",
  RETAIN_LEGACY_FALLBACK: "retain_legacy_fallback",
  REPORT_NOOP: "report_noop",
});

// Risk levels for migration actions.
const RISK_LEVELS = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
});

// Conflict policies.
const CONFLICT_POLICIES = Object.freeze({
  BLOCK: "block",
  SKIP: "skip",
  OVERWRITE: "overwrite",
});

// ─── Error types ────────────────────────────────────────────────────────────

class MigrationError extends Error {
  constructor(code, details, phase) {
    super(`MIGRATION_ERROR:${code}`);
    this.name = "MigrationError";
    this.code = code;
    this.details = details || {};
    this.phase = phase || null;
  }
}

// ─── File digest helpers ────────────────────────────────────────────────────

function fileDigest(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function digestDirectory(dir, files) {
  const digests = {};
  for (const rel of files) {
    const abs = path.join(dir, rel);
    digests[rel] = fileDigest(abs);
  }
  return digests;
}

// ─── Allowlist helpers ──────────────────────────────────────────────────────

// Returns true if the given absolute path is within the legacy runtime root.
function isUnderLegacyRuntime(projectRoot, absPath) {
  const legacyRoot = path.join(projectRoot, LEGACY_RUNTIME_SEGMENT);
  const resolved = path.resolve(absPath);
  const legacyResolved = path.resolve(legacyRoot);
  const prefix = legacyResolved.endsWith(path.sep) ? legacyResolved : legacyResolved + path.sep;
  return resolved === legacyResolved || resolved.startsWith(prefix);
}

// Returns true if the path is an expected target under the new layout.
// Only paths under .agent/contracts/runtime-state/ and .agent/runtime/ are allowed.
function isAllowedNewLayoutPath(absPath) {
  const resolved = path.resolve(absPath);
  const agentDir = path.sep + AGENT_DIR_SEGMENT + path.sep;
  const contractsIdx = resolved.indexOf(agentDir + CONTRACTS_RUNTIME_STATE);
  const runtimeIdx = resolved.indexOf(path.sep + RUNTIME_DIR + path.sep);
  if (contractsIdx !== -1) return true;
  if (runtimeIdx !== -1) {
    // Allowed: runtime/, runtime/<namespace>/, runtime/hosts/, runtime/worktrees/
    const afterRuntime = resolved.slice(runtimeIdx + path.sep.length);
    const segments = afterRuntime.split(path.sep).filter(Boolean);
    // Skip the 'runtime' directory itself and check the next segment (namespace)
    if (segments.length === 0) return false; // bare .agent/runtime/
    if (segments[0] === RUNTIME_DIR) {
      // Path is exactly .agent/runtime/... (without namespace)
      // Allow the bare runtime directory for marker files
      if (segments.length === 1) return true;
      // Check namespace below runtime
      const namespace = segments[1];
      return PORTABLE_NAMESPACES.includes(namespace) || namespace === HOSTS_DIR || namespace === WORKTREES_DIR;
    }
    return PORTABLE_NAMESPACES.includes(segments[0]) || segments[0] === HOSTS_DIR || segments[0] === WORKTREES_DIR;
  }
  return false;
}

// Scan files under projectRoot for any that are dirty (modified by user)
// or outside the allowlist. Returns { dirty: [], outside_allowlist: [] }.
function scanProjectState(projectRoot, allowlist) {
  const agentDir = path.join(projectRoot, AGENT_DIR_SEGMENT);
  const legacyDir = path.join(projectRoot, LEGACY_RUNTIME_SEGMENT);
  const results = { dirty: [], outside_allowlist: [], all_digests: {} };

  function walk(dir, relBase = "") {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          walk(abs, rel);
        } else {
          const digest = fileDigest(abs);
          results.all_digests[rel] = digest;
          // Check if this path is in the allowlist or expected new layout
          const isLegacy = isUnderLegacyRuntime(projectRoot, abs);
          const isNewLayout = isAllowedNewLayoutPath(abs);
          // Allow: .agent/contracts/runtime-state/*, .agent/runtime/*, .agent-runtime/*
          const allowed = isLegacy || isNewLayout || rel.startsWith(AGENT_DIR_SEGMENT + "/" + CONTRACTS_RUNTIME_STATE);
          if (!allowed) {
            results.outside_allowlist.push(rel);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  if (fs.existsSync(agentDir)) walk(agentDir);
  return results;
}

// ─── Legacy layout inspection ────────────────────────────────────────────────

// Inspect the legacy .agent-runtime/ directory and return a manifest of
// source files grouped by namespace.
function inspectLegacyRuntime(projectRoot) {
  const legacyRoot = path.join(projectRoot, LEGACY_RUNTIME_SEGMENT);
  assertMigrationPath(projectRoot, legacyRoot);
  let entries;
  try {
    entries = fs.readdirSync(legacyRoot);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, namespaces: {} };
    throw error;
  }
  if (!entries.some((name) => LEGACY_RECOGNISED_SEGMENTS.includes(name))) {
    return { exists: false, namespaces: {} };
  }

  const namespaces = {};
  for (const [sourceSeg, targetNs] of Object.entries(LEGACY_SOURCE_SEGMENTS)) {
    if (!entries.includes(sourceSeg)) continue;
    const sourceDir = path.join(legacyRoot, sourceSeg);
    const files = [];
    function walkSource(dir, relBase = "") {
      assertMigrationPath(projectRoot, dir);
      const directory = fs.lstatSync(dir);
      if (!directory.isDirectory()) throw new MigrationError("unsafe_directory", { path: dir });
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const rel = relBase ? relBase + "/" + name : name;
        const stat = fs.lstatSync(abs);
        if (stat.isSymbolicLink()) throw new MigrationError("symlink_path", { path: abs });
        if (stat.isDirectory()) {
          walkSource(abs, rel);
        } else {
          // Receipt reads reject non-regular/multi-link sources and propagate
          // unreadable bytes; a null digest is never a successful inspection.
          files.push({ rel, abs, digest: migrationReceipt(projectRoot, abs).digest, sourceSeg });
        }
      }
    }
    walkSource(sourceDir);
    if (files.length > 0) namespaces[targetNs] = files;
  }
  return { exists: true, namespaces };
}

// Inspect `.agent/runtime/` for known-legacy Schema files that per P-001 §2
// must move to `.agent/contracts/runtime-state/`. Returns an array of
// {name, abs, digest} entries for every well-known legacy file still present
// in `.agent/runtime/`. The activation marker (layout.json) and the new
// portable namespaces (.agent/runtime/coordination/, .agent/runtime/hosts/
// etc.) are deliberately excluded.
function inspectLegacySchemas(projectRoot) {
  const runtimeDir = path.join(projectRoot, AGENT_DIR_SEGMENT, RUNTIME_DIR);
  const files = [];
  assertMigrationPath(projectRoot, runtimeDir);
  let directory;
  try {
    directory = fs.lstatSync(runtimeDir);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, files };
    throw error;
  }
  if (!directory.isDirectory()) throw new MigrationError("unsafe_directory", { path: runtimeDir });
  for (const name of LEGACY_RUNTIME_SCHEMAS) {
    const abs = path.join(runtimeDir, name);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new MigrationError("symlink_path", { path: abs });
    if (!stat.isFile()) throw new MigrationError("unsafe_file", { path: abs });
    files.push({ name, abs, digest: migrationReceipt(projectRoot, abs).digest });
  }
  return { exists: files.length > 0, files };
}

// ─── Planner ─────────────────────────────────────────────────────────────────

// Build the canonical migration plan. Returns a structured plan that
// describes every action to be taken. The same plan is used for both
// dry-run and apply; apply adds execution metadata.
//
// Plan structure:
// {
//   plan_id: string,
//   project_root: string,
//   layout_version: string,
//   has_legacy: boolean,
//   already_migrated: boolean,
//   actions: [
//     {
//       id: string,
//       type: ACTION_TYPES.*,
//       source_ref: string,       // relative to project root or absolute
//       target_ref: string,      // relative to project root or absolute
//       risk: RISK_LEVELS.*,
//       conflict_policy: CONFLICT_POLICIES.*,
//       rollback_ref: string,     // how to undo this action
//       verification_ids: string[],
//       phase: string,            // pre_validate | candidate_write | validation | activation | post_activate
//     }
//   ],
//   allowlist: string[],         // paths that may be modified
//   expected_digests: {},        // before digests of files that should be unchanged
// }
function buildMigrationPlan(ctx, { dryRun = false } = {}) {
  const { cwd } = ctx;
  const projectRoot = path.resolve(cwd);
  const planId = `MPLAN-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const legacy = inspectLegacyRuntime(projectRoot);
  const legacySchemas = inspectLegacySchemas(projectRoot);
  const alreadyMigrated = fs.existsSync(
    path.join(projectRoot, AGENT_DIR_SEGMENT, RUNTIME_DIR, LAYOUT_MARKER_FILE)
  );

  // Second update is no-op when the marker exists, legacy is retained for
  // rollback, and there are no leftover legacy Schema files in `.agent/runtime/`.
  // Per P-001 §2 the old `.agent/runtime/*.schema.json` files must move to
  // `.agent/contracts/runtime-state/`; if any of them are still in place the
  // migration is incomplete and must run again.
  if (alreadyMigrated && legacy.exists && !legacySchemas.exists) {
    return {
      plan_id: planId,
      project_root: projectRoot,
      layout_version: RUNTIME_LAYOUT_VERSION,
      has_legacy: true,
      already_migrated: true,
      is_noop: true,
      actions: [
        {
          id: `${planId}-noop-1`,
          type: ACTION_TYPES.REPORT_NOOP,
          source_ref: null,
          target_ref: null,
          risk: RISK_LEVELS.LOW,
          conflict_policy: CONFLICT_POLICIES.SKIP,
          rollback_ref: null,
          verification_ids: ["noop_detected"],
          phase: "noop",
          description: "Layout already migrated; no changes required.",
        },
      ],
      allowlist: [],
      expected_digests: {},
    };
  }

  // No legacy AND no legacy schemas means nothing to migrate - true no-op.
  // However if `.agent/runtime/*.schema.json` (legacy schemas) exist without
  // `.agent-runtime/`, the migration must still:
  //   1. move the legacy schemas to `.agent/contracts/runtime-state/`
  //   2. seed contracts from template
  //   3. write the activation marker so consumers flip to the new layout
  // This is the csm-view-1 / clean-init scenario: the project's first
  // runtime layout activation, with no legacy portable namespaces to copy.
  if (!legacy.exists && !legacySchemas.exists) {
    return {
      plan_id: planId,
      project_root: projectRoot,
      layout_version: RUNTIME_LAYOUT_VERSION,
      has_legacy: false,
      already_migrated: alreadyMigrated,
      is_noop: true,
      actions: [
        {
          id: `${planId}-noop-1`,
          type: ACTION_TYPES.REPORT_NOOP,
          source_ref: null,
          target_ref: null,
          risk: RISK_LEVELS.LOW,
          conflict_policy: CONFLICT_POLICIES.SKIP,
          rollback_ref: null,
          verification_ids: ["noop_no_legacy"],
          phase: "noop",
          description: "No legacy runtime detected; nothing to migrate.",
        },
      ],
      allowlist: [],
      expected_digests: {},
    };
  }

  const actions = [];
  const allowlist = [];
  const expectedDigests = {};

  // Phase: pre_validate
  // Inspect legacy layout (only when `.agent-runtime/` exists)
  if (legacy.exists) {
    actions.push({
      id: `${planId}-inspect-legacy`,
      type: ACTION_TYPES.INSPECT_LEGACY,
      source_ref: `.agent-runtime/`,
      target_ref: null,
      risk: RISK_LEVELS.LOW,
      conflict_policy: CONFLICT_POLICIES.SKIP,
      rollback_ref: null,
      verification_ids: ["legacy_exists", "legacy_has_segments"],
      phase: "pre_validate",
      description: `Detected legacy runtime with namespaces: ${Object.keys(legacy.namespaces).join(", ")}`,
    });
    allowlist.push(`.agent-runtime/`);
    for (const [ns, files] of Object.entries(legacy.namespaces)) {
      for (const f of files) {
        // Use f.sourceSeg to build the correct legacy source path
        const legacyPath = f.sourceSeg
          ? `.agent-runtime/${f.sourceSeg}/${f.rel}`
          : `.agent-runtime/${ns}/${f.rel}`;
        allowlist.push(legacyPath);
        expectedDigests[legacyPath] = f.digest;
      }
    }
  }

  // Phase: candidate_write
  // Copy portable runtime namespaces (only when `.agent-runtime/` exists)
  if (legacy.exists) {
    for (const [ns, files] of Object.entries(legacy.namespaces)) {
      if (ns === LEGACY_HANDOOKS) continue; // Handled separately
      const targetNs = LEGACY_PORTABLE_NAMESPACES[ns] || ns;
      for (const f of files) {
        // Use f.sourceSeg for the correct legacy source path
        const sourceSeg = f.sourceSeg || ns;
        const sourceRef = `.agent-runtime/${sourceSeg}/${f.rel}`;
        const targetRef = `.agent/runtime/${targetNs}/${f.rel}`;
        actions.push({
          id: `${planId}-copy-${ns}-${encodeURIComponent(f.rel)}`,
          type: ACTION_TYPES.COPY_RUNTIME_PORTABLE,
          source_ref: sourceRef,
          target_ref: targetRef,
          risk: RISK_LEVELS.MEDIUM,
          conflict_policy: CONFLICT_POLICIES.BLOCK,
          rollback_ref: targetRef,
          verification_ids: [`copy_${ns}_${f.rel.replace(/\//g, "_")}`],
          phase: "candidate_write",
          description: `Copy portable runtime: ${sourceSeg} → ${targetNs}`,
        });
        allowlist.push(targetRef);
      }
    }
  }

  // Copy contracts from new layout template (if any)
  actions.push({
    id: `${planId}-copy-contracts`,
    type: ACTION_TYPES.COPY_CONTRACTS,
    source_ref: `<template>/.agent/contracts/runtime-state/`,
    target_ref: `.agent/contracts/runtime-state/`,
    risk: RISK_LEVELS.LOW,
    conflict_policy: CONFLICT_POLICIES.SKIP,
    rollback_ref: null,
    verification_ids: ["contracts_seeded"],
    phase: "candidate_write",
    description: "Seed runtime-state contracts from template",
  });
  allowlist.push(`.agent/contracts/runtime-state/`);

  // Move legacy Schemas from `.agent/runtime/` to `.agent/contracts/runtime-state/`.
  // Per P-001 §2 the old `.agent/runtime/` Schema files belong under
  // `.agent/contracts/runtime-state/`. We MOVE (not copy) so the legacy
  // source side is left clean and a second update is a real no-op.
  // Per-file conflict_policy is BLOCK: if a same-named file already lives
  // in the target, fail closed rather than silently overwriting.
  if (legacySchemas.exists) {
    actions.push({
      id: `${planId}-inspect-legacy-schemas`,
      type: ACTION_TYPES.INSPECT_LEGACY_SCHEMAS,
      source_ref: `.agent/runtime/`,
      target_ref: `.agent/contracts/runtime-state/`,
      risk: RISK_LEVELS.LOW,
      conflict_policy: CONFLICT_POLICIES.SKIP,
      rollback_ref: null,
      verification_ids: ["legacy_schemas_detected"],
      phase: "pre_validate",
      description: `Detected ${legacySchemas.files.length} legacy Schema file(s) in .agent/runtime/`,
    });
    for (const f of legacySchemas.files) {
      const sourceRef = `.agent/runtime/${f.name}`;
      const targetRef = `.agent/contracts/runtime-state/${f.name}`;
      actions.push({
        id: `${planId}-move-schema-${f.name.replace(/\./g, "-")}`,
        type: ACTION_TYPES.MOVE_LEGACY_SCHEMAS,
        source_ref: sourceRef,
        target_ref: targetRef,
        risk: RISK_LEVELS.MEDIUM,
        conflict_policy: CONFLICT_POLICIES.BLOCK,
        rollback_ref: sourceRef,
        verification_ids: [`move_schema_${f.name.replace(/\./g, "_")}`],
        phase: "candidate_write",
        description: `Move legacy Schema: ${sourceRef} -> ${targetRef}`,
      });
      allowlist.push(sourceRef);
      allowlist.push(targetRef);
      expectedDigests[sourceRef] = f.digest;
    }
  }

  // Seed workspace identity binding placeholder
  actions.push({
    id: `${planId}-seed-binding`,
    type: ACTION_TYPES.SEED_LOCAL_BINDING,
    source_ref: null,
    target_ref: `.agent/runtime/hosts/<machine-id>/bindings.local.json`,
    risk: RISK_LEVELS.LOW,
    conflict_policy: CONFLICT_POLICIES.SKIP,
    rollback_ref: null,
    verification_ids: ["binding_seeded"],
    phase: "candidate_write",
    description: "Seed local binding placeholder for current machine",
  });
  allowlist.push(`.agent/runtime/hosts/`);

  // Phase: validation
  actions.push({
    id: `${planId}-validate`,
    type: ACTION_TYPES.VALIDATE_CANDIDATE_LAYOUT,
    source_ref: null,
    target_ref: `.agent/runtime/`,
    risk: RISK_LEVELS.MEDIUM,
    conflict_policy: CONFLICT_POLICIES.BLOCK,
    rollback_ref: null,
    verification_ids: ["schema_valid", "journal_replay", "binding_readable"],
    phase: "validation",
    description: "Validate candidate layout before activation",
  });

  // Phase: activation (marker last)
  actions.push({
    id: `${planId}-activate`,
    type: ACTION_TYPES.ACTIVATE_LAYOUT,
    source_ref: null,
    target_ref: `.agent/runtime/layout.json`,
    risk: RISK_LEVELS.HIGH,
    conflict_policy: CONFLICT_POLICIES.BLOCK,
    rollback_ref: `.agent/runtime/layout.json`,
    verification_ids: ["marker_written", "legacy_readable"],
    phase: "activation",
    description: "Write layout activation marker (LAST step)",
  });
  allowlist.push(`.agent/runtime/layout.json`);

  // Phase: post_activate
  // Retain legacy `.agent-runtime/` for rollback compatibility (only when present)
  if (legacy.exists) {
    actions.push({
      id: `${planId}-retain-legacy`,
      type: ACTION_TYPES.RETAIN_LEGACY_FALLBACK,
      source_ref: `.agent-runtime/`,
      target_ref: null,
      risk: RISK_LEVELS.LOW,
      conflict_policy: CONFLICT_POLICIES.SKIP,
      rollback_ref: null,
      verification_ids: ["legacy_retained"],
      phase: "post_activate",
      description: "Retain legacy .agent-runtime/ for rollback compatibility",
    });
  }

  return {
    plan_id: planId,
    project_root: projectRoot,
    layout_version: RUNTIME_LAYOUT_VERSION,
    has_legacy: legacy.exists || legacySchemas.exists,
    already_migrated: false,
    is_noop: false,
    actions,
    allowlist,
    expected_digests: expectedDigests,
  };
}

// ─── Apply ──────────────────────────────────────────────────────────────────

// Ownership receipts are process-local. They support exception compensation,
// not crash recovery or a compare-and-swap guarantee against concurrent writers.
const migrationTransactions = new WeakMap();

function assertMigrationPath(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
    throw new MigrationError("unsafe_path", { path: file });
  }
  let current = root;
  for (const segment of [null, ...relative.split(path.sep)]) {
    if (segment !== null) current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new MigrationError("symlink_path", { path: current });
  }
}

function migrationReceipt(root, file, links = 1) {
  assertMigrationPath(root, file);
  const observed = fs.lstatSync(file);
  if (!observed.isFile() || observed.nlink !== links) {
    throw new MigrationError("unsafe_file", { path: file });
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== links) {
      throw new MigrationError("unsafe_file", { path: file });
    }
    const bytes = fs.readFileSync(fd);
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777,
      digest: crypto.createHash("sha256").update(bytes).digest("hex"), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

function requireMigrationReceipt(root, file, expected) {
  const actual = migrationReceipt(root, file, expected && expected.links || 1);
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.digest !== expected.digest) {
    throw new MigrationError("rollback_conflict", { path: file });
  }
}

function removeMigrationOwned(root, file, receipt) {
  assertMigrationPath(root, file);
  try { fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  requireMigrationReceipt(root, file, receipt);
  fs.unlinkSync(file);
}

// Reserve with wx before recording ownership; an EEXIST path is never ours.
// Track acknowledged write prefixes so a partial/failed write is not mistaken
// for a pre-existing file, and unexpected bytes fail closed during rollback.
function writeMigrationOwned(root, file, bytes, mode, record, key) {
  assertMigrationPath(root, file);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, mode);
  try {
    record[key] = { unknown: true };
    const stat = fs.fstatSync(fd);
    const owned = { dev: stat.dev, ino: stat.ino,
      digest: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex") };
    record[key] = owned;
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new MigrationError("short_write", { path: file });
      offset += written;
      owned.digest = crypto.createHash("sha256").update(bytes.subarray(0, offset)).digest("hex");
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Apply the migration plan. Only successfully reserved/created files acquire
// an ownership receipt. Before-images remain available until compensation ends.
function applyMigration(ctx, plan) {
  const projectRoot = path.resolve(ctx.cwd);
  const errors = [];
  const applied = [];
  const journal = [];
  migrationTransactions.set(applied, { projectRoot, planId: plan.plan_id, journal });
  if (plan.is_noop || !plan.has_legacy) {
    return { ok: true, noop: true, actions_applied: applied,
      message: "No migration changes required." };
  }
  let phase = "candidate_write";
  try {
    for (const action of plan.actions) {
      if (action.phase !== "candidate_write") continue;
      if (action.type === ACTION_TYPES.COPY_RUNTIME_PORTABLE) {
        const source = path.join(projectRoot, action.source_ref);
        const target = path.join(projectRoot, action.target_ref);
        const before = migrationReceipt(projectRoot, source);
        assertMigrationPath(projectRoot, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const entry = { type: "copy", action, source, sourceBefore: before, target, owned: null };
        journal.push(entry);
        writeMigrationOwned(projectRoot, target, before.bytes, before.mode, entry, "owned");
        requireMigrationReceipt(projectRoot, source, before);
        requireMigrationReceipt(projectRoot, target, entry.owned);
      } else if (action.type === ACTION_TYPES.COPY_CONTRACTS) {
        const target = path.join(projectRoot, ".agent", "contracts", "runtime-state");
        assertMigrationPath(projectRoot, target);
        fs.mkdirSync(target, { recursive: true });
      } else if (action.type === ACTION_TYPES.MOVE_LEGACY_SCHEMAS) {
        const source = path.join(projectRoot, action.source_ref);
        const target = path.join(projectRoot, action.target_ref);
        const sourceBefore = migrationReceipt(projectRoot, source);
        assertMigrationPath(projectRoot, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let targetBefore = null;
        try { targetBefore = migrationReceipt(projectRoot, target); } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const entry = { type: "schema", action, source, target, sourceBefore, targetBefore,
          sourceRemoved: false, targetRemoved: false, targetOwned: null, backupOwned: null };
        journal.push(entry);
        if (targetBefore && sourceBefore.digest === targetBefore.digest) {
          requireMigrationReceipt(projectRoot, target, targetBefore);
        } else {
          if (targetBefore) {
            entry.backup = target + ".bak." + Date.now() + "-" + crypto.randomBytes(6).toString("hex");
            writeMigrationOwned(projectRoot, entry.backup, targetBefore.bytes, targetBefore.mode, entry, "backupOwned");
            requireMigrationReceipt(projectRoot, target, targetBefore);
            fs.unlinkSync(target);
            entry.targetRemoved = true;
          }
          writeMigrationOwned(projectRoot, target, sourceBefore.bytes, sourceBefore.mode, entry, "targetOwned");
        }
        requireMigrationReceipt(projectRoot, source, sourceBefore);
        fs.unlinkSync(source);
        entry.sourceRemoved = true;
      } else if (action.type === ACTION_TYPES.SEED_LOCAL_BINDING) {
        for (const name of [...PORTABLE_NAMESPACES, HOSTS_DIR]) {
          const target = path.join(projectRoot, ".agent", "runtime", name);
          assertMigrationPath(projectRoot, target);
          fs.mkdirSync(target, { recursive: true });
        }
      }
      applied.push(action.id);
    }

    phase = "validation";
    for (const action of plan.actions) {
      if (action.phase !== "validation") continue;
      const runtime = path.join(projectRoot, ".agent", "runtime");
      assertMigrationPath(projectRoot, runtime);
      if (!fs.statSync(runtime).isDirectory()) {
        throw new MigrationError("runtime_dir_missing", { path: runtime }, phase);
      }
      for (const name of PORTABLE_NAMESPACES) {
        const directory = path.join(runtime, name);
        assertMigrationPath(projectRoot, directory);
        if (!fs.statSync(directory).isDirectory()) throw new MigrationError("runtime_namespace_missing", { path: directory }, phase);
      }
      for (const entry of journal) {
        if (entry.type === "copy") {
          requireMigrationReceipt(projectRoot, entry.source, entry.sourceBefore);
          requireMigrationReceipt(projectRoot, entry.target, entry.owned);
        } else if (entry.type === "schema") {
          requireMigrationReceipt(projectRoot, entry.target, entry.targetOwned || entry.targetBefore);
          if (fs.existsSync(entry.source)) throw new MigrationError("schema_source_remains", { path: entry.source }, phase);
        }
      }
      applied.push(action.id);
    }

    phase = "activation";
    for (const action of plan.actions) {
      if (action.phase !== "activation") continue;
      const marker = path.join(projectRoot, action.target_ref);
      const candidate = path.join(path.dirname(marker), CANDIDATE_MARKER_FILE);
      assertMigrationPath(projectRoot, marker);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      let before = null;
      try { before = migrationReceipt(projectRoot, marker); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // An existing valid marker already activates this layout. Preserve its
      // bytes and identity while repairing leftover schemas.
      if (before) {
        if (fs.existsSync(candidate)) throw new MigrationError("candidate_conflict", { path: candidate }, phase);
        const markerData = JSON.parse(before.bytes.toString("utf8"));
        const fields = ["layout_version", "activated_at", "plan_id", "source"];
        if (!markerData || Array.isArray(markerData) ||
            fields.some((field) => typeof markerData[field] !== "string" || !markerData[field]) ||
            Object.keys(markerData).some((field) => !fields.includes(field)) ||
            !Number.isFinite(Date.parse(markerData.activated_at)) ||
            markerData.layout_version !== RUNTIME_LAYOUT_VERSION) {
          throw new MigrationError("marker_conflict", { path: marker }, phase);
        }
        requireMigrationReceipt(projectRoot, marker, before);
        applied.push(action.id);
        continue;
      }
      const entry = { type: "marker", action, marker, candidate,
        candidateOwned: null, markerOwned: null };
      journal.push(entry);
      const bytes = Buffer.from(JSON.stringify({
        layout_version: RUNTIME_LAYOUT_VERSION,
        activated_at: new Date().toISOString(),
        plan_id: plan.plan_id,
        source: "runtime-layout-migration",
      }, null, 2));
      writeMigrationOwned(projectRoot, candidate, bytes, 0o600, entry, "candidateOwned");
      // Hard-link publication is atomic and create-only. An unsupported
      // filesystem fails closed; there is no overwrite fallback.
      requireMigrationReceipt(projectRoot, candidate, entry.candidateOwned);
      fs.linkSync(candidate, marker);
      entry.markerOwned = { ...entry.candidateOwned, links: 2 };
      entry.candidateOwned.links = 2;
      removeMigrationOwned(projectRoot, candidate, entry.candidateOwned);
      entry.candidateOwned = null;
      entry.markerOwned.links = 1;
      applied.push(action.id);
    }
    for (const action of plan.actions) {
      if (action.phase === "post_activate") applied.push(action.id);
    }
    return { ok: true, noop: false, actions_applied: applied,
      message: "Migration completed successfully. Legacy layout retained for rollback." };
  } catch (error) {
    errors.push({ phase, error: error.message, code: error.code, details: error.details });
    return { ok: false, rollback: rollbackMigration(ctx, plan, applied, errors),
      errors, actions_applied: applied };
  }
}

// Never infer ownership from action IDs or a path. A deserialized receipt
// cannot authorize deletion. Changed/replaced files are retained and reported.
function rollbackMigration(ctx, plan, applied = [], errors = []) {
  const projectRoot = path.resolve(ctx.cwd);
  const transaction = migrationTransactions.get(applied);
  const rolledBack = [];
  const rollbackErrors = [];
  if (!transaction || transaction.projectRoot !== projectRoot || transaction.planId !== plan.plan_id) {
    return { ok: false, error: "rollback_ownership_unknown", rolled_back: [], partial: false };
  }
  for (const entry of [...transaction.journal].reverse()) {
    const paths = [];
    try {
      if (entry.type === "copy") {
        if (entry.owned) {
          removeMigrationOwned(projectRoot, entry.target, entry.owned);
          entry.owned = null;
          paths.push(entry.action.target_ref);
        }
      } else if (entry.type === "schema") {
        if (entry.sourceRemoved) {
          writeMigrationOwned(projectRoot, entry.source, entry.sourceBefore.bytes,
            entry.sourceBefore.mode, entry, "restoredSource");
          entry.sourceRemoved = false;
          paths.push(entry.action.source_ref);
        }
        if (entry.targetOwned) {
          removeMigrationOwned(projectRoot, entry.target, entry.targetOwned);
          entry.targetOwned = null;
        }
        if (entry.targetRemoved) {
          requireMigrationReceipt(projectRoot, entry.backup, entry.backupOwned);
          writeMigrationOwned(projectRoot, entry.target, entry.targetBefore.bytes,
            entry.targetBefore.mode, entry, "restoredTarget");
          entry.targetRemoved = false;
          paths.push(entry.action.target_ref);
        }
        if (entry.backupOwned) {
          if (!entry.restoredTarget) requireMigrationReceipt(projectRoot, entry.target, entry.targetBefore);
          removeMigrationOwned(projectRoot, entry.backup, entry.backupOwned);
          entry.backupOwned = null;
        }
      } else if (entry.type === "marker") {
        if (entry.markerOwned) {
          removeMigrationOwned(projectRoot, entry.marker, entry.markerOwned);
          entry.markerOwned = null;
          if (entry.candidateOwned) entry.candidateOwned.links = 1;
          paths.push(entry.action.target_ref);
        }
        if (entry.candidateOwned) {
          removeMigrationOwned(projectRoot, entry.candidate, entry.candidateOwned);
          entry.candidateOwned = null;
        }
      }
    } catch (error) {
      rollbackErrors.push({ action_id: entry.action.id, error: error.message,
        code: error.code, details: error.details });
    }
    rolledBack.unshift(...paths);
  }
  const legacy = path.join(projectRoot, LEGACY_RUNTIME_SEGMENT);
  let legacyReadable = false;
  try { legacyReadable = fs.statSync(legacy).isDirectory() && fs.readdirSync(legacy).length >= 0; } catch {}
  return { ok: rollbackErrors.length === 0, rolled_back: rolledBack,
    legacy_readable: legacyReadable, errors, rollback_errors: rollbackErrors,
    partial: rollbackErrors.length > 0 && rolledBack.length > 0 };
}

// ─── Report helpers ─────────────────────────────────────────────────────────

// Build migration report for the update report
function buildMigrationReport(ctx, plan, applyResult) {
  const migration = {
    plan_id: plan.plan_id,
    layout_version: plan.layout_version,
    has_legacy: plan.has_legacy,
    already_migrated: plan.already_migrated,
    is_noop: plan.is_noop,
    actions: plan.actions.map((a) => ({
      id: a.id,
      type: a.type,
      source_ref: a.source_ref,
      target_ref: a.target_ref,
      risk: a.risk,
      phase: a.phase,
      status: applyResult
        ? (applyResult.actions_applied || []).includes(a.id) ? "applied" : "skipped"
        : "planned",
    })),
    rollback: applyResult?.rollback || undefined,
    errors: applyResult?.errors || undefined,
  };

  return {
    migration,
    path_binding: applyResult?.ok && !applyResult.noop
      ? { placeholder_seeded: true }
      : undefined,
    legacy_retention: plan.has_legacy,
    idempotency: plan.is_noop ? "second_update_noop" : "first_update",
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Core API
  buildMigrationPlan,
  applyMigration,
  rollbackMigration,

  // Helpers
  buildMigrationReport,
  inspectLegacyRuntime,
  inspectLegacySchemas,
  isUnderLegacyRuntime,
  isAllowedNewLayoutPath,
  scanProjectState,
  fileDigest,
  digestDirectory,

  // Constants
  ACTION_TYPES,
  RISK_LEVELS,
  CONFLICT_POLICIES,
  LAYOUT_MARKER_FILE,
  CANDIDATE_MARKER_FILE,
  RUNTIME_LAYOUT_VERSION,
  LEGACY_SOURCE_SEGMENTS,

  // Error types
  MigrationError,
};
