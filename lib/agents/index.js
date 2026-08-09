"use strict";

// ─── Agent Registry barrel (M-002 MS-003) ─────────────────────────────────────

const registry = require("./registry");
const { discover } = require("./discover");
const { invoke, INVOCABLE_STATUSES, buildInvocationPlan, generateRunId } = require("./invoke");
const { agentRegistryCommand, parseArgs } = require("./cli");

module.exports = {
  // types/constants
  VALID_ROLES: registry.VALID_ROLES,
  VALID_STATUSES: registry.VALID_STATUSES,
  VALID_ADAPTER_TYPES: registry.VALID_ADAPTER_TYPES,
  INVOCABLE_STATUSES,
  // registry
  registry,
  // operations
  discover,
  invoke,
  buildInvocationPlan,
  generateRunId,
  // CLI
  agentRegistryCommand,
  parseArgs,
};
