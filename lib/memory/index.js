"use strict";

// ─── Memory barrel (M-002 MS-002) ─────────────────────────────────────────────
//
// Single import surface for the memory subsystem. Mirrors `lib/coordination/`
// (which exposes its public API via `application-service.js`).
//
// In-line barrel (not a re-export of every module) so:
//   1. Tests can `require("./")` and get a stable API.
//   2. Future modules (e.g. `validate.js`, `index-yaml.js`) can join without
//      breaking callers.
//   3. Internal modules stay private (use direct paths in lib/memory/* tests).

const { TYPES, ALL_TYPES, WRITABLE_TYPES, DEFAULT_EXPIRY_DAYS, isValidType, isWritableType, parseTypeList } = require("./types");
const store = require("./store");
const { recall } = require("./recall");
const { distill, generateMemoryId, buildEntry } = require("./distill");
const { memoryCommand, parseArgs } = require("./cli");

module.exports = {
  // types
  TYPES,
  ALL_TYPES,
  WRITABLE_TYPES,
  DEFAULT_EXPIRY_DAYS,
  isValidType,
  isWritableType,
  parseTypeList,
  // store
  store,
  // operations
  recall,
  distill,
  generateMemoryId,
  buildEntry,
  // CLI
  memoryCommand,
  parseArgs,
};
