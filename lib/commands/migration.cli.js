"use strict";
const path = require("node:path");
const migration = require("../offline-migration");
function migrationCommand(ctx) {
  const action = ctx.args[1];
  if (action === "help" || ctx.options.help || !action) {
    console.log("cortex-agent migration <inspect|plan> --project <path>\nRead-only phase. No backup, apply, switch or activation. Unknown data is unresolved.");
    return;
  }
  if (!["inspect", "plan"].includes(action)) {
    console.log(JSON.stringify({ ok: false, code: "MIGRATION_STAGE_NOT_IMPLEMENTED" })); process.exitCode = 2; return;
  }
  try {
    const result = migration[action](path.resolve(ctx.cwd, ctx.options.project || "."));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    if (result.status === "unresolved") process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code || "MIGRATION_INSPECTION_FAILED" })); process.exitCode = 1;
  }
}
module.exports = { migrationCommand };
