"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
// Hold the direct child's stdout open briefly after the direct child exits.
const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 1500)"],
  { stdio: ["ignore", 1, "ignore"] });
fs.writeFileSync(process.argv[2], String(descendant.pid));
process.exit(0);
