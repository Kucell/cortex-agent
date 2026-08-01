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

module.exports = { inferMode };
