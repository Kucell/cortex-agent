#!/usr/bin/env node
// scripts/fix-moved-lib-paths.cjs
// ---------------------------------------------------------------------------
// One-shot post-processor for the lib/ root → lib/<sub>/ re-categorization.
//
// For each moved file, scan its require() calls and identify any that use
// `..` to point at paths that were "1 up from lib/" before the move
// (e.g. require("../package.json") from lib/anchor.js = project_root/package.json).
// After the move to lib/anchor/anchor.js, those paths resolve to the wrong
// location; they need an extra ".." prefix.
//
// Pre-move:    lib/anchor.js
//              require("../package.json")  →  project_root/package.json ✓
// Post-move:   lib/anchor/anchor.js
//              require("../package.json")  →  lib/package.json  ✗
//              require("../../package.json")  →  project_root/package.json ✓
//
// This script detects the broken case by comparing pre-move and post-move
// resolutions, then rewrites the require target with an extra "..".
// ---------------------------------------------------------------------------

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const PLAN = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// For a moved file, get its pre-move content (from git HEAD).
function preMoveContent(move) {
  try {
    return execFileSync('git', ['show', `HEAD:${move.src}`], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    return null;
  }
}

function fixupFile(move) {
  if (!fs.existsSync(move.dest)) return;
  const pre = preMoveContent(move);
  if (!pre) return; // can't compare, skip
  const post = fs.readFileSync(move.dest, 'utf8');

  // Find all require() calls in the post-move file.
  const re = /require\(("[^"]+"|'[^']+')\)/g;
  const fixes = [];
  let m;
  while ((m = re.exec(post))) {
    const fullCall = m[0];
    const target = m[1].slice(1, -1);
    if (!target.startsWith('.')) continue; // not relative
    // Resolve post-move target.
    const postResolved = path.resolve(path.dirname(move.dest), target);
    // Resolve pre-move target: from move.src dir, use the SAME require target.
    // The pre-move file's require was probably the same target string.
    // We need to find what the pre-move file used. Scan pre content for the
    // same target.
    const preRe = new RegExp(`require\\(\\s*${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)`);
    if (!preRe.test(pre)) {
      // The post-move require target is not present in the pre-move file.
      // This was added by the relocation rewrite; the relocation script
      // already computed the right path. But if the target is "..", it
      // might still need a fixup if the pre-move file had a different form.
      // Skip — the relocation script handles moved-file references.
      continue;
    }
    // Compute what the pre-move target would resolve to (using the same string).
    const preResolved = path.resolve(path.dirname(move.src), target);
    if (preResolved !== postResolved && postResolved !== preResolved) {
      // The resolution changed. Check if preResolved exists and postResolved doesn't.
      // If preResolved exists and is a real file, then the post-move path is wrong
      // (because the same target string now points elsewhere).
      if (fs.existsSync(preResolved) && !fs.existsSync(postResolved)) {
        // The pre-move target was a real file. We need to adjust the post-move
        // target so it resolves back to preResolved. Add an extra ".." to the
        // target string.
        const extra = target.startsWith('../') ? '../' + target : '../' + target;
        // Actually: target = "../X" → "../" + "../X" = "../../X" (one more level up)
        // target = ".." → "../.." (one more level up)
        let newTarget;
        if (target === '..') newTarget = '../..';
        else if (target.startsWith('../')) newTarget = '../' + target;
        else newTarget = '../' + target; // shouldn't happen given startsWith('.')
        const newResolved = path.resolve(path.dirname(move.dest), newTarget);
        if (newResolved === preResolved) {
          const quote = m[1][0];
          const newQuoted = `${quote}${newTarget}${quote}`;
          fixes.push({ old: fullCall, new: `require(${newQuoted})` });
        }
      }
    }
  }

  if (fixes.length === 0) return;
  let updated = post;
  for (const f of fixes) {
    updated = updated.split(f.old).join(f.new);
  }
  if (updated !== post) {
    fs.writeFileSync(move.dest, updated);
    console.log(`  fixed: ${move.dest} (${fixes.length} requires)`);
  }
}

for (const move of PLAN) {
  fixupFile(move);
}
console.log('done');
