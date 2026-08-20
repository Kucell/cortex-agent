"use strict";

// ─── license — 4-kind license governance (P-001 MS-002 follow-up) ─────────────
//
// Wraps the existing lib/design/license.js (T-OD-001 frozen) with 4-kind
// awareness. Uses lib/catalog/kind-map.resolveLicense() to walk the per-kind
// `licenseSources` ordering (open-design.json#/license → SKILL.md#frontmatter/license
// fallback for plugin, etc.).
//
// Three public surfaces:
//   normalizeLicense(kind, fileTree)   — extract from a file tree
//   formatLicenseWarning(entry, kind)  — human-readable prompt text
//   isAcceptable(entry, opts)          — fail-closed gate (calls lib/design/license.js)
//
// All delegates to T-OD-001 where possible to avoid license-rule drift.

const designLicense = require("../design/license");
const { KINDS, getKind, resolveLicense } = require("./kind-map");

/**
 * Normalize a per-kind license string. Returns `{ value, source } | null`.
 *
 * @param {string} kind
 * @param {Record<string, object>} fileTree
 */
function normalizeLicense(kind, fileTree) {
  if (!KINDS[kind]) {
    throw new Error(`license.normalizeLicense: unknown kind "${kind}"`);
  }
  return resolveLicense(kind, fileTree);
}

/**
 * Format a license warning prompt. Delegates to lib/design/license.formatLicenseWarning
 * for design-system (T-OD-001 rule set); for other 3 kinds uses a slightly
 * shorter variant (no brand category check yet).
 *
 * @param {{ id, license, category? }} entry
 * @param {string} kind
 * @returns {string}  multi-line text (always a string; design-system returns
 *                    joined text, other kinds also join for consistency)
 */
function formatLicenseWarning(entry, kind) {
  if (!KINDS[kind]) {
    throw new Error(`license.formatLicenseWarning: unknown kind "${kind}"`);
  }
  if (kind === "design-system") {
    return designLicense.formatLicenseWarning(entry);
  }
  // 3 other kinds: simpler prompt (no brand category).
  const lines = [];
  lines.push(`About to install:`);
  lines.push(`  id:          ${entry.id || "(unknown)"}`);
  lines.push(`  kind:        ${kind}`);
  lines.push(`  license:     ${entry.license || "unknown"}`);
  lines.push("");
  if (!entry.license) {
    lines.push("Warning: license is unknown. Install will fail unless --force is set.");
    lines.push("");
  }
  lines.push("Proceed? [y/N]");
  return lines.join("\n");
}

/**
 * Determine if a license is acceptable. For design-system, delegates to T-OD-001
 * rules (allowedLicenses, brand category, fail-closed on missing). For other
 * 3 kinds uses a simpler gate: rejects "unknown"/empty; otherwise passes.
 *
 * @param {{ license, category? }} entry
 * @param {object} [opts]
 * @returns {{ acceptable: boolean, reason?: string }}
 */
function isAcceptable(entry, kind, opts) {
  opts = opts || {};
  if (!KINDS[kind]) {
    return { acceptable: false, reason: `unknown kind "${kind}"` };
  }
  if (kind === "design-system") {
    // T-OD-001 isLicenseAcceptable returns { ok, reason }.
    const result = designLicense.isLicenseAcceptable(entry, opts);
    return result.ok
      ? { acceptable: true, reason: result.reason }
      : { acceptable: false, reason: result.reason };
  }
  if (!entry || !entry.license || typeof entry.license !== "string" || entry.license.length === 0) {
    return { acceptable: false, reason: "license missing or empty" };
  }
  if (opts.allowedLicenses && Array.isArray(opts.allowedLicenses)) {
    if (!opts.allowedLicenses.includes(entry.license)) {
      return {
        acceptable: false,
        reason: `license "${entry.license}" not in allowedLicenses whitelist`,
      };
    }
  }
  return { acceptable: true };
}

/**
 * Prompt the user to ack a license. Reads from stdin via `reader` (default: sync
 * readline question). Returns the user's "y" or "yes" answer as boolean.
 *
 * @param {{ id, license, category? }} entry
 * @param {string} kind
 * @param {{ yes?: boolean, prompt?: (text: string) => Promise<string> }} [opts]
 * @returns {Promise<boolean>}
 */
async function promptAck(entry, kind, opts) {
  opts = opts || {};
  if (opts.yes === true) return true;
  const meta = getKind(kind);
  const warningText = formatLicenseWarning(entry, kind);
  const promptText = `\n${warningText}\nAcknowledge ${meta.licenseDefault}? [y/N] `;
  const answer = opts.prompt
    ? await opts.prompt(promptText)
    : await defaultPrompt(promptText);
  return /^y(es)?$/i.test(String(answer || "").trim());
}

async function defaultPrompt(text) {
  // Lazy require so this module remains Node.js-builtin-only at import time.
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(text, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

module.exports = {
  normalizeLicense,
  formatLicenseWarning,
  isAcceptable,
  promptAck,
};