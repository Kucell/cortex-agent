"use strict";

// ─── plugin-converter — open-design.json → cortex-agent plugin manifest ───────
//
// Translates an upstream open-design plugin's open-design.json into the
// cortex-agent plugin manifest shape (M-002 MS-003 lib/agents/registry.js).
//
// Why two files:
//   - open-design.json is the upstream schema (Apache-2.0, richer — od.kind,
//     od.taskKind, od.mode, od.capabilities[], od.inputs[]).
//   - cortex-agent plugin manifest is the local schema consumed by `cortex-agent
//     plugin install <id>` (M-002).
//
// The original open-design.json is preserved at <id>/open-design.json for audit.
// The converted manifest is written to <id>/manifest.json for cortex-agent
// runtime.
//
// Conversion is deterministic, idempotent, and lossless for fields cortex-agent
// understands (mode / capabilities / inputs / taskKind / license). Unknown
// fields are preserved in `x-open-design` to avoid data loss.

const { KINDS, getKind } = require("./kind-map");

const REQUIRED_OPEN_DESIGN_FIELDS = ["od.kind", "od.name", "od.version"];
const SUPPORTED_OD_KINDS = new Set(["plugin", "skill"]);

/**
 * Validate an open-design.json object. Returns `{ ok: true }` or
 * `{ ok: false, reason }`.
 */
function validateOpenDesign(od) {
  if (!od || typeof od !== "object") {
    return { ok: false, reason: "open-design.json must be an object" };
  }
  for (const f of REQUIRED_OPEN_DESIGN_FIELDS) {
    const v = f.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), od);
    if (v == null || (typeof v === "string" && v.length === 0)) {
      return { ok: false, reason: `missing required field "${f}"` };
    }
  }
  if (!SUPPORTED_OD_KINDS.has(od.od.kind)) {
    return {
      ok: false,
      reason: `od.kind "${od.od.kind}" not in supported set (${[...SUPPORTED_OD_KINDS].join(", ")})`,
    };
  }
  return { ok: true };
}

/**
 * Convert a parsed open-design.json into a cortex-agent plugin manifest.
 *
 * @param {object} od          parsed open-design.json
 * @param {{ license?: string }} [overrides]
 * @returns {object} cortex-agent plugin manifest
 */
function toCortexAgentManifest(od, overrides) {
  overrides = overrides || {};
  const check = validateOpenDesign(od);
  if (!check.ok) {
    throw new Error(`plugin-converter: invalid open-design.json — ${check.reason}`);
  }

  const license = overrides.license || od.license || getKind("plugin").licenseDefault;
  const id = (od.od.name || "").replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
  // Reject when sanitization leaves no usable alphanumeric chars
  // (e.g. name = "   " or "!!!").
  if (!/[a-z0-9]/.test(id)) {
    throw new Error("plugin-converter: od.name must produce a non-empty id");
  }

  const capabilities = Array.isArray(od.od.capabilities) ? od.od.capabilities.slice() : [];
  const inputs = Array.isArray(od.od.inputs) ? od.od.inputs.slice() : [];

  const manifest = {
    schemaVersion: "1.0",
    id,
    name: od.od.name,
    version: od.od.version,
    description: od.od.description || od.description || "",
    license,
    source: "open-design",
    origin: od.od.repository || od.repository || "https://github.com/nexu-io/open-design",
    mode: od.od.mode || "code",
    taskKind: od.od.taskKind || od.od.kind,
    capabilities,
    inputs,
    installPath: `.agent/plugins/${id}`,
    convertedAt: new Date().toISOString(),
  };

  // Preserve unknown / open-design-specific fields for audit.
  const knownKeys = new Set([
    "kind",
    "name",
    "version",
    "description",
    "mode",
    "taskKind",
    "capabilities",
    "inputs",
    "repository",
  ]);
  const xOpenDesign = {};
  for (const k of Object.keys(od.od)) {
    if (!knownKeys.has(k)) xOpenDesign[k] = od.od[k];
  }
  if (Object.keys(xOpenDesign).length > 0) {
    manifest["x-open-design"] = xOpenDesign;
  }

  return manifest;
}

/**
 * Reverse — given a cortex-agent manifest, reconstruct the minimal open-design
 * shape. Useful for round-trip validation tests.
 */
function fromCortexAgentManifest(manifest) {
  if (!manifest || manifest.source !== "open-design") {
    return null;
  }
  return {
    od: {
      kind: manifest.taskKind || "plugin",
      name: manifest.name || manifest.id,
      version: manifest.version || "0.0.0",
      mode: manifest.mode || "code",
      taskKind: manifest.taskKind,
      capabilities: manifest.capabilities || [],
      inputs: manifest.inputs || [],
    },
    license: manifest.license,
  };
}

/**
 * Decide whether a path under an open-design repo is a plugin (vs skill vs
 * template). Heuristic — uses the upstream directory name convention:
 *   plugins/_official/<id>/open-design.json   → plugin
 *   skills/<id>/SKILL.md                       → skill
 *   design-templates/<id>/SKILL.md             → template
 *
 * Returns the kind or null when unrecognised.
 */
function kindFromOpenDesignPath(upstreamPath) {
  const parts = String(upstreamPath || "").split("/");
  if (parts.length < 2) return null;
  const top = parts[0];
  if (top === "plugins" || top === "plugins/_official" || top === "plugins/community") {
    return "plugin";
  }
  if (top === "skills") return "skill";
  if (top === "design-templates") return "template";
  if (top === "design-systems") return "design-system";
  return null;
}

module.exports = {
  validateOpenDesign,
  toCortexAgentManifest,
  fromCortexAgentManifest,
  kindFromOpenDesignPath,
  SUPPORTED_OD_KINDS,
  REQUIRED_OPEN_DESIGN_FIELDS,
};