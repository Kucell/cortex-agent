"use strict";

// Exact early route for the package-owned read-only projection. Other commands
// keep their existing dispatcher. Validate argv before loading query adapters.
function parseNextActionArgs(args) {
  if (!Array.isArray(args) || args[0] !== "query" || args[1] !== "next-action") return null;
  const options = { track: false };
  let projectSeen = false;
  for (let index = 2; index < args.length; index += 1) {
    const raw = args[index];
    if (typeof raw !== "string" || !raw.startsWith("--")) {
      return { error: { code: "INVALID_QUERY_USAGE", message: "Unexpected positional argument." }, usage: true };
    }
    const equalAt = raw.indexOf("=");
    const name = (equalAt === -1 ? raw : raw.slice(0, equalAt)).slice(2);
    if (name !== "project" && name !== "task") {
      return { error: { code: "INVALID_QUERY_OPTION", message: "Projection next-action does not support --" + name + ".", details: { projection: "next-action", option: name, supported: ["task"] } } };
    }
    const value = equalAt === -1 ? args[++index] : raw.slice(equalAt + 1);
    if (!value || value.startsWith("--")) {
      return { error: { code: name === "project" ? "INVALID_PROJECT_OPTION" : "INVALID_QUERY_OPTION", message: "--" + name + " requires a non-empty value." } };
    }
    if (name === "project") {
      if (projectSeen) return { error: { code: "INVALID_PROJECT_OPTION", message: "--project may be supplied once." } };
      projectSeen = true;
      options.project = value;
    }
  }
  return { options };
}

function runNextActionQuery(args, cwd) {
  const parsed = parseNextActionArgs(args);
  if (!parsed) return false;
  const ctx = { args, cwd, command: "query", options: parsed.options || { track: false },
    lang: process.env.LANG && process.env.LANG.startsWith("zh") ? "zh" : "en" };
  if (parsed.error) {
    const { invalidManagementUsage, managementApiError } = require("../commands/management/api-helpers.js");
    if (parsed.usage) invalidManagementUsage("cortex-agent query <projection> [--project <path>] [projection filters]");
    else managementApiError(ctx, { error: parsed.error, exitCode: 2 });
    return true;
  }
  require("../commands/management/query.js").managementQuery(ctx);
  return true;
}

module.exports = { parseNextActionArgs, runNextActionQuery };
