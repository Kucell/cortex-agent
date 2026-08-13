"use strict";

/**
 * Cortex Agent Graphify integration surface (T-GWG-001 / P-001).
 *
 * Re-exports every public module under lib/graphify so callers can
 * `require("@graphify")` style imports without knowing the file
 * layout. Keep the surface minimal and stable; downstream code (CLI
 * surface, init, doctor, hooks, /ship) only consumes these names.
 */

const manifest = require("./manifest");
const policy = require("./policy");
const worktree = require("./worktree");
const resolver = require("./resolver");
const markers = require("./markers");
const receipt = require("./receipt");
const hook = require("./hook");

module.exports = {
  manifest,
  policy,
  worktree,
  resolver,
  markers,
  receipt,
  hook,
};