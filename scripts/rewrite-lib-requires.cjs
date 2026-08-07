#!/usr/bin/env node
// scripts/rewrite-lib-requires.cjs
// ---------------------------------------------------------------------------
// Apply the relocation rewrites to consumer files only. Used after the
// initial move has been done. Idempotent.
// ---------------------------------------------------------------------------

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PLAN = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const NEW_PATH = {};
for (const move of PLAN) {
  NEW_PATH[path.basename(move.src, '.js')] = move.dest;
}

function postMovePath(absPath) {
  const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  for (const move of PLAN) {
    if (move.src === rel) return move.dest;
  }
  return rel;
}

function rewritesFor(consumerAbsPath) {
  const newConsumer = postMovePath(consumerAbsPath);
  const consumerDir = path.dirname(newConsumer);
  const rewrites = {};
  for (const move of PLAN) {
    const oldBase = path.basename(move.src, '.js');
    const newRelRaw = path.relative(consumerDir, move.dest).replace(/\\/g, '/');
    const newRel = newRelRaw.replace(/\.js$/, '');
    const requireTarget = (newRel.startsWith('.') || newRel.startsWith('/')) ? newRel : `./${newRel}`;
    rewrites[`./${oldBase}`] = requireTarget;
    rewrites[`../${oldBase}`] = requireTarget;
  }
  return rewrites;
}

function listJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function applyRewrites(content, rewrites, filePath) {
  let out = content;
  for (const [oldReq, newReq] of Object.entries(rewrites)) {
    const v = `require(${JSON.stringify(oldReq)})`;
    out = out.split(v).join(`require(${JSON.stringify(newReq)})`);
  }
  // Also handle project-relative requires: ../../lib/<oldBase> or ../lib/<oldBase>
  // The form ../../lib/<X> means "from this file, go up 2 to project root, then lib/<X>".
  // After relocation of lib/<oldBase>.js to lib/<sub>/<oldBase>.js, the new require
  // is ../../lib/<sub>/<oldBase>. (For one-level-up consumers the form is
  // ../lib/<oldBase>, also handled below.)
  for (const move of PLAN) {
    const oldBase = path.basename(move.src, '.js');
    const newSub = path.dirname(path.relative('lib', move.dest)); // "coordination", "branch", etc.
    if (newSub === '.') continue; // moved within lib/ root, not to a subdir
    // Match: require("...lib/<oldBase>") (any prefix of "./", "../", "../../", etc.)
    const re = new RegExp(`require\\((["'])([^"']*lib/)${oldBase}(["'])\\)`, 'g');
    const newOut = out.replace(re, (_m, q1, prefix, q2) => `require(${q1}${prefix}${newSub}/${oldBase}${q2})`);
    if (newOut !== out && process.env.DEBUG_REWRITE) {
      console.error(`  ${filePath}: ${oldBase} -> ${newSub}/${oldBase}`);
    }
    out = newOut;
  }
  return out;
}

const allFiles = [
  ...listJsFiles(path.join(ROOT, 'lib')),
  ...listJsFiles(path.join(ROOT, 'bin')),
  ...listJsFiles(path.join(ROOT, 'tests')),
];

if (process.env.DEBUG_REWRITE) {
  console.error('Total files:', allFiles.length);
  console.error('lib:', listJsFiles(path.join(ROOT, 'lib')).length);
  console.error('bin:', listJsFiles(path.join(ROOT, 'bin')).length);
  console.error('tests:', listJsFiles(path.join(ROOT, 'tests')).length);
  console.error('init test file in list:', allFiles.includes(path.join(ROOT, 'tests/init/init-mode-general.test.js')));
}

let totalChanged = 0;
for (const f of allFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const rewrites = rewritesFor(f);
  if (process.env.DEBUG_REWRITE && content.includes('mode-infer')) {
    console.error(`DEBUG: ${f} contains mode-infer, has ${Object.keys(rewrites).length} rewrites`);
  }
  const updated = applyRewrites(content, rewrites, f);
  if (updated !== content) {
    fs.writeFileSync(f, updated);
    totalChanged++;
  }
}
console.log(`rewrote consumers in ${totalChanged} files`);
