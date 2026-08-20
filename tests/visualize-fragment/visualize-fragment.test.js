/**
 * tests/visualize-fragment/visualize-fragment.test.js
 *
 * Unit tests for lib/visualize-fragment.js (validate + patch helpers).
 *
 * Policy: node:test + node:assert/strict (zero deps, per .agent/rules/test-policy.md).
 *
 * Upstream: Nagi-ovo/dsh-visualize (BSD-3-Clause, Copyright (c) 2026 Jesse Zhang)
 *   src/fragment.ts: validateFragment, applyFragmentPatch
 *
 * Run:
 *   node --test --test-timeout=60000 tests/visualize-fragment/visualize-fragment.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  VISUALIZE_TOOL_NAME,
  validateFragment,
  applyFragmentPatch,
} = require('../../lib/visualize-fragment');

describe('lib/visualize-fragment', () => {
  describe('VISUALIZE_TOOL_NAME', () => {
    test('should be "visualize" (upstream wire name)', () => {
      assert.equal(VISUALIZE_TOOL_NAME, 'visualize');
    });
  });

  describe('validateFragment — happy path', () => {
    test('should return UTF-8 byte length for a valid fragment', () => {
      const frag = '<div id="root">Hello</div>';
      const bytes = validateFragment(frag, 1024);
      assert.equal(typeof bytes, 'number');
      assert.equal(bytes, Buffer.byteLength(frag, 'utf8'));
    });

    test('should accept a large fragment when under maxBytes', () => {
      const frag = '<div>' + 'x'.repeat(50_000) + '</div>';
      const bytes = validateFragment(frag, 100_000);
      assert.equal(bytes, Buffer.byteLength(frag, 'utf8'));
    });

    test('should count multi-byte UTF-8 characters correctly', () => {
      // '你好' = 6 bytes in UTF-8 (3 each), 2 chars
      const frag = '<div>你好</div>';
      const expected = Buffer.byteLength(frag, 'utf8');
      const actual = validateFragment(frag, 1024);
      assert.equal(actual, expected);
      assert.equal(actual, frag.length + 4); // '你好' is 2 JS chars but 6 bytes; +4 not +2
    });

    test('should accept fragments with newlines, scripts, styles, etc.', () => {
      const frag = `
        <div id="root">
          <script>console.log("hi");</script>
          <style>.x { color: red; }</style>
          <p>Content here.</p>
        </div>
      `;
      const bytes = validateFragment(frag, 1024);
      assert.equal(bytes, Buffer.byteLength(frag, 'utf8'));
    });
  });

  describe('validateFragment — empty / invalid input', () => {
    test('should throw on empty string', () => {
      assert.throws(() => validateFragment('', 1024), /empty/);
    });

    test('should throw on whitespace-only fragment', () => {
      assert.throws(() => validateFragment('   \n\t  ', 1024), /empty/);
    });

    test('should throw on non-string input', () => {
      // @ts-ignore - intentional bad input
      assert.throws(() => validateFragment(null, 1024), /empty/);
      // @ts-ignore - intentional bad input
      assert.throws(() => validateFragment(42, 1024), /empty/);
    });
  });

  describe('validateFragment — size ceiling', () => {
    test('should throw when fragment exceeds maxBytes', () => {
      const frag = '<div>' + 'x'.repeat(2000) + '</div>';
      assert.throws(
        () => validateFragment(frag, 1000),
        /over the 1000-byte limit/,
      );
    });

    test('should accept when fragment is exactly at maxBytes', () => {
      const frag = '<div>x</div>';
      const bytes = Buffer.byteLength(frag, 'utf8');
      const result = validateFragment(frag, bytes);
      assert.equal(result, bytes);
    });
  });

  describe('validateFragment — document-skeleton tags', () => {
    test('should reject <!doctype>', () => {
      assert.throws(
        () => validateFragment('<!doctype html><div>hi</div>', 1024),
        /document-skeleton tag.*<!doctype/i,
      );
    });

    test('should reject <html>', () => {
      assert.throws(
        () => validateFragment('<html><body>hi</body></html>', 1024),
        /document-skeleton tag.*<html/i,
      );
    });

    test('should reject <head>', () => {
      assert.throws(
        () => validateFragment('<head><title>x</title></head><div>hi</div>', 1024),
        /document-skeleton tag.*<head/i,
      );
    });

    test('should reject <body>', () => {
      assert.throws(
        () => validateFragment('<body><div>hi</div></body>', 1024),
        /document-skeleton tag.*<body/i,
      );
    });

    test('should reject skeleton tags case-insensitively', () => {
      assert.throws(
        () => validateFragment('<HTML><DIV>hi</DIV></HTML>', 1024),
        /document-skeleton tag/,
      );
      assert.throws(
        () => validateFragment('<!DOCTYPE html><div>x</div>', 1024),
        /document-skeleton tag/,
      );
    });

    test('should NOT reject substrings inside attributes or text', () => {
      // "html" inside an attribute or text is fine
      const frag1 = '<div data-language="html">safe</div>';
      assert.doesNotThrow(() => validateFragment(frag1, 1024));

      const frag2 = '<p>This page is HTML5 compliant.</p>';
      assert.doesNotThrow(() => validateFragment(frag2, 1024));
    });
  });

  describe('applyFragmentPatch — happy path', () => {
    test('should replace a unique occurrence', () => {
      const base = '<div id="root">old value here</div>';
      const oldStr = 'old value here';
      const newStr = 'new value here';
      const result = applyFragmentPatch(base, oldStr, newStr);
      assert.equal(result, '<div id="root">new value here</div>');
    });

    test('should accept newStr === oldStr (no-op)', () => {
      const base = '<div>same content text</div>';
      const result = applyFragmentPatch(base, 'same content text', 'same content text');
      assert.equal(result, base);
    });

    test('should accept newStr === "" (delete region)', () => {
      const base = '<div>keep me <del>remove this block</del> end</div>';
      const result = applyFragmentPatch(base, '<del>remove this block</del>', '');
      assert.equal(result, '<div>keep me  end</div>');
    });

    test('should handle whitespace in oldStr', () => {
      const base = '<div>\n  previous value\n</div>';
      const oldStr = '\n  previous value\n';
      const result = applyFragmentPatch(base, oldStr, '\n  updated value\n');
      assert.equal(result, '<div>\n  updated value\n</div>');
    });

    test('should patch the FIRST non-overlapping match', () => {
      const base = 'AAA unique-token ZZZ';
      const result = applyFragmentPatch(base, 'unique-token', 'replaced-value');
      assert.equal(result, 'AAA replaced-value ZZZ');
    });

    test('should be a no-op when only one match exists at the same location', () => {
      const base = '<div>static content here</div>';
      const result = applyFragmentPatch(base, 'static content here', 'static content here');
      assert.equal(result, base);
    });
  });

  describe('applyFragmentPatch — invalid input', () => {
    test('should throw when oldStr is empty', () => {
      assert.throws(
        () => applyFragmentPatch('<div>x</div>', '', 'new'),
        /old_str is empty/,
      );
    });

    test('should accept short oldStr when exactly one site matches (upstream behavior)', () => {
      // Upstream does NOT enforce a minimum length; short oldStr with a unique
      // match is accepted. The MIN_ANCHOR_CHARS constant is used internally
      // for error-message hint quality, not as a precondition.
      const base = '<div>unique abc token</div>';
      const result = applyFragmentPatch(base, 'abc', 'XYZ');
      assert.equal(result, '<div>unique XYZ token</div>');
    });

    test('should throw on non-string inputs', () => {
      // @ts-ignore - intentional bad input
      assert.throws(() => applyFragmentPatch(null, 'old string here', 'new string here'), /must all be strings/);
      // @ts-ignore - intentional bad input
      assert.throws(() => applyFragmentPatch('base string here', 42, 'new string here'), /must all be strings/);
      // @ts-ignore - intentional bad input
      assert.throws(() => applyFragmentPatch('base string here', 'old string here', null), /must all be strings/);
    });
  });

  describe('applyFragmentPatch — match failures', () => {
    test('should throw with anchor info when oldStr is not found', () => {
      const base = '<div class="actual-class-name">content here</div>';
      const oldStr = 'class="wrong-class"';
      assert.throws(
        () => applyFragmentPatch(base, oldStr, 'class="right-class"'),
        /does not appear in the card/,
      );
    });

    test('should suggest a re-render when no 12+ char prefix matches', () => {
      // Construct a base where no 12-char prefix of oldStr is found anywhere
      const base = '<div>completely different content that does not contain any anchor substring at all</div>';
      const oldStr = 'XXXXXXXX123456789abcdef'; // 24 chars, none present in base
      assert.throws(
        () => applyFragmentPatch(base, oldStr, 'replacement text'),
        /None of it matched/,
      );
    });

    test('should throw with occurrence count when oldStr is non-overlapping-ambiguous', () => {
      // Two genuinely distinct, non-overlapping matches separated by other content
      const base = 'FIRST unique-marker-block HERE   other content between   SECOND unique-marker-block THERE';
      const oldStr = 'unique-marker-block'; // 19 chars, appears twice non-overlapping
      assert.throws(
        () => applyFragmentPatch(base, oldStr, 'replacement text here'),
        /appears 2 times/,
      );
    });

    test('should NOT count overlapping matches as separate occurrences', () => {
      // If oldStr has length N, and there's a match at position 0 and another at position < N,
      // they overlap. Upstream semantics: only non-overlapping matches count.
      // Here oldStr "AAAA-BBB-CCC AAA-BBB-CCC" (23 chars) appears at pos 0 and pos 12,
      // but pos 12 + 23 = 35 which goes past base3. So second search starts at pos 23,
      // and no match is found. The patch succeeds.
      const base = 'AAA-BBB-CCC AAA-BBB-CCC AAA-BBB-CCC end';
      const oldStr = 'AAA-BBB-CCC AAA-BBB-CCC'; // 23 chars
      // First match at 0, second match at 12 overlaps — non-overlapping count = 1, patch succeeds
      const result = applyFragmentPatch(base, oldStr, 'REPLACED');
      assert.equal(result, 'REPLACED AAA-BBB-CCC end');
    });

    test('should distinguish truly ambiguous (3 non-overlapping) from overlapping', () => {
      // Three non-overlapping 12+ char matches with explicit separator
      const sep = '||'; // ensures non-overlap
      const marker = 'unique-marker-XYZ'; // 17 chars
      const base = marker + sep + marker + sep + marker + '|end';
      // 3 non-overlapping occurrences
      assert.throws(
        () => applyFragmentPatch(base, marker, 'replacement text here'),
        /appears 3 times/,
      );
    });
  });

  describe('integration: validateFragment on a real-shaped fragment', () => {
    test('should validate a Chart.js-style fragment', () => {
      const frag = `
<div id="root" style="height: 320px">
  <canvas id="chart"></canvas>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
<script>
  document.addEventListener('DOMContentLoaded', function () {
    new Chart(document.getElementById('chart'), {
      type: 'line',
      data: { labels: ['A', 'B', 'C'], datasets: [{ label: 'X', data: [1, 2, 3] }] }
    });
  });
</script>
      `.trim();
      const bytes = validateFragment(frag, 100_000);
      assert.equal(bytes, Buffer.byteLength(frag, 'utf8'));
    });

    test('should reject a fragment that contains <body>', () => {
      const frag = '<body><div>hi</div></body>';
      assert.throws(() => validateFragment(frag, 1024), /document-skeleton tag/);
    });

    test('should round-trip: validate → patch → re-validate', () => {
      const frag1 = '<div id="root">counter = 10</div>';
      const bytes1 = validateFragment(frag1, 1024);
      assert.equal(bytes1, frag1.length);

      const frag2 = applyFragmentPatch(frag1, 'counter = 10', 'counter = 42');
      const bytes2 = validateFragment(frag2, 1024);
      assert.equal(bytes2, frag2.length);
      assert.equal(frag2, '<div id="root">counter = 42</div>');
    });

    test('should round-trip with a CDN script tag change', () => {
      const before = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>';
      const after = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js"></script>';
      const frag1 = `<div>${before}</div>`;
      const frag2 = applyFragmentPatch(frag1, before, after);
      assert.equal(frag2, `<div>${after}</div>`);
      validateFragment(frag2, 1024); // must still pass
    });
  });
});