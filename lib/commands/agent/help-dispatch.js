"use strict";

// --- help-dispatch (M-035 MS-003 / P-009) ------------------------------------
//
// Contract documents live in the tracked top-level .help/ directory. Commands
// with a --help flag resolve their contract there before any argument
// validation runs, so help stays discoverable even when required flags are
// missing. Resolution is deliberately local: no network, no npm dependency.
//
// The directory is resolved against the package root (three levels above
// lib/commands/agent/), not the calling command file, so it keeps working
// from the published tarball.

const fs = require("node:fs");
const path = require("node:path");

const HELP_DIR = path.join(__dirname, "..", "..", "..", ".help");

const CONTRACTS = {
  "task create": "task-create.md",
  "lease acquire": "lease-acquire.md",
  "decisions request": "decisions-request.md",
  "agent adapter list": "agent-adapter-list.md",
};

function isHelpRequest(args) {
  return Array.isArray(args) && args.some((arg) => arg === "--help" || arg === "-h" || arg === "-?");
}

function contractFile(contractKey) {
  const file = CONTRACTS[contractKey];
  return file ? path.join(HELP_DIR, file) : null;
}

function readContract(contractKey) {
  const file = contractFile(contractKey);
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
}

// Contract key tokens: the leading non-flag words of a command line, capped at
// three. "decisions request --help" resolves to ["decisions","request"] so an
// unknown command falls through to its own help instead of borrowing an
// unrelated longer key.
function contractTokens(args) {
  if (!Array.isArray(args)) return [];
  const tokens = [];
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length === 0) continue;
    if (arg.startsWith("-")) break;
    tokens.push(arg);
    if (tokens.length === 3) break;
  }
  return tokens;
}

// Prints the contract for a command token sequence when one exists. Returns
// true when it handled the request so callers can skip argument validation.
// A missing .help/ file is reported when `strict` is set so a packaging gap
// cannot masquerade as handled help.
function dispatchHelp(args, options) {
  const settings = options || {};
  if (!settings.force && !isHelpRequest(args)) return false;
  const tokens = contractTokens(args);
  const writable = settings.write || ((chunk) => process.stdout.write(chunk));
  for (let take = tokens.length; take >= 1; take -= 1) {
    const key = tokens.slice(0, take).join(" ");
    const contract = readContract(key);
    if (contract) {
      writable(contract.endsWith("\n") ? contract : contract + "\n");
      return true;
    }
  }
  if (settings.strict && typeof settings.onMissing === "function") settings.onMissing(tokens.join(" "));
  return false;
}

module.exports = { dispatchHelp, isHelpRequest, readContract, contractFile, contractTokens, CONTRACTS, HELP_DIR };

