"use strict";

// Barrel export for the runtime-adapters contract surface (M-001).
// Avoid pulling this file from adapter implementations — it exists to keep
// focused contract tests decoupled from the contract file paths.

const capabilityContract = require("./capability-contract");
const boundaryEvent = require("./boundary-event");

module.exports = {
  capability: capabilityContract,
  event: boundaryEvent,
};
