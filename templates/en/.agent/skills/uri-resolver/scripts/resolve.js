#!/usr/bin/env node
/**
 * uri-resolver — Resolve cortex:// URIs and paths bidirectionally.
 *
 * The cortex:// protocol is a doc-layer convention (no runtime); it gives
 * `.agent/` references a stable identifier that survives cross-project copy
 * and LLM rewrites. Inspired by OpenViking's viking://.
 *
 * Usage:
 *   node resolve.js --uri "cortex://skills/context-budget"
 *   node resolve.js --path ".agent/skills/context-budget/SKILL.md"
 *   node resolve.js --rebuild                 # refresh `generated_at` + scan new files
 *   node resolve.js --check                   # audit all rules / workflows / skills for relative refs
 *
 * Output: JSON to stdout
 *
 * URI format:
 *   cortex://{scope}/{path...}
 *   scope ∈ {rules, workflows, skills, references, memory, decisions, experiences, resources}
 *
 * Fallback: if a URI can't be resolved (missing scope or file), the resolver
 * still returns a structured result with `ok:false` and `suggestion` —
 * it never throws.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const URI_MAP = path.join(ROOT, ".agent", "registry", "uri-map.json");
const RECOGNIZED_SCOPES = [
  "rules", "workflows", "skills", "references",
  "memory", "decisions", "experiences", "resources",
];

function readMap() {
  if (!fs.existsSync(URI_MAP)) return null;
  return JSON.parse(fs.readFileSync(URI_MAP, "utf8"));
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/**
 * Resolve cortex:// URI → filesystem path.
 */
function resolveUri(uri, map) {
  const out = { ok: false, uri, path: null, scope: null, file: null, suggestion: null };
  if (!uri || typeof uri !== "string") {
    out.suggestion = "uri must be a non-empty string";
    return out;
  }
  if (!uri.startsWith("cortex://")) {
    out.suggestion = `not a cortex:// URI: ${uri}`;
    return out;
  }
  const stripped = uri.slice("cortex://".length);
  const slash = stripped.indexOf("/");
  if (slash === -1) {
    out.suggestion = `URI missing path: ${uri}`;
    return out;
  }
  const scope = stripped.slice(0, slash);
  const rest = stripped.slice(slash + 1);
  if (!RECOGNIZED_SCOPES.includes(scope)) {
    out.suggestion = `unknown scope "${scope}", recognized: ${RECOGNIZED_SCOPES.join(", ")}`;
    return out;
  }
  const root = map && map.scopes && map.scopes[scope];
  if (!root) {
    out.suggestion = `scope "${scope}" not configured in uri-map.json`;
    return out;
  }
  // Try multiple extensions and candidates
  const candidates = buildCandidates(root, rest);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      out.ok = true;
      out.path = path.relative(ROOT, candidate);
      out.scope = scope;
      out.file = rest;
      return out;
    }
  }
  out.scope = scope;
  out.file = rest;
  out.path = path.relative(ROOT, candidates[0] || path.join(root, rest));
  out.suggestion = `no file found for ${uri}; tried ${candidates.length} candidate(s)`;
  return out;
}

function buildCandidates(root, rest) {
  const joined = path.join(root, ...rest.split("/"));
  const list = [joined];
  if (!path.extname(joined)) {
    list.push(joined + ".md");
    list.push(joined + ".json");
    list.push(joined + ".yml");
    list.push(joined + ".yaml");
    list.push(path.join(joined, "SKILL.md"));
    list.push(path.join(joined, "README.md"));
  }
  return list;
}

/**
 * Reverse map: filesystem path → cortex:// URI.
 */
function resolvePath(filePath, map) {
  const out = { ok: false, path: filePath, uri: null, scope: null };
  if (!filePath) return out;
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  const relative = path.relative(ROOT, absolute);
  if (relative.startsWith("..")) {
    out.suggestion = "path is outside project root";
    return out;
  }
  const scopes = (map && map.scopes) || {};
  // Longest-prefix match so `skills/foo` beats `skills` if both exist.
  let best = null;
  let bestLen = -1;
  for (const [scope, root] of Object.entries(scopes)) {
    const prefix = root.replace(/\/$/, "") + "/";
    if (relative === root || relative.startsWith(prefix)) {
      if (root.length > bestLen) {
        best = scope;
        bestLen = root.length;
      }
    }
  }
  if (!best) {
    out.suggestion = `path "${relative}" does not map to any configured scope`;
    return out;
  }
  const root = scopes[best];
  const tail = relative === root ? "" : relative.slice(root.length + 1);
  out.ok = true;
  out.scope = best;
  out.uri = `cortex://${best}/${tail}`;
  return out;
}

/**
 * Rebuild uri-map.json timestamp + scan known directories to confirm scope roots exist.
 */
function rebuildMap() {
  const map = readMap() || { version: 1, scopes: {}, aliases: {} };
  map.generated_at = new Date().toISOString();
  const scan = {};
  for (const [scope, root] of Object.entries(map.scopes || {})) {
    const absolute = path.join(ROOT, root);
    scan[scope] = fs.existsSync(absolute)
      ? { root, exists: true, entries: safeList(absolute) }
      : { root, exists: false, entries: 0 };
  }
  return { ok: true, map, scopes: scan };
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Audit `.agent/` markdown files for relative references to convert to cortex:// URIs.
 * Returns a dry-run report (no file changes).
 */
function auditRefs() {
  const agentRoot = path.join(ROOT, ".agent");
  const report = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(md|json|ya?ml)$/.test(entry.name)) continue;
      const rel = path.relative(ROOT, full);
      // Skip our own registry/index file
      if (rel === ".agent/registry/uri-map.json") continue;
      const text = fs.readFileSync(full, "utf8");
      const matches = extractRelativeRefs(text);
      if (matches.length) {
        report.push({ file: rel, refs: matches });
      }
    }
  }
  walk(agentRoot, 0);
  return { ok: true, total: report.length, files: report };
}

function extractRelativeRefs(text) {
  const out = [];
  // matches `.agent/skills/foo` or `templates/...` — anything starting with a known scope dir
  const re = /`?(\.agent\/[A-Za-z0-9_\-/]+\.[A-Za-z0-9]+)`?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function main() {
  const args = parseArgs();
  const map = readMap();
  if (args.uri) {
    const result = resolveUri(args.uri, map);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.path) {
    const result = resolvePath(args.path, map);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.rebuild) {
    const result = rebuildMap();
    fs.writeFileSync(URI_MAP, JSON.stringify(result.map, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, action: "rebuild", written: URI_MAP, scopes: result.scopes }, null, 2));
    return;
  }
  if (args.check) {
    const result = auditRefs();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(JSON.stringify({
    ok: false,
    error: "missing flag",
    usage: {
      "--uri": "cortex://scope/path",
      "--path": ".agent/.../file.md",
      "--rebuild": "refresh generated_at + scan scope roots",
      "--check": "audit .agent/ markdown for relative refs",
    },
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

module.exports = { resolveUri, resolvePath, rebuildMap, auditRefs };
