"use strict";

// ─── kind-map — 4-kind catalog metadata (P-001 MS-002) ────────────────────────
//
// Maps each of the 4 catalog kinds to its upstream directory, install target
// path, license field locations, and per-kind manifest schema. This is the
// single source of truth that registry / fetch / lockfile / license / cli
// all consult. Adding a 5th kind requires only editing this file.
//
// Kinds:
//   design-system  — T-OD-001 frozen (lib/design/*) — install → <cwd>/.agent/design-systems/<id>/
//   plugin         — open-design plugin (open-design.json) → <cwd>/.agent/plugins/<id>/
//   skill          — Agent Skills convention (SKILL.md) → <cwd>/.agent/skills/<id>/
//   template       — open-design design-template (SKILL.md + index.html) → <cwd>/.agent/templates/<id>/

const fs = require("node:fs");
const path = require("node:path");

const KINDS = Object.freeze({
  "design-system": {
    kind: "design-system",
    upstreamSubdir: "design-systems",
    installDir: ".agent/design-systems",
    manifestFilename: "DESIGN.md",
    licenseSources: [
      "manifest.json#/license",
      "manifest.json#/license.spdx",
      "DESIGN.md#frontmatter/license",
    ],
    licenseDefault: "Apache-2.0",
    schemaVersion: "od-design-system-project/v1",
    lockfileKindKey: "design-system",
    capabilitiesCascade: true,
    pluginConverter: null,
  },
  plugin: {
    kind: "plugin",
    upstreamSubdir: "plugins",
    installDir: ".agent/plugins",
    manifestFilename: "manifest.json",
    licenseSources: [
      "open-design.json#/license",
      "open-design.json#/compat/license",
      "SKILL.md#frontmatter/license",
    ],
    licenseDefault: "Apache-2.0",
    schemaVersion: "od-plugin-project/v1",
    lockfileKindKey: "plugin",
    capabilitiesCascade: false,
    pluginConverter: "lib/catalog/plugin-converter.js",
  },
  skill: {
    kind: "skill",
    upstreamSubdir: "skills",
    installDir: ".agent/skills",
    manifestFilename: "SKILL.md",
    licenseSources: [
      "SKILL.md#frontmatter/license",
    ],
    licenseDefault: "Apache-2.0",
    schemaVersion: "od-skill-project/v1",
    lockfileKindKey: "skill",
    capabilitiesCascade: false,
    pluginConverter: null,
  },
  template: {
    kind: "template",
    upstreamSubdir: "design-templates",
    installDir: ".agent/templates",
    manifestFilename: "SKILL.md",
    licenseSources: [
      "SKILL.md#frontmatter/license",
      "template.json#/license",
    ],
    licenseDefault: "Apache-2.0",
    schemaVersion: "od-template-project/v1",
    lockfileKindKey: "template",
    capabilitiesCascade: false,
    pluginConverter: null,
  },
});

const KIND_LIST = Object.freeze(Object.keys(KINDS));

function getKind(kind) {
  if (!KINDS[kind]) {
    throw new Error(
      `kind-map: unknown kind "${kind}". Valid: ${KIND_LIST.join(", ")}`,
    );
  }
  return KINDS[kind];
}

function hasKind(kind) {
  return Boolean(KINDS[kind]);
}

/**
 * Resolve the absolute install path for a kind + id.
 * @param {string} kind  one of the 4 KIND_LIST values
 * @param {string} id    catalog id (kebab-case)
 * @param {string} cwd   project root (defaults to process.cwd())
 * @returns {string}
 */
function resolveInstallPath(kind, id, cwd) {
  const meta = getKind(kind);
  cwd = cwd || process.cwd();
  if (!id || /[\\/\x00-\x1f]/.test(id)) {
    throw new Error(`kind-map: invalid id "${id}" for kind ${kind}`);
  }
  return path.join(cwd, meta.installDir, id);
}

/**
 * Walk licenseSources in order and return the first match. Each source is
 * parsed as `<file>#<jsonPointer>` syntax. Returns null when nothing resolves.
 *
 * @param {string} kind
 * @param {Record<string, object>} fileTree  filename → parsed JSON / object
 * @returns {{ value: string, source: string } | null}
 */
function resolveLicense(kind, fileTree) {
  const meta = getKind(kind);
  for (const source of meta.licenseSources) {
    const [file, pointer] = source.split("#");
    const parsed = fileTree && fileTree[file];
    if (!parsed) continue;
    const value = readPointer(parsed, pointer || "/");
    if (typeof value === "string" && value.length > 0) {
      return { value, source };
    }
  }
  return null;
}

function readPointer(obj, pointer) {
  // JSON-pointer-ish walker. /a/b/c → obj.a.b.c. Empty pointer returns root.
  if (!pointer || pointer === "/") return obj;
  const parts = pointer.split("/").filter((p) => p.length > 0);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Determine the kind from an upstream entry's path. Heuristic — maps the
 * top-level subdirectory of the upstream tree to its kind. Handles the
 * plural upstreamSubdir convention (`design-systems/` → `design-system`).
 * @param {string} upstreamPath  e.g. "design-systems/linear-app/manifest.json"
 * @returns {string | null}
 */
function kindFromPath(upstreamPath) {
  const first = String(upstreamPath || "").split("/")[0];
  if (!first) return null;
  // Direct match first (covers plugin / skill / template which are 1:1).
  if (hasKind(first)) return first;
  // Plural subdir → singular kind.
  for (const kind of KIND_LIST) {
    if (KINDS[kind].upstreamSubdir === first) return kind;
  }
  return null;
}

/**
 * Default catalog listing per kind — used by registry when upstream
 * enumeration fails (offline / no network). Pre-populated with the well-known
 * starter ids that cortex-agent ships out of the box.
 */
const STARTER_IDS = Object.freeze({
  "design-system": Object.freeze(["default", "linear-app", "stripe"]),
  plugin: Object.freeze(["od-figma-migration", "od-claude-design-bridge"]),
  skill: Object.freeze(["open-design-launch-checklist", "design-system-cascade"]),
  template: Object.freeze(["saas-landing", "guizang-ppt", "html-ppt-master"]),
});

function getStarterIds(kind) {
  return STARTER_IDS[kind] || [];
}

/**
 * Lightweight file-existence check used by fetch.js to decide if a kind
 * supports a given install dir (some kinds have sidecar files).
 */
function requiredFiles(kind) {
  const meta = getKind(kind);
  return [meta.manifestFilename];
}

module.exports = {
  KINDS,
  KIND_LIST,
  getKind,
  hasKind,
  resolveInstallPath,
  resolveLicense,
  kindFromPath,
  getStarterIds,
  requiredFiles,
  STARTER_IDS,
  // exposed for tests
  _internal: { readPointer },
};