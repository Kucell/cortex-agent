'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatLicenseWarning,
  isLicenseAcceptable,
  isBrandCategory,
  isYesAnswer,
  STARTERS_CATEGORY,
} = require('../lib/design/license');

// -- isBrandCategory --------------------------------------------------------

test('isBrandCategory: known brand categories', () => {
  assert.equal(isBrandCategory('AI & LLM'), true);
  assert.equal(isBrandCategory('Fintech'), true);
  assert.equal(isBrandCategory('Developer Tools'), true);
  assert.equal(isBrandCategory('Media'), true);
  assert.equal(isBrandCategory('Automotive'), true);
  assert.equal(isBrandCategory('Other'), true);
});

test('isBrandCategory: Starters is NOT a brand category (no warning)', () => {
  assert.equal(isBrandCategory('Starters'), false);
  assert.equal(isBrandCategory(STARTERS_CATEGORY), false);
});

test('isBrandCategory: unknown is not a brand category', () => {
  assert.equal(isBrandCategory('Random'), false);
  assert.equal(isBrandCategory(null), false);
  assert.equal(isBrandCategory(undefined), false);
});

// -- formatLicenseWarning ---------------------------------------------------

test('formatLicenseWarning: includes all standard fields', () => {
  const warning = formatLicenseWarning({
    id: 'default',
    name: 'Default',
    category: 'Starters',
    license: 'Apache-2.0',
    source: { type: 'upstream', origin: 'nexu-io/open-design' },
  });
  assert.ok(warning.includes('id:          default'));
  assert.ok(warning.includes('name:        Default'));
  assert.ok(warning.includes('category:    Starters'));
  assert.ok(warning.includes('license:     Apache-2.0'));
  assert.ok(warning.includes('source:      upstream · nexu-io/open-design'));
  assert.ok(warning.includes('Proceed? [y/N]'));
});

test('formatLicenseWarning: includes brand warning for brand categories', () => {
  const warning = formatLicenseWarning({
    id: 'linear-app',
    name: 'Linear',
    category: 'Developer Tools',
    license: 'Apache-2.0',
    source: { type: 'upstream', origin: 'nexu-io/open-design' },
  });
  assert.ok(warning.includes('Brand-referencing packages are aesthetic inspirations'));
});

test('formatLicenseWarning: no brand warning for Starters', () => {
  const warning = formatLicenseWarning({
    id: 'default',
    name: 'Default',
    category: 'Starters',
    license: 'Apache-2.0',
    source: { type: 'upstream', origin: 'nexu-io/open-design' },
  });
  assert.ok(!warning.includes('Brand-referencing'));
});

test('formatLicenseWarning: includes "license unknown" warning when missing', () => {
  const warning = formatLicenseWarning({
    id: 'mystery',
    name: 'Mystery',
    category: 'Starters',
    license: null,
    source: { type: 'upstream', origin: 'unknown' },
  });
  assert.ok(warning.includes('license is unknown'));
});

test('formatLicenseWarning: handles missing source gracefully', () => {
  const warning = formatLicenseWarning({
    id: 'x',
    category: 'Starters',
    license: 'Apache-2.0',
  });
  assert.ok(warning.includes('id:          x'));
  // No crash on missing source
});

// -- isLicenseAcceptable ----------------------------------------------------

test('isLicenseAcceptable: known license OK', () => {
  const r = isLicenseAcceptable({ license: 'Apache-2.0' });
  assert.equal(r.ok, true);
});

test('isLicenseAcceptable: missing license fails (fail-closed)', () => {
  const r = isLicenseAcceptable({ license: null });
  assert.equal(r.ok, false);
  assert.ok(/unknown license/.test(r.reason));
});

test('isLicenseAcceptable: force overrides missing license', () => {
  const r = isLicenseAcceptable({ license: null }, { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'forced');
});

test('isLicenseAcceptable: allowedCategories whitelist', () => {
  const r = isLicenseAcceptable(
    { license: 'Apache-2.0', category: 'Fintech' },
    { allowedCategories: ['Starters'] }
  );
  assert.equal(r.ok, false);
  assert.ok(/category Fintech not in allowed list/.test(r.reason));
});

test('isLicenseAcceptable: allowedCategories passes when in list', () => {
  const r = isLicenseAcceptable(
    { license: 'Apache-2.0', category: 'Starters' },
    { allowedCategories: ['Starters', 'Other'] }
  );
  assert.equal(r.ok, true);
});

test('isLicenseAcceptable: allowedLicenses whitelist', () => {
  const r = isLicenseAcceptable(
    { license: 'GPL-3.0' },
    { allowedLicenses: ['Apache-2.0', 'MIT'] }
  );
  assert.equal(r.ok, false);
  assert.ok(/license GPL-3\.0 not in allowed list/.test(r.reason));
});

test('isLicenseAcceptable: empty allowlist is no-op', () => {
  const r = isLicenseAcceptable(
    { license: 'Apache-2.0' },
    { allowedLicenses: [], allowedCategories: [] }
  );
  assert.equal(r.ok, true);
});

test('isLicenseAcceptable: force + allowedCategories — force wins', () => {
  const r = isLicenseAcceptable(
    { license: 'Apache-2.0', category: 'Fintech' },
    { force: true, allowedCategories: ['Starters'] }
  );
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'forced');
});

// -- isYesAnswer ------------------------------------------------------------

test('isYesAnswer: yes variants', () => {
  assert.equal(isYesAnswer('y'), true);
  assert.equal(isYesAnswer('Y'), true);
  assert.equal(isYesAnswer('yes'), true);
  assert.equal(isYesAnswer('YES'), true);
  assert.equal(isYesAnswer('  y  '), true);
});

test('isYesAnswer: no variants', () => {
  assert.equal(isYesAnswer('n'), false);
  assert.equal(isYesAnswer('N'), false);
  assert.equal(isYesAnswer('no'), false);
  assert.equal(isYesAnswer(''), false);
  assert.equal(isYesAnswer('   '), false);
});

test('isYesAnswer: non-string returns false', () => {
  assert.equal(isYesAnswer(null), false);
  assert.equal(isYesAnswer(undefined), false);
  assert.equal(isYesAnswer(123), false);
});
