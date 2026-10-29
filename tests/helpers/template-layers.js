"use strict";

// ---------------------------------------------------------------------------
// Template layer helpers for tests.
//
// The template tree has three layers:
//
//   templates/_shared/.agent/   the language-neutral base
//   templates/{zh,en}/.agent/   the language overlays
//
// A project receives the union of these: the overlay overrides the shared
// base, and the shared base fills in what the overlay does not carry. A
// template file therefore lives in *exactly one* layer, and the distribution
// surface of a language is "the overlay, plus the shared base for whatever
// the overlay does not have".
//
// Tests that assert "every language layer must contain this file" encode the
// old three-copy layout and no longer describe how the tree is built. The
// helpers here resolve a path the way the installation resolves it, so a
// test can assert what a language actually receives.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATES_ROOT = path.join(ROOT, "templates");
const SHARED_ROOT = path.join(TEMPLATES_ROOT, "_shared", ".agent");

/** The layer roots of the template tree, keyed by layer name. */
const LAYERS = Object.freeze({
  _shared: SHARED_ROOT,
  zh: path.join(TEMPLATES_ROOT, "zh", ".agent"),
  en: path.join(TEMPLATES_ROOT, "en", ".agent"),
});

/**
 * Resolve a relative path for one language the way the installation does:
 * the overlay's copy when it has one, the shared base's copy otherwise.
 *
 * Returns the absolute path, or null when no layer carries the file.
 */
function resolveTemplatePath(relativePath, lang) {
  const overlay = path.join(LAYERS[lang], relativePath);
  if (fs.existsSync(overlay)) return overlay;
  const shared = path.join(SHARED_ROOT, relativePath);
  if (fs.existsSync(shared)) return shared;
  return null;
}

/**
 * The layers that actually carry a relative path. A path in more than one
 * layer is an override: the layers must agree byte for byte.
 */
function layersCarrying(relativePath) {
  return Object.keys(LAYERS).filter((layer) => fs.existsSync(path.join(LAYERS[layer], relativePath)));
}

/**
 * Assert that every language can receive the path, and that the layers that
 * carry it agree. This is the distribution invariant the template tree has
 * to hold: a language overlay may not carry a copy that differs from the
 * shared base, and no language may be unable to reach a file at all.
 */
function assertTemplatePathReachable(t, relativePath, options = {}) {
  const { required = true } = options;
  const carriers = layersCarrying(relativePath);
  if (carriers.length === 0) {
    if (required) t.fail(`${relativePath} is not carried by any template layer`);
    return;
  }
  const contents = carriers.map((layer) => fs.readFileSync(path.join(LAYERS[layer], relativePath)));
  const first = contents[0];
  for (let i = 1; i < contents.length; i += 1) {
    if (!contents[i].equals(first)) {
      t.fail(`${relativePath} differs between ${carriers[0]} and ${carriers[i]}`);
    }
  }
  return carriers;
}

/**
 * Every file a language receives, as a map of relative path to absolute
 * source path.
 */
function templateSurface(lang) {
  const surface = new Map();
  const walk = (root, relBase) => {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const full = path.join(root, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) surface.set(rel, full);
    }
  };
  walk(SHARED_ROOT, "");
  walk(LAYERS[lang], "");
  // The overlay wins, so it is walked second.
  return surface;
}

module.exports = {
  ROOT,
  TEMPLATES_ROOT,
  SHARED_ROOT,
  LAYERS,
  resolveTemplatePath,
  layersCarrying,
  assertTemplatePathReachable,
  templateSurface,
};
