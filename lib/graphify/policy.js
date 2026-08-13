"use strict";

/**
 * Graphify governance policy (T-GWG-001 / P-001 §4.1).
 *
 * Every project that opts in carries a policy block. Default is advisory,
 * which keeps Cortex Agent usable when Graphify is absent or stale but
 * still surfaces the recommendation. `required-for-topology` only gates
 * topology-shaped tasks (cross-module/call-chain/architecture) and never
 * blocks single-file precise queries.
 *
 * Policy is loaded from `.agent/plugins/graphify/config.yml` if present,
 * otherwise from the project's `governance:` block. When neither exists
 * the defaults below apply.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_POLICY = Object.freeze({
  mode: "advisory",
  max_age_days: 7,
  allow_primary_worktree_fallback: true,
  require_branch_delta_readback: true,
});

const MODES = new Set(["off", "advisory", "required-for-topology"]);

function loadPolicy({ projectRoot, pluginConfigPath, lang = "en" }) {
  const baseDefaults = { ...DEFAULT_POLICY };
  // Source precedence (lowest → highest): defaults → plugin config.yml
  // `governance:` block. We intentionally do NOT auto-promote policy from
  // a shared template; project-local opt-in is required.
  let merged = { ...baseDefaults };
  let yamlError = false;
  if (pluginConfigPath && fs.existsSync(pluginConfigPath)) {
    try {
      const text = fs.readFileSync(pluginConfigPath, "utf8");
      const parsed = parseSimpleYaml(text);
      if (parsed && parsed.__malformed) {
        yamlError = true;
      } else if (parsed && parsed.governance && typeof parsed.governance === "object") {
        merged = { ...merged, ...parsed.governance };
      }
    } catch (_) {
      yamlError = true;
    }
  }
  // Apply local override from `.agent/plugins/graphify/policy.local.yml`
  // if present. This is the documented per-project opt-in hook.
  if (projectRoot) {
    const localOverride = path.join(
      projectRoot, ".agent", "plugins", "graphify", "policy.local.yml",
    );
    if (fs.existsSync(localOverride)) {
      try {
        const parsed = parseSimpleYaml(fs.readFileSync(localOverride, "utf8"));
        if (parsed && parsed.__malformed) {
          yamlError = true;
        } else if (parsed && typeof parsed === "object") {
          merged = { ...merged, ...parsed };
        }
      } catch (_) {
        yamlError = true;
      }
    }
  }
  // Sanitize + validate.
  const mode = MODES.has(merged.mode) ? merged.mode : "advisory";
  const maxAge = Number.isFinite(merged.max_age_days) && merged.max_age_days > 0
    ? merged.max_age_days
    : 7;
  return {
    mode,
    max_age_days: maxAge,
    allow_primary_worktree_fallback: merged.allow_primary_worktree_fallback !== false,
    require_branch_delta_readback: merged.require_branch_delta_readback !== false,
    source: {
      pluginConfig: Boolean(pluginConfigPath && fs.existsSync(pluginConfigPath)),
      localOverride: projectRoot
        ? fs.existsSync(path.join(projectRoot, ".agent", "plugins", "graphify", "policy.local.yml"))
        : false,
    },
    _yamlError: yamlError,
  };
}

/**
 * Decide whether a task type is gated by `required-for-topology`. Single
 * file / symbol queries fall through regardless of mode.
 */
function topologyGated({ mode, taskKind }) {
  if (mode === "off") return false;
  if (mode === "advisory") return false;
  if (mode === "required-for-topology") {
    return ["cross_module", "call_chain", "architecture", "impact"].includes(taskKind);
  }
  return false;
}

/**
 * Minimal YAML parser for our flat `governance:` blocks. We deliberately
 * avoid pulling in a YAML dependency for a handful of keys.
 */
function parseSimpleYaml(text) {
  if (!text || typeof text !== "string") return null;
  const result = {};
  const lines = text.split(/\r?\n/);
  const stack = [{ indent: -1, obj: result }];
  let i = 0;
  let parsedAnything = false;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    if (!line || /^\s*#/.test(line)) { i += 1; continue; }
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) { i += 1; continue; }
    if (indent > top.indent && stack.length > 1) {
      // nested child — must be on a previous parent line; otherwise skip
      i += 1; continue;
    }
    const m = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) {
      // Malformed line: non-empty content that did not decode as
      // key:value. Mark the document as malformed so the policy loader
      // can fall back to defaults. We keep scanning to leave the stack
      // / indent counters in a sane state.
      i += 1;
      if (trimmed.length > 0) {
        result.__malformed = true;
      }
      continue;
    }
    parsedAnything = true;
    const key = m[1];
    let valueRaw = m[2];
    if (valueRaw === "" || valueRaw === undefined) {
      // nested object — peek next non-empty line
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || /^\s*#/.test(lines[j]))) j += 1;
      const nextIndent = j < lines.length ? (lines[j].match(/^(\s*)/) || ["", ""])[1].length : -1;
      if (j < lines.length && nextIndent > indent) {
        top.obj[key] = {};
        stack.push({ indent, obj: top.obj[key] });
        i += 1; continue;
      } else {
        top.obj[key] = null;
        i += 1; continue;
      }
    }
    // strip comments and quotes
    valueRaw = valueRaw.replace(/\s*#.*$/, "").trim();
    if ((valueRaw.startsWith("\"") && valueRaw.endsWith("\"")) ||
        (valueRaw.startsWith("'") && valueRaw.endsWith("'"))) {
      valueRaw = valueRaw.slice(1, -1);
    }
    if (valueRaw === "true") top.obj[key] = true;
    else if (valueRaw === "false") top.obj[key] = false;
    else if (valueRaw === "null" || valueRaw === "~") top.obj[key] = null;
    else if (/^-?\d+$/.test(valueRaw)) top.obj[key] = parseInt(valueRaw, 10);
    else if (/^-?\d+\.\d+$/.test(valueRaw)) top.obj[key] = parseFloat(valueRaw);
    else top.obj[key] = valueRaw;
    i += 1;
  }
  // Strip the sentinel so consumers never see it.
  if (result.__malformed) {
    return { __malformed: true };
  }
  if (!parsedAnything && Object.keys(result).length === 0) {
    return null;
  }
  return result;
}

module.exports = {
  DEFAULT_POLICY,
  MODES,
  loadPolicy,
  topologyGated,
  parseSimpleYaml,
};