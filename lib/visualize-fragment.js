/**
 * lib/visualize-fragment.js
 *
 * Pure fragment contract: validate + patch.
 *
 * Upstream: Nagi-ovo/dsh-visualize (BSD-3-Clause, Copyright (c) 2026 Jesse Zhang)
 *   src/fragment.ts: validateFragment, applyFragmentPatch
 *
 * Cortex-agent scope: zero-dependency validation + patch helpers for any
 * module that writes inline-HTML artifacts. NOT coupled to DSH, cordis,
 * toolview meta, or sandbox iframe rendering.
 *
 * Architecture decisions:
 * - Pure module: no I/O, no globals, no side effects.
 * - CommonJS export (matches lib/design/lockfile.js, lib/coordination/*).
 * - JSDoc + runtime assertions instead of TypeScript.
 * - English error messages (verbatim from upstream) for cross-ecosystem reference.
 * - Functions NOT ported from upstream (DSH-coupled, see proposal §5.2.3):
 *   extractStreamingFragment, trimStreamingScripts, visualizeMetaFrom.
 *
 * Path: pure module (no I/O, no globals).
 */

'use strict';

/** Wire name of the upstream tool — exported for provenance tagging. */
const VISUALIZE_TOOL_NAME = 'visualize';

/** Document-skeleton tags a fragment must not contain (case-insensitive). */
const SKELETON_TAG = /<!doctype\b|<\s*(?:html|head|body)\b/iu;

/**
 * Characters of real card content quoted back when a patch fails to apply, so
 * the model can correct `old_str` from the true bytes without re-reading the
 * whole card.
 */
const PATCH_CONTEXT_CHARS = 160;

/**
 * Shortest matching prefix of a failed `old_str` still worth reporting as a
 * location hint; below this any HTML shares enough characters to point
 * somewhere misleading.
 */
const MIN_ANCHOR_CHARS = 12;

/**
 * UTF-8 byte length without Buffer, so this works in both Node.js and a
 * plain browser bundle.
 * @param {string} text
 * @returns {number} UTF-8 byte length
 */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Validate one fragment against the inline contract.
 * @param {string} fragment - the file content the model wrote.
 * @param {number} maxBytes - deployment size ceiling for one fragment.
 * @returns {number} the fragment's UTF-8 size in bytes.
 * @throws {Error} naming the violated rule; callers surface it as a hard failure.
 */
function validateFragment(fragment, maxBytes) {
  if (typeof fragment !== 'string' || fragment.trim().length === 0) {
    throw new Error('invalid visualization: the fragment file is empty');
  }
  const sizeBytes = byteLength(fragment);
  if (sizeBytes > maxBytes) {
    throw new Error(
      `invalid visualization: fragment is ${sizeBytes} bytes, over the ${maxBytes}-byte limit — `
      + 'shrink the inline data first (fewer rows, coarser buckets, fewer decimals)',
    );
  }
  const skeleton = SKELETON_TAG.exec(fragment);
  if (skeleton) {
    throw new Error(
      `invalid visualization: fragment contains a document-skeleton tag (${JSON.stringify(skeleton[0])}) — `
      + 'write only the inline body; the host supplies <!doctype>, <html>, <head>, and <body>',
    );
  }
  return sizeBytes;
}

/**
 * Replace one exact, unique occurrence of `oldStr` in a rendered card's
 * fragment. Iterating by patch instead of re-emitting the whole fragment is
 * what keeps a small correction small: the model re-states only the changed
 * region, and the card's markup never enters its output twice.
 *
 * A patch that does not resolve to exactly one site is refused rather than
 * guessed at, because both wrong outcomes are silent — a near-miss would edit
 * markup the model never saw, and an ambiguous match would edit an arbitrary
 * one of several sites. The thrown message carries the surrounding real
 * content so the caller can correct `old_str` within the same turn.
 *
 * @param {string} base - the current fragment of the card being patched.
 * @param {string} oldStr - exact text to replace, whitespace included.
 * @param {string} newStr - replacement text; empty deletes the matched region.
 * @returns {string} the patched fragment.
 * @throws {Error} naming why the patch did not apply.
 */
function applyFragmentPatch(base, oldStr, newStr) {
  if (typeof base !== 'string' || typeof oldStr !== 'string' || typeof newStr !== 'string') {
    throw new Error('invalid visualization patch: base, old_str, and new_str must all be strings');
  }
  if (oldStr.length === 0) {
    throw new Error('invalid visualization patch: old_str is empty — pass the exact card text to replace');
  }
  const first = base.indexOf(oldStr);
  if (first === -1) {
    throw new Error(`invalid visualization patch: old_str does not appear in the card. ${nearestAnchor(base, oldStr)}`);
  }
  if (base.indexOf(oldStr, first + oldStr.length) !== -1) {
    throw new Error(
      `invalid visualization patch: old_str appears ${countOccurrences(base, oldStr)} times in the card — `
      + 'extend it with neighbouring lines until exactly one site matches',
    );
  }
  return base.slice(0, first) + newStr + base.slice(first + oldStr.length);
}

/**
 * Describe where a failed `old_str` stopped matching: the longest prefix of it
 * that does occur, and the card's real text at that site. Prefix occurrence is
 * monotone in length, so the longest one is a binary search.
 * @param {string} base - the current fragment of the card being patched.
 * @param {string} oldStr - the `old_str` that failed to match.
 * @returns {string} a sentence naming the divergence point, or advising a full re-render.
 */
function nearestAnchor(base, oldStr) {
  let matched = 0;
  let beyond = oldStr.length;
  while (matched < beyond) {
    const mid = Math.ceil((matched + beyond) / 2);
    if (base.includes(oldStr.slice(0, mid))) matched = mid;
    else beyond = mid - 1;
  }
  if (matched < MIN_ANCHOR_CHARS) {
    return 'None of it matched, so the card is not in the state you assumed — re-render the whole card instead.';
  }
  const at = base.indexOf(oldStr.slice(0, matched));
  return `Its first ${matched} characters do match, at offset ${at}, where the card actually reads `
    + `${JSON.stringify(base.slice(at, at + PATCH_CONTEXT_CHARS))} — correct old_str against that and retry.`;
}

/**
 * Count non-overlapping occurrences of a needle, matching the replacement
 * semantics {@link applyFragmentPatch} would apply.
 * @param {string} base - the text to scan.
 * @param {string} needle - the non-empty needle to count.
 * @returns {number} the number of non-overlapping occurrences.
 */
function countOccurrences(base, needle) {
  let count = 0;
  for (let at = base.indexOf(needle); at !== -1; at = base.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

module.exports = {
  VISUALIZE_TOOL_NAME,
  validateFragment,
  applyFragmentPatch,
};