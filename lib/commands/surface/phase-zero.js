"use strict";

// ─── phaseZeroAutomation — re-export of the Phase 0 contract stub ────────────
//
// Originally lived in lib/commands.js (re-exported from lib/automation-stubs.js
// at line 15 of the old file). Extracted so callers can require
// `./commands/surface/phase-zero` without dragging in the rest of the 3000-line
// command surface.

const { phaseZeroAutomation } = require("../../automation/stubs.js");

module.exports = { phaseZeroAutomation };
