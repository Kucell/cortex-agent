"use strict";

// ─── DSH Adapter Bootstrap (M-029 / P-006 / MS-002) ────────────────────────────
//
// Aggregator for the M-029 DSH first-class adapter. Loading this module
// triggers the DshAdapter self-register side effect so production CLI use
// can reach it via `cortex-agent agent adapter list` and `dispatch-execute
// dsh:<id>` without modifying the CLI dispatcher (`m003-cli.js`) or the
// bin entry point (`bin/cli.js`).
//
// Why this file exists (mirrors `lib/agents/adapters/codey-pi-bootstrap.js`):
//
//   `lib/agents/adapters/index.js#_seed()` already registers `dsh` via
//   try/catch injection (M-029 MS-002). That covers the default in-process
//   registry path. This bootstrap provides an OPT-IN, conservative
//   alternative for environments that explicitly prefer
//   `--require ./lib/agents/adapters/dsh-bootstrap.js` over the auto-seed
//   route (e.g. minimal-runtime deployments, worktree-local smoke tests,
//   users who want DSH to require explicit opt-in rather than being part
//   of the post-MS-029 baseline).
//
// Usage (per FAE-001 / F-010 pattern):
//
//   # Production CLI (real users, opt-in):
//   $ node -r ./lib/agents/adapters/dsh-bootstrap.js bin/cli.js \
//       agent adapter list
//   $ node -r ./lib/agents/adapters/dsh-bootstrap.js bin/cli.js \
//       agent dispatch-execute dsh:Worker-B-M029 "review the schema"
//
//   # Or via NODE_OPTIONS:
//   $ NODE_OPTIONS="--require ./lib/agents/adapters/dsh-bootstrap.js" \
//       cortex-agent agent adapter health dsh
//
//   # Programmatic API (3rd-party integration):
//   const bootstrap = require("cortex-agent/lib/agents/adapters/dsh-bootstrap");
//   // adapters.get("dsh") and adapters.list() now include "dsh"
//
// Hard constraints (per VC-029-G01 / architecture-design.md):
//   - Zero npm deps.
//   - No DSH CLI call — DSH_BIN must be provided by the operator; this
//     bootstrap only wires the adapter into the in-process registry.
//   - Pure add: does not modify `lib/agents/registry.js` (M-002 frozen).
//
// ─── Deviations / Open questions ──────────────────────────────────────────────
//
//   - The `_seed()` injection in `lib/agents/adapters/index.js` is the
//     canonical registration site after M-029. This bootstrap is provided
//     as a parallel opt-in path; if MS-002 outcome favours collapsing both,
//     remove this file in a follow-up proposal and force users through
//     `_seed()`.
//   - Listed in `.agent/missions/M-029/handoffs/<ts>-ms-002-dsh-bootstrap.md`
//     §"Deviations" so the mission-coordinator can decide whether to keep
//     the bootstrap or promote the seed path to be the single source.

require("./dsh");

// Marker export so callers can confirm the bootstrap actually ran (useful
// for tests that want to assert "did we load the M-029 DSH adapter?").
module.exports = {
  loaded: true,
  loadedAt: new Date().toISOString(),
  adapters: ["dsh"],
};