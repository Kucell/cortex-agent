"use strict";

// Backward-compatible repository export. The installable management API
// module is the source of truth so generated projects do not depend on the
// Cortex Agent repository layout.
module.exports = require("../../templates/_shared/.agent/skills/management-api/scripts/query-dispatch-state.js");
