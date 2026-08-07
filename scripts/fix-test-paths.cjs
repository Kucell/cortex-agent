#!/usr/bin/env node
// scripts/fix-test-paths.cjs
// ---------------------------------------------------------------------------
// One-shot path-fix utility for the test re-categorization work.
// After moving tests/<file>.test.js → tests/<sub>/<file>.test.js, the relative
// paths to the project root (or to lib/, bin/, .agent/, templates/, etc.)
// shift by one directory level. This script applies the canonical set of
// path transformations to a list of test files.
//
// Why this is a script (not a sed/awk one-liner):
//   - The patterns are 8 distinct shapes (path.resolve / path.join, single
//     ".." arg, "../x" arg, multi-arg "..", "x", "y"). Chaining them with
//     sed/perl causes double-replacement because the result of one
//     transform looks like the input of the next.
//   - This script applies each transform in a single pass and guarantees
//     no transform's output is a re-matchable input for another.
//
// Usage:
//   node scripts/fix-test-paths.cjs <file> [<file> ...]
// ---------------------------------------------------------------------------

'use strict';
const fs = require('fs');
const path = require('path');

// Match one full path.X(__dirname, [args...]) call, return { match, args }
// where args is the list of string-literal arguments after __dirname.
function matchPathCall(src) {
  const re = /(path\.(?:resolve|join)\s*\(\s*__dirname\s*,)/g;
  const m = re.exec(src);
  if (!m) return null;

  // Walk forward from the end of `m[0]`, collecting top-level string-literal
  // arguments until the matching ')'.
  let i = m.index + m[0].length;
  const args = [];
  // Skip whitespace.
  while (i < src.length && /\s/.test(src[i])) i++;
  // No args at all.
  if (src[i] === ')') {
    return { match: src.slice(m.index, i + 1), args: [], start: m.index, end: i + 1 };
  }
  while (true) {
    // Expect a quoted string.
    if (src[i] !== '"' && src[i] !== "'") return null;
    const quote = src[i];
    i++;
    let str = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\' && i + 1 < src.length) { str += src[i] + src[i + 1]; i += 2; continue; }
      str += src[i]; i++;
    }
    if (src[i] !== quote) return null;
    i++;
    args.push({ quote, value: str });
    // Skip whitespace and a possible comma.
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === ',') { i++; while (i < src.length && /\s/.test(src[i])) i++; continue; }
    if (src[i] === ')') { i++; break; }
    return null;
  }
  return { match: src.slice(m.index, i), args, start: m.index, end: i };
}

function fixPathCall(callExpr) {
  const args = callExpr.args;
  if (args.length === 0) return callExpr.match;

  // Case A: leading "..", "X", "Y", ...  → insert another ".." after the
  // leading "..", but ONLY if the next arg is not already ".."
  // (idempotency: re-running the fix on a fixed file must be a no-op).
  if (args[0].value === '..' && args.length >= 2) {
    if (args[1].value === '..') return callExpr.match; // already fixed
    const q = args[0].quote;
    const tail = args.slice(1).map(a => `${a.quote}${a.value}${a.quote}`).join(', ');
    const newArgs = `${q}..${q}, ${q}..${q}, ${tail}`;
    const head = callExpr.match.slice(0, callExpr.match.indexOf('__dirname,') + '__dirname,'.length);
    return `${head} ${newArgs})`;
  }
  // Case B: leading ".." as the only arg.
  if (args[0].value === '..' && args.length === 1) {
    const q = args[0].quote;
    const head = callExpr.match.slice(0, callExpr.match.indexOf('__dirname,') + '__dirname,'.length);
    return `${head} ${q}..${q}, ${q}..${q})`;
  }
  // Case C: leading "../X" (combined arg) → "../../X", but only if not
  // already starting with "../../".
  if (args[0].value.startsWith('../')) {
    if (args[0].value.startsWith('../../')) return callExpr.match; // already fixed
    const newFirst = `${args[0].quote}../../${args[0].value.slice(3)}${args[0].quote}`;
    const head = callExpr.match.slice(0, callExpr.match.indexOf('__dirname,') + '__dirname,'.length);
    const tail = args.slice(1).map(a => `${a.quote}${a.value}${a.quote}`).join(', ');
    return tail ? `${head} ${newFirst}, ${tail})` : `${head} ${newFirst})`;
  }
  return callExpr.match; // no change
}

function fix(content) {
  let out = content;

  // 1. require("../lib/...") → require("../../lib/...")
  out = out.replace(/require\(["']\.\.\/lib\//g, 'require("../../lib/');

  // 2. require("../.agent/...") → require("../../.agent/...")
  out = out.replace(/require\(["']\.\.\/\.agent\//g, 'require("../../.agent/');

  // 3. path.X(__dirname, ...) calls — parse and shift up one level.
  let result = '';
  let cursor = 0;
  while (true) {
    const re = /path\.(?:resolve|join)\s*\(\s*__dirname\s*,/g;
    re.lastIndex = cursor;
    const m = re.exec(out);
    if (!m) { result += out.slice(cursor); break; }
    result += out.slice(cursor, m.index);
    // Re-parse the call from m.index (don't use m.match because we need the full extent).
    const re2 = /(path\.(?:resolve|join)\s*\(\s*__dirname\s*,)/g;
    re2.lastIndex = m.index;
    re2.exec(out); // sets re2.lastIndex to the end of the match
    const call = matchPathCall(out);
    if (!call) { result += out.slice(m.index, m.index + 1); cursor = m.index + 1; continue; }
    result += fixPathCall(call);
    cursor = call.end;
  }
  out = result;

  return out;
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node scripts/fix-test-paths.cjs <file> [<file> ...]');
    process.exit(2);
  }
  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8');
    const after = fix(before);
    if (before !== after) {
      fs.writeFileSync(f, after);
      console.log(`fixed: ${f}`);
    }
  }
} else {
  module.exports = { fix };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/fix-test-paths.cjs <file> [<file> ...]');
  process.exit(2);
}

for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  const after = fix(before);
  if (before !== after) {
    fs.writeFileSync(f, after);
    console.log(`fixed: ${f}`);
  } else {
    console.log(`no change: ${f}`);
  }
}
