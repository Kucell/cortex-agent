#!/usr/bin/env node
// scripts/relocate-lib.cjs
// ---------------------------------------------------------------------------
// One-shot helper for the lib/ root → lib/<sub>/ re-categorization wave.
//
// Given a JSON plan of file moves, it:
//   1. Creates the destination directories.
//   2. git mv's each source file to its destination.
//   3. Rewrites the moved file's OWN internal require() paths:
//        - require("./sibling") where sibling is at lib/ root  →  require("../sibling")
//        - require("../foo") where foo is at lib/<other>/  →  require("../<other>/foo")
//        - require("../../bar")  →  unchanged (still project-relative)
//   4. Rewrites all CONSUMER require() paths across lib/ and bin/ that
//      reference any of the moved files.
//
// Why this is a script (not a sed one-liner):
//   - The path rewrites depend on a 2-axis lookup (file → new path,
//     and what-relative-to-what). Naive string substitution misses
//     multi-step relocations and double-matches.
//   - The set of files is fixed for this commit, so we can precompute
//     the relocations once and apply them mechanically.
// ---------------------------------------------------------------------------

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();

// Plan: array of { src, dest, internalRewrite? }.
// `internalRewrite` is an object: { oldRequire: newRequire } applied within
// the moved file's source. Computed from the global relocation map.
const PLAN = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

function gitMv(src, dest) {
  try {
    execFileSync('git', ['mv', src, dest], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error(`git mv ${src} ${dest} failed`);
    throw e;
  }
}

function readSafe(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function applyRewrites(content, rewrites) {
  let out = content;
  for (const [oldReq, newReq] of Object.entries(rewrites)) {
    // Match the require() call with the literal target string. We use a
    // direct string replacement here because the targets are uniquely
    // formed (require("...") or require('...')).
    const variants = [
      `require(${JSON.stringify(oldReq)})`,
      `require(${JSON.stringify(oldReq.replace(/'/g, "\\'"))})`,
    ];
    for (const v of variants) {
      out = out.split(v).join(`require(${JSON.stringify(newReq)})`);
    }
  }
  return out;
}

function listJsFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listJsFiles(full, results);
    else if (e.isFile() && e.name.endsWith('.js')) results.push(full);
  }
  return results;
}

// 1. Pre-compute the global relocation map and per-consumer rewrites.
//    Two distinct cases drive the require rewrite for each consumer file:
//      (a) the consumer itself is NOT being moved → relative path stays
//          the same shape ("../<oldBase>" → "../<newRel>")
//      (b) the consumer IS being moved → its post-move directory may be
//          different, so the new require path must be computed relative
//          to the consumer's NEW location.
//    We compute one rewrite table per consumer file (post-move) rather
//    than a single global table. This avoids the bug where a moved
//    consumer's own "require('./<oldBase>')" needed to become
//    "require('../<newRel>')" (one extra "..") instead of
//    "require('./<newRel>')" (same shape).

const MOVED_BASENAMES = new Set();  // old basenames (no .js) being relocated
const NEW_PATH = {};                // oldBase (no .js) → absolute new path
for (const move of PLAN) {
  MOVED_BASENAMES.add(path.basename(move.src, '.js'));
  NEW_PATH[path.basename(move.src, '.js')] = move.dest;
}

// Compute the post-move path of any file (if it's in PLAN) or its current path.
function postMovePath(absPath) {
  const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  for (const move of PLAN) {
    if (move.src === rel) return move.dest;
  }
  return rel;
}

// Build per-file rewrite table.
function rewritesFor(consumerAbsPath) {
  const newConsumer = postMovePath(consumerAbsPath);
  const consumerDir = path.dirname(newConsumer); // post-move dir
  const rewrites = {};
  for (const move of PLAN) {
    const oldBase = path.basename(move.src, '.js');
    const newRelRaw = path.relative(consumerDir, move.dest).replace(/\\/g, '/');
    // Normalize: strip the .js extension (Node resolves without it).
    const newRel = newRelRaw.replace(/\.js$/, '');
    // Determine the require target string. If the new path is the same dir
    // (no leading "." or "/"), prepend "./". Otherwise, use as-is.
    const requireTarget = (newRel.startsWith('.') || newRel.startsWith('/')) ? newRel : `./${newRel}`;
    rewrites[`./${oldBase}`] = requireTarget;
    rewrites[`../${oldBase}`] = requireTarget;
  }
  return rewrites;
}

// 2. Compute per-moved-file internal rewrites (using post-move path).
for (const move of PLAN) {
  move.internalRewrites = rewritesFor(move.src);
}

// 3. Execute.
for (const move of PLAN) {
  // Ensure dest dir exists.
  fs.mkdirSync(path.dirname(move.dest), { recursive: true });
  // git mv.
  console.log(`move: ${move.src} → ${move.dest}`);
  gitMv(move.src, move.dest);
  // Apply internal rewrites.
  const content = readSafe(move.dest);
  if (content !== null) {
    const updated = applyRewrites(content, move.internalRewrites);
    if (updated !== content) {
      fs.writeFileSync(move.dest, updated);
      console.log(`  rewrote internal requires in ${move.dest}`);
    }
  }
}

// 4. Update all consumers (lib/ + bin/ + tests/ that might reference these).
//    For each file, compute its post-move path and use the corresponding
//    rewrite table.
const allFiles = [
  ...listJsFiles(path.join(ROOT, 'lib')),
  ...listJsFiles(path.join(ROOT, 'bin')),
];
if (process.argv.includes('--include-tests')) {
  allFiles.push(...listJsFiles(path.join(ROOT, 'tests')));
}

let totalChanged = 0;
for (const f of allFiles) {
  const content = readSafe(f);
  if (content === null) continue;
  const rewrites = rewritesFor(f);
  const updated = applyRewrites(content, rewrites);
  if (updated !== content) {
    fs.writeFileSync(f, updated);
    totalChanged++;
  }
}
console.log(`rewrote consumers in ${totalChanged} files`);
