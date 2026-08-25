"use strict";

// ─── Cursor Adapter Bootstrap (M-031 MS-001) ──────────────────────────────────
//
// Aggregator for the M-031 cursor observer-mode adapter. Loading this module
// triggers the CursorAdapter self-register side effect so production CLI use
// can reach it via `cortex-agent agent adapter list` and `agent adapter
// health cursor` without modifying the CLI dispatcher or the bin entry
// point.
//
// Why this file exists (mirrors `lib/agents/adapters/dsh-bootstrap.js`):
//
//   `lib/agents/adapters/index.js#_seed()` already registers `cursor` via
//   try/catch injection (M-031 MS-001). That covers the default in-process
//   registry path. This bootstrap provides an OPT-IN, conservative
//   alternative for environments that explicitly prefer
//   `--require ./lib/agents/adapters/cursor-bootstrap.js` over the auto-seed
//   route (e.g. minimal-runtime deployments, worktree-local smoke tests,
//   users who want cursor to require explicit opt-in rather than being
//   part of the post-MS-031 baseline).
//
// Usage (per FAE-001 / F-010 pattern):
//
//   # Production CLI (real users, opt-in):
//   $ node -r ./lib/agents/adapters/cursor-bootstrap.js bin/cli.js \
//       agent adapter list
//   $ node -r ./lib/agents/adapters/cursor-bootstrap.js bin/cli.js \
//       agent adapter health cursor
//
//   # Programmatic API (3rd-party integration):
//   const bootstrap = require("cortex-agent/lib/agents/adapters/cursor-bootstrap");
//   // adapters.get("cursor") and adapters.list() now include "cursor"
//
// Hard constraints (per VC-031-001):
//   - Zero npm deps.
//   - No Cursor CLI call — CURSOR_BIN must be provided by the operator; this
//     bootstrap only wires the adapter into the in-process registry.
//   - Pure add: does not modify `lib/agents/registry.js` (M-002 frozen).
//   - Cursor is registered as observer mode only; invoke() is intentionally
//     not wired to a real dispatch.

require("./cursor");

module.exports = {
  loaded: true,
  loadedAt: new Date().toISOString(),
  adapters: ["cursor"],
  observer: true,
};
