/**
 * lib/design/license.js
 *
 * License governance for design system installs.
 *
 * Responsibilities:
 * - Format license warnings (mandatory ack at install time).
 * - Brand category warning (aesthetic inspiration, not official).
 * - License-acceptable gate (fail-closed on missing license, allow override).
 * - Optional allowedCategories / allowedLicenses whitelists.
 *
 * Architecture decisions:
 * - Pure logic (no I/O). User prompts go through readline in lib/commands/design.js
 *   (MS-003), not here. This module only formats the prompt and checks acceptability.
 */

'use strict';

const STARTERS_CATEGORY = 'Starters';

// Categories that may include brand-referencing packages.
// Per open-design upstream: "Brand-referencing packages are aesthetic inspirations,
// not official assets of the brands they reference."
const BRAND_CATEGORIES = new Set([
  'AI & LLM',
  'Developer Tools',
  'Productivity',
  'Fintech',
  'E-commerce',
  'Media',
  'Automotive',
  'Other',
]);

function isBrandCategory(category) {
  return BRAND_CATEGORIES.has(category);
}

function formatLicenseWarning(entry) {
  const lines = [];
  lines.push('About to install:');
  lines.push('  id:          ' + (entry.id || '(unknown)'));
  if (entry.name) lines.push('  name:        ' + entry.name);
  if (entry.category) lines.push('  category:    ' + entry.category);
  lines.push('  license:     ' + (entry.license || 'unknown'));
  if (entry.source) {
    const origin = entry.source.origin || 'unknown';
    const type = entry.source.type || 'unknown';
    lines.push('  source:      ' + type + ' · ' + origin);
  }
  lines.push('');

  if (isBrandCategory(entry.category) && entry.category !== STARTERS_CATEGORY) {
    lines.push('Note: Brand-referencing packages are aesthetic inspirations,');
    lines.push('      not official assets of the brands they reference.');
    lines.push('');
  }

  if (!entry.license) {
    lines.push('Warning: license is unknown. Install will fail unless --force is set.');
    lines.push('');
  }

  lines.push('Proceed? [y/N]');
  return lines.join('\n');
}

function isLicenseAcceptable(entry, options) {
  options = options || {};
  if (options.force === true) {
    return { ok: true, reason: 'forced' };
  }
  if (!entry || !entry.license) {
    return { ok: false, reason: 'unknown license (use --force to override)' };
  }
  if (Array.isArray(options.allowedCategories) && options.allowedCategories.length > 0) {
    if (entry.category && !options.allowedCategories.includes(entry.category)) {
      return { ok: false, reason: 'category ' + entry.category + ' not in allowed list' };
    }
  }
  if (Array.isArray(options.allowedLicenses) && options.allowedLicenses.length > 0) {
    if (!options.allowedLicenses.includes(entry.license)) {
      return { ok: false, reason: 'license ' + entry.license + ' not in allowed list' };
    }
  }
  return { ok: true };
}

function normalizeAnswer(answer) {
  if (typeof answer !== 'string') return null;
  return answer.trim().toLowerCase();
}

function isYesAnswer(answer) {
  const a = normalizeAnswer(answer);
  return a === 'y' || a === 'yes';
}

module.exports = {
  // Public API
  formatLicenseWarning,
  isLicenseAcceptable,
  isBrandCategory,
  isYesAnswer,
  // Constants
  STARTERS_CATEGORY,
  BRAND_CATEGORIES,
};
