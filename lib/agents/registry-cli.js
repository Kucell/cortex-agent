"use strict";

const path = require("node:path");
const { register, setEnabled } = require("./registry-managed");
const { reject } = require("./registry-identity");

const ACTIONS = new Set(["register", "enable", "disable"]);
const USAGE = `Usage:
  cortex-agent agent register --project <path> --identity-json <json> --actor <maintainer> --session <native-session> [--json]
  cortex-agent agent <enable|disable> <agent_id> --project <path> --actor <maintainer> --session <native-session> [--json]
Owner policy: .agent/config/agent-registry.json (local same-user authority).
Registration starts disabled. These commands never create Task/Session/Lease records.`;

function parse(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") { options.json = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const key = arg.slice(2, separator < 0 ? undefined : separator);
    if (!["project", "identity-json", "actor", "session"].includes(key)
        || Object.prototype.hasOwnProperty.call(options, key)) reject("INVALID_USAGE", `Unknown or duplicate option: --${key}`);
    const value = separator < 0 ? args[++i] : arg.slice(separator + 1);
    if (!value || value.startsWith("--")) reject("INVALID_USAGE", `Missing --${key} value`);
    options[key] = value;
  }
  return { options, positional };
}

function runRegistryWrite(args, cwd = process.cwd()) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  try {
    const { options, positional } = parse(args);
    const [action, id] = positional;
    if (!ACTIONS.has(action) || !options.actor || !options.session
        || (action === "register" ? positional.length !== 1 || !options["identity-json"]
          : positional.length !== 2 || options["identity-json"])) reject("INVALID_USAGE", USAGE);
    const root = path.resolve(cwd, options.project || ".");
    const auth = { actor_id: options.actor, session_id: options.session };
    let entry;
    if (action === "register") {
      let identity;
      try { identity = JSON.parse(options["identity-json"]); }
      catch (_) { reject("INVALID_USAGE", "--identity-json must be valid JSON"); }
      entry = register(root, identity, auth);
    } else entry = setEnabled(root, id, action === "enable", auth);
    process.stdout.write(JSON.stringify({ ok: true, command: `agent.${action}`, agent: entry }, null, 2) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: {
      code: error.code || "ERR_REGISTRY_WRITE", message: error.message,
      ...(error.committed ? { committed: true } : {}),
      ...(error.cleanup ? { cleanup: error.cleanup, remaining_artifacts: error.remaining_artifacts } : {}),
    } }, null, 2) + "\n");
    process.exitCode = error.code === "INVALID_USAGE" ? 2 : 3;
  }
}

module.exports = { ACTIONS, USAGE, runRegistryWrite };
