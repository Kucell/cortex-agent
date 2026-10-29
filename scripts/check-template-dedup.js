#!/usr/bin/env node
"use strict";

// ─── Check Template Layer Dedup ───────────────────────────────────────────────
// The template tree has three layers:
//
//   templates/_shared/.agent/  the language-neutral base
//   templates/zh/.agent/        the Chinese overlay
//   templates/en/.agent/        the English overlay
//
// `cortex-agent upgrade` lays them down in that order — shared first, then
// the language overlay — so a language layer only ever *overrides* a file the
// shared layer already provided.
//
// That makes one thing pure waste: a file sitting in all three layers with
// byte-identical content. It is maintained in three places, and the copy that
// gets forgotten is the one that drifts. The copy in the language layer adds
// nothing, because the shared layer already delivers the same bytes.
//
// So the rule is: **a file belongs in exactly one layer.**
//
//   - language-neutral content (code, schemas, scripts, config) → _shared
//   - content that differs by language                            → zh / en
//
// A file may exist in _shared and in one language layer when the language
// layer genuinely differs — that is an override, not a duplicate. This gate
// reports only the byte-identical case.
//
// Run:
//   node scripts/check-template-dedup.js [--root <dir>] [--verbose]
//
// Exit 0 = clean, exit 1 = duplicated copies found.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ROOT = path.resolve(__dirname, "..");

const LAYERS = Object.freeze(["_shared", "zh", "en"]);

// Directories that are runtime state rather than distributed content.
const SKIP_DIRS = Object.freeze([
  "node_modules", ".git", "dist", "coverage",
]);

// OS noise. A .DS_Store that happens to sit in two layers is not a
// distributed file — it is a macOS artifact that must never reach a user's
// project. It is filtered out here so it can neither be reported as a
// duplicate nor be mistaken for content worth sinking into _shared.
const NOISE_FILES = Object.freeze([".DS_Store", "Thumbs.db", "desktop.ini"]);

function collectFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.isFile() && !NOISE_FILES.includes(entry.name)) acc.push(full);
  }
  return acc;
}

function layerFiles(root, layer) {
  const dir = path.join(root, "templates", layer, ".agent");
  if (!fs.existsSync(dir)) return new Map();
  const map = new Map();
  for (const file of collectFiles(dir, [])) {
    map.set(path.relative(dir, file), file);
  }
  return map;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 && args[rootIndex + 1]
    ? path.resolve(args[rootIndex + 1])
    : DEFAULT_ROOT;

  const layers = {};
  for (const layer of LAYERS) layers[layer] = layerFiles(root, layer);

  const shared = layers._shared;
  const zh = layers.zh;
  const en = layers.en;

  // Every relative path that appears in more than one layer.
  const allPaths = new Set([...shared.keys(), ...zh.keys(), ...en.keys()]);
  const duplicates = [];

  for (const rel of allPaths) {
    const present = LAYERS.filter((layer) => layers[layer].has(rel));
    if (present.length < 2) continue;

    // Compare each language layer against the shared base on its own.
    //
    // A language layer that agrees with the shared base byte for byte
    // carries no information: the shared layer already delivers the same
    // bytes to every project, so the copy is maintained twice and the copy
    // that is forgotten is the one that drifts.
    //
    // The layers are compared pairwise against the shared base rather than
    // "are all present layers identical". When the shared base and one
    // language layer agree but the other language layer differs, the
    // agreeing one is still redundant — the Chinese overlay is the genuine
    // one, and the English copy next to it is pure duplication.
    const sharedContent = present.includes("_shared")
      ? readIfPresent(layers._shared.get(rel))
      : null;

    if (sharedContent) {
      const redundant = present
        .filter((layer) => layer !== "_shared")
        .filter((layer) => {
          const content = readIfPresent(layers[layer].get(rel));
          return content && content.equals(sharedContent);
        });
      if (redundant.length > 0) {
        duplicates.push({ rel, kind: "redundant-language-copy", redundant, kept: "_shared" });
      }
      continue;
    }

    // No shared copy. If the language layers agree byte for byte, the
    // content is language-neutral but was written twice instead of once in
    // the shared base. There is no shared copy to keep — the fix is to sink
    // one of them — so it is reported under its own kind.
    const contents = present.map((layer) => readIfPresent(layers[layer].get(rel)));
    if (contents.every((c) => c && c.equals(contents[0]))) {
      duplicates.push({ rel, kind: "missing-shared-copy", redundant: ["en"], kept: "_shared" });
    }
  }

  console.log(`\n📍 Template Layer Dedup Report`);
  console.log(`   Layers:         ${LAYERS.join(", ")}`);
  console.log(`   _shared files:  ${shared.size}`);
  console.log(`   zh files:       ${zh.size}`);
  console.log(`   en files:       ${en.size}`);
  console.log(`   Duplicates:     ${duplicates.length}`);

  if (duplicates.length === 0) {
    console.log(`\n✅ Every template file lives in exactly one layer`);
    process.exit(0);
  }

  const byKind = new Map();
  for (const d of duplicates) {
    if (!byKind.has(d.kind)) byKind.set(d.kind, []);
    byKind.get(d.kind).push(d);
  }

  const redundant = byKind.get("redundant-language-copy") || [];
  if (redundant.length > 0) {
    const byLayer = new Map();
    for (const d of redundant) {
      for (const layer of d.redundant) {
        if (!byLayer.has(layer)) byLayer.set(layer, []);
        byLayer.get(layer).push(d.rel);
      }
    }
    for (const [layer, items] of byLayer) {
      console.log(`\n❌ duplicate in ${layer} — byte-identical to _shared (${items.length})`);
      for (const rel of items.sort()) console.log(`   ${rel}`);
    }
  }

  const missingShared = byKind.get("missing-shared-copy") || [];
  if (missingShared.length > 0) {
    console.log(`\n❌ duplicated across language layers, no _shared copy (${missingShared.length})`);
    for (const d of missingShared.sort((a, b) => a.rel.localeCompare(b.rel))) {
      console.log(`   ${d.rel}`);
    }
    console.log(`   -> sink one copy into _shared and delete the language copies`);
  }

  console.log(`\n⚠️  The language overlay only overrides. A byte-identical copy there`);
  console.log(`   is maintained twice and drifts silently.`);
  console.log(`   Keep the file in _shared and delete the language copy, or make the`);
  console.log(`   language copy genuinely differ.`);
  if (verbose) {
    console.log(`\n   See .agent/rules/template-layer-dedup.md.`);
  }

  process.exit(1);
}

main();
