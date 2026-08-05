"use strict";

// Test helper: build a `.script-manifest.json` payload whose `scripts` map
// covers every managed L1 template script. Used by the update-fixture tests
// so reconcileScripts never reports `unmanaged_cold_start` for scripts that
// are merely absent from a hand-rolled manifest.
//
// Background:
//   `lib/script-manifest.js:reconcileScripts` walks `templates/{en,_shared}/.agent/**/*.js`
//   and classifies each entry. For files that exist in BOTH `en` and `_shared`
//   with different content, `walkAndAdd` in lib/commands.js copies the shared
//   version first, and the en overlay skips the existing file. The reconcile
//   step then compares the project file's hash against the en template's
//   hash, which is why a manifest entry must record the post-walkAndAdd hash
//   (the shared version) so the entry classifies as `stale_template` and the
//   update applies the en overlay, instead of being left as
//   `unmanaged_cold_start` and tripping the "Safe update partially complete"
//   exit-2 guard.
//
// Usage:
//   const { buildManagedScriptsMap } = require("./helpers/managed-scripts");
//   const scripts = buildManagedScriptsMap(ROOT);
//   // Optionally override a single entry (e.g. F2's "installed" content):
//   scripts[REL] = { origin_hash: sha(installed), sha256: sha(installed) };
//   fs.writeFileSync(path.join(cwd, ".agent", ".script-manifest.json"),
//     JSON.stringify({ schema_version: 1, scripts }, null, 2) + "\n");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..");

function sha(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isManagedScriptName(name) {
  if (!name.endsWith(".js")) return false;
  if (name.endsWith(".bak") || name.endsWith(".bak.prev")) return false;
  return true;
}

function walkManagedScripts(root) {
  const out = new Map();
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && isManagedScriptName(entry.name)) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (!out.has(rel)) out.set(rel, abs);
      }
    }
  };
  walk(root);
  return out;
}

function discoverManagedScripts(root = ROOT) {
  const shared = walkManagedScripts(path.join(root, "templates", "_shared", ".agent"));
  const en = walkManagedScripts(path.join(root, "templates", "en", ".agent"));
  const merged = new Map(shared);
  for (const [rel, abs] of en) merged.set(rel, abs);
  return Array.from(merged.keys()).sort();
}

// Build the `scripts` map for `.script-manifest.json`.
//   - For shared+en duplicates: origin_hash = sha(shared file)
//     (matches the post-walkAndAdd state; the en overlay then re-applies
//      through the `stale_template` action).
//   - For shared-only or en-only scripts: origin_hash = sha(that file).
function buildManagedScriptsMap(root = ROOT) {
  const shared = walkManagedScripts(path.join(root, "templates", "_shared", ".agent"));
  const en = walkManagedScripts(path.join(root, "templates", "en", ".agent"));
  const rels = new Set([...shared.keys(), ...en.keys()]);
  const out = {};
  for (const rel of rels) {
    const abs = shared.has(rel) ? shared.get(rel) : en.get(rel);
    const hash = sha(fs.readFileSync(abs));
    out[rel] = { origin_hash: hash, sha256: hash };
  }
  return out;
}

module.exports = {
  ROOT,
  sha,
  discoverManagedScripts,
  buildManagedScriptsMap,
};
