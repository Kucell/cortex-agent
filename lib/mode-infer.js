"use strict";

/**
 * Mode inference for `cortex-agent init`.
 *
 * MS-002 introduces a second init profile ("general") that lays down a
 * shared `.agent/` data-layer (inbox, decisions, runs, sessions, missions,
 * handoffs, conversations, memory, agents, tasks, waitpoints) without the
 * code-project knowledge base that `init` already ships under
 * `templates/{zh,en}/.agent/`. MS-003 will use this helper to auto-pick a
 * mode when the user does not pass `--mode` explicitly.
 *
 * Resolution order (first hit wins):
 *   1. <cwd>/AGENTS.md                       -> 'general'
 *   2. <cwd>/.cursorrules                    -> 'code'
 *   3. <cwd>/.github/copilot-instructions.md -> 'code'
 *   4. <cwd>/package.json                    -> 'code'
 *   5. otherwise (empty / non-code dir)      -> 'general'
 *
 * Pure-Node stdlib only — zero dependencies. No fs writes.
 */

const fs = require("fs");
const path = require("path");

const CODE_SIGNALS = [
  ".cursorrules",
  path.join(".github", "copilot-instructions.md"),
  "package.json",
];

function inferMode(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("inferMode(cwd): cwd must be a non-empty string");
  }

  // 1. AGENTS.md is the explicit "this is a general / docs project" marker.
  //    We treat its presence as authoritative because writers of AGENTS.md
  //    in a code project do so *in addition* to other signals, and we
  //    prefer a documented general-mode intent over a coincidental
  //    package.json.
  if (fs.existsSync(path.join(cwd, "AGENTS.md"))) {
    return "general";
  }

  // 2-4. Code signals. Listed in priority order; first hit wins.
  for (const rel of CODE_SIGNALS) {
    if (fs.existsSync(path.join(cwd, rel))) {
      return "code";
    }
  }

  // 5. Empty / unrecognised directory: general is the safe default — it
  //    lays down only the data layer, which the user can later enrich
  //    with a knowledge base.
  return "general";
}

// ─── MS-003 helpers ────────────────────────────────────────────────────────────
// Pure additions. Do not modify the inferMode() function above — MS-002 ships
// that as the canonical 5-rule priority list and the unit tests in
// tests/init-mode-general.test.js pin its behaviour. The two helpers below
// sit alongside it so `bin/cli.js` can auto-pick a mode when the user omits
// `--mode`, and so callers have a single source of truth for "which template
// directory backs a given mode".

/**
 * Should the CLI auto-infer the init mode?
 *
 * Returns true when no `--mode` / `-m` flag was passed. The CLI uses this to
 * decide whether to call `inferMode(cwd)` and inject the result into
 * `options.mode`. If the user was explicit (any flavour of `--mode` or `-m`)
 * the helper returns false and the user-supplied value wins.
 *
 * Pure function — reads only from `ctx.options` and `ctx.args`. Never
 * touches the filesystem.
 *
 * @param {{ options?: { mode?: string }, args?: string[] }} ctx
 * @returns {boolean}
 */
function isInferModeEnabled(ctx) {
  const options = ctx && ctx.options;
  const args = (ctx && ctx.args) || [];

  // Explicit --mode wins, even when the user passed a bogus value — we want
  // the error to surface from the existing MS-002 dispatch, not a silent
  // override from inferMode().
  if (options && typeof options.mode === "string" && options.mode.length > 0) {
    return false;
  }
  if (args.includes("--mode") || args.includes("-m")) return false;
  if (args.some((a) => typeof a === "string" && a.startsWith("--mode="))) {
    return false;
  }
  if (args.some((a) => typeof a === "string" && a.startsWith("-m="))) {
    return false;
  }
  return true;
}

/**
 * Resolve the on-disk `.agent` template directory for a given mode.
 *
 * Centralises "which template backs mode X" so future modes (Phase 2+) can
 * add a single branch here without scattering the logic across bin/cli.js.
 *
 *   mode === 'general' -> <repoRoot>/templates/_base/.agent
 *   mode === 'code'    -> <repoRoot>/templates/{lang}/.agent
 *
 * `options.lang` is honoured for the code branch; defaults to 'en' to match
 * `bin/cli.js` defaultLang fallback. Throws on unknown modes — callers
 * should treat that as a programming error, not a user error.
 *
 * @param {string} repoRoot  Absolute path to the cortex-agent repo root
 *                           (e.g. path.join(__dirname, '..') from lib/).
 * @param {string} mode      'code' | 'general'
 * @param {{ lang?: string }} [options]
 * @returns {string} Absolute path to the .agent template directory
 */
function selectTemplateDir(repoRoot, mode, options) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new TypeError(
      "selectTemplateDir(repoRoot, mode, options): repoRoot must be a non-empty string",
    );
  }
  if (mode !== "code" && mode !== "general") {
    throw new RangeError(
      `selectTemplateDir: unsupported mode '${mode}' (use 'code' or 'general')`,
    );
  }
  const lang = (options && options.lang) || "en";
  if (mode === "general") {
    return path.join(repoRoot, "templates", "_base", ".agent");
  }
  return path.join(repoRoot, "templates", lang, ".agent");
}

module.exports = { inferMode, isInferModeEnabled, selectTemplateDir };
