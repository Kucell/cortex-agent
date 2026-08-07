"use strict";

// ─── askYesNo — shared prompt helper ─────────────────────────────────────────
//
// Used by `initModeGeneral` (lib/commands/init.js) and any other command
// that needs interactive confirmation. Returns `false` in non-TTY contexts
// (CI, piped stdin) so callers fall back to a safe default.

const readline = require("node:readline");

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y");
    });
  });
}

module.exports = { askYesNo };
