"use strict";

// ─── Template layer resolution ───────────────────────────────────────────────
//
// The template tree has three layers:
//
//   templates/_shared/.agent/   the language-neutral base
//   templates/{zh,en}/.agent/   the language overlays
//
// A project receives the union of these: the language overlay overrides the
// shared base, and the shared base fills in whatever the overlay does not
// carry.
//
// The precedence rule and the copy rule are two different things, and the
// copy paths used to conflate them. Copying the shared layer first and then
// the language layer, with "never overwrite an existing file" as the copy
// rule, means the *first* writer wins: the shared English copy lands first
// and the Chinese overlay is then skipped as a duplicate. A Chinese project
// ends up with English skill manifests — the overlay never takes effect.
//
// So the precedence is resolved first, over the template tree, and the
// result is a per-path source map: for every relative path, the one file
// that project should receive. The copy paths then install that map, and
// their own rule — never overwrite a file the project already has — stays
// untouched. The two concerns no longer fight each other.

const fs = require("node:fs");
const path = require("node:path");

const { skipReason } = require("./copy-rules");

// Directories that are runtime state rather than distributed content.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * Collect every distributable file under a template root, keyed by the path
 * relative to that root.
 */
function collectTemplateFiles(rootDir) {
  const found = new Map();
  if (!fs.existsSync(rootDir)) return found;
  const walk = (dir, relBase) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      // The copy rules live in lib/copy-rules.js so every copy path filters
      // OS junk and symlinks the same way. A template that ships either of
      // them would make the installed project differ by machine.
      if (skipReason(full, entry.name)) continue;
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) found.set(rel, full);
    }
  };
  walk(rootDir, "");
  return found;
}

/**
 * Resolve the template layers into a single per-path source map.
 *
 * `layers` is an ordered list of `{ root, name }` entries, highest
 * precedence first. For every relative path the first layer that carries it
 * wins; a lower-precedence layer fills in the paths the higher ones do not
 * have.
 *
 * Returns a Map of relative path -> absolute source file path.
 */
function resolveTemplateLayers(layers) {
  const resolved = new Map();
  // Walk the layers from the lowest precedence to the highest, so a higher
  // layer overwrites the entry a lower one placed.
  for (const layer of [...layers].reverse()) {
    const files = collectTemplateFiles(layer.root);
    for (const [rel, absolute] of files) resolved.set(rel, absolute);
  }
  return resolved;
}

/**
 * The standard layer stack for a project: the language overlay overrides
 * the shared base.
 */
function projectTemplateLayers(templatesRoot, lang) {
  return [
    { root: path.join(templatesRoot, lang, ".agent"), name: lang },
    { root: path.join(templatesRoot, "_shared", ".agent"), name: "_shared" },
  ];
}

module.exports = {
  SKIP_DIRS,
  collectTemplateFiles,
  resolveTemplateLayers,
  projectTemplateLayers,
};
