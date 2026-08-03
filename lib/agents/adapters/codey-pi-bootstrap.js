"use strict";

// ─── Codey + Pi Adapter Bootstrap (M-003 MS-002) ────────────────────────────────
//
// Aggregator for the 2 MS-002 vendor adapters (codey + pi). Loading this
// module triggers each adapter's self-register side effect, making them
// visible to `cortex-agent agent adapter list` and dispatchable via
// `cortex-agent agent dispatch-execute codey:<id> | pi:<id>`.
//
// Why this file exists:
//
//   The MS-001 architecture used an explicit-aggregate pattern: claude-code
//   is registered inside `lib/agents/adapters/index.js`'s `_seed()` function
//   via a hard-coded `require("./claude-code")`. That works because MS-001
//   is the only adapter and the file is in scope for changes.
//
//   For MS-002 the validation contract forbids modifying `index.js` (it's
//   listed in the "不修改" set inside `lib/agents/adapters/`). The two new
//   adapters therefore self-register at module-load time, and a small
//   bootstrap file is needed so production CLI use can trigger that
//   registration without modifying the CLI dispatcher (`m003-cli.js`) or
//   the bin entry point (`bin/cli.js`).
//
// Usage (per the FAE-001 / F-010 pattern, see also
// `docs/architecture/adapter-authoring.md` §3 "Registration"):
//
//   # Production CLI (real users):
//   $ node -r ./lib/agents/adapters/codey-pi-bootstrap.js bin/cli.js \
//       agent adapter list
//   $ node -r ./lib/agents/adapters/codey-pi-bootstrap.js bin/cli.js \
//       agent dispatch-execute codey:Worker-B-MS002 "review the schema"
//
//   # Or via NODE_OPTIONS:
//   $ NODE_OPTIONS="--require ./lib/agents/adapters/codey-pi-bootstrap.js" \
//       cortex-agent agent adapter list
//
//   # Programmatic API (3rd-party integration):
//   const bootstrap = require("cortex-agent/lib/agents/adapters/codey-pi-bootstrap");
//   // adapters.get("codey") and adapters.get("pi") are now available
//
// The MS-005 e2e matrix should call this bootstrap from its setup hook to
// keep the 5-adapter integration test deterministic.
//
// ─── Deviations / Open questions ───────────────────────────────────────────────
//
//   - MS-001's index.js was the registration aggregator; MS-002's bootstrap
//     is the equivalent. If MS-003 (minimax) and MS-004 (multi-adapter
//     orchestration) want a cleaner story, we can add an opt-in
//     `index.js` extension hook (e.g. `adapters._registerFromDir(__dirname)`)
//     without breaking the MS-001 ship — but per validation contract that
//     is out of scope for MS-002.
//   - Listed in `.agent/missions/M-003/handoffs/<ts>-ms-002-codey-pi-done.md`
//     §"Deviations" so Eric can decide whether to keep the bootstrap or
//     promote it to a first-class `index.js` extension.

require("./codey");
require("./pi");

// Marker export so callers can confirm the bootstrap actually ran (useful
// for tests that want to assert "did we load MS-002 adapters?").
module.exports = {
  loaded: true,
  loadedAt: new Date().toISOString(),
  adapters: ["codey", "pi"],
};
