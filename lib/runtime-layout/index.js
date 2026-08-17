"use strict";

// ─── Runtime Layout Module Entry Point (M-026 MS-001) ──────────────────────
//
// Public surface for the runtime layout contract. Consumers should import
// from `lib/runtime-layout` (this index) — never from the implementation
// files — so that adding internal modules later does not break callers.
//
// The module exposes five tightly-scoped surfaces:
//
//   * `resolver.*`  — paths and namespaces, the single source of truth.
//   * `identity.*`  — stable identity factories, equality, and the
//                     "no resolved absolute paths in equality" rule.
//   * `logicalUri.*`— parse / format helpers for the P-001 logical URI
//                     schemes (project/repo/workspace/agent/runtime/
//                     artifact) plus per-scheme conveniences.
//   * `localBinding.*` — the per-host binding store. This is the ONLY
//                        module that legitimately carries absolute paths.
//   * `schemas.*`   — closed validation schemas and the lightweight ajv-
//                     free validator, exported for tests and for the MS-002
//                     migration planner.

const resolver = require("./resolver");
const identity = require("./identity");
const logicalUri = require("./logical-uri");
const localBinding = require("./local-binding");
const schemas = require("./schemas");

module.exports = {
  resolver,
  identity,
  logicalUri,
  localBinding,
  schemas,
  // Convenience re-exports for the most common call sites.
  resolveLayout: resolver.resolveLayout,
  detectLegacyRuntime: resolver.detectLegacyRuntime,
  projectId: identity.projectId,
  repositoryId: identity.repositoryId,
  workspaceId: identity.workspaceId,
  machineId: identity.machineId,
  workspaceInstanceId: identity.workspaceInstanceId,
  parseLogicalUri: logicalUri.parse,
  formatLogicalUri: logicalUri.format,
  openLocalBindingStore: localBinding.openStore,
  // Namespace constants (exported for MS-002 migration planner)
  LEGACY_RUNTIME_SEGMENT: resolver.LEGACY_RUNTIME_SEGMENT,
  AGENT_DIR_SEGMENT: resolver.AGENT_DIR_SEGMENT,
  RUNTIME_DIR: resolver.RUNTIME_DIR,
  HOSTS_DIR: resolver.HOSTS_DIR,
  WORKTREES_DIR: resolver.WORKTREES_DIR,
  HANDOFFS_DIR: resolver.HANDOFFS_DIR,
  CONTRACTS_DIR: resolver.CONTRACTS_DIR,
  CONTRACTS_RUNTIME_STATE: resolver.CONTRACTS_RUNTIME_STATE,
  PORTABLE_NAMESPACES: resolver.PORTABLE_NAMESPACES,
  LEGACY_PORTABLE_NAMESPACES: resolver.LEGACY_PORTABLE_NAMESPACES,
  LEGACY_RECOGNISED_SEGMENTS: resolver.LEGACY_RECOGNISED_SEGMENTS,
  // MS-003 consumer helpers for compatibility window
  isNewLayoutActivated: resolver.isNewLayoutActivated,
  resolveRuntimePaths: resolver.resolveRuntimePaths,
  readWithLegacyFallback: resolver.readWithLegacyFallback,
  resolveWritePath: resolver.resolveWritePath,
  LAYOUT_ACTIVATION_MARKER: resolver.LAYOUT_ACTIVATION_MARKER,
  // Portable path helpers per namespace (convenience)
  portableRuntimePath: resolver.portableRuntimePath,
  // Cross-project namespace paths
  crossProjectPath: (layout) => resolver.portableRuntimePath(layout, "cross-project"),
  // Coordination namespace paths
  coordinationPath: (layout) => resolver.portableRuntimePath(layout, "coordination"),
  // Dispatch namespace paths
  dispatchPath: (layout) => resolver.portableRuntimePath(layout, "dispatch"),
};