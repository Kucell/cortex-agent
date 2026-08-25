"use strict";

// Barrel export for the runtime-adapters contract surface (M-001).
// Avoid pulling this file from adapter implementations — it exists to keep
// focused contract tests decoupled from the contract file paths.
//
// M-031 MS-001 (P-007 host adapter completeness round, approved
// D-ARI-P007-host-completeness revision 4c50a96c...): exposes the
// read-only `hostRuntimeSnapshots` view. MS-002 deliberately does NOT
// add a second skill-discovery surface here — VC-031-DRIFT-002 forbids
// inventing a second whitelist/discovery truth source — discovery
// parity stays in the canonical
// `lib/runtime-adapters/minimax-cli-skill-discovery.js`.

const capabilityContract = require("./capability-contract");
const boundaryEvent = require("./boundary-event");
const contextTrajectory = require("./context-trajectory");
const hostRuntimeSnapshots = require("./host-runtime-snapshots");

module.exports = {
  capability: capabilityContract,
  event: boundaryEvent,
  contextTrajectory,
  hostRuntimeSnapshots,
};
