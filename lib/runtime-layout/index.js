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
};