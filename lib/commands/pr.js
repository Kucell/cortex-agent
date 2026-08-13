"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function exit(code) {
  process.exitCode = code;
  return code;
}

function printHelp() {
  process.stdout.write([
    "Usage: cortex-agent pr merge <pr-number> --gate user [options]",
    "",
    "Options are forwarded to the project vcs-pr runtime, including:",
    "  --commit-message <text>",
    "  --owner <owner>",
    "  --repo <repo>",
    "  --run-id <run-id>",
    "",
    "PR merge is never automatic. The explicit --gate user flag is required.",
    "",
  ].join("\n"));
}

function parsePrArgs(args) {
  const parsed = { subcommand: null, prNumber: null, gate: null, forwarded: [] };
  const input = args[0] === "pr" ? args.slice(1) : args.slice();

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!parsed.subcommand && !value.startsWith("--")) {
      parsed.subcommand = value;
      continue;
    }
    if (!parsed.prNumber && !value.startsWith("--")) {
      parsed.prNumber = value;
      continue;
    }
    if (value === "--gate") {
      const gate = input[index + 1];
      if (!gate || gate.startsWith("--")) return { error: "--gate requires a value" };
      parsed.gate = gate;
      parsed.forwarded.push(value, gate);
      index += 1;
      continue;
    }
    parsed.forwarded.push(value);
  }
  return parsed;
}

function resolveVcsPrScript(cwd, existsSync = fs.existsSync) {
  const projectScript = path.join(cwd, ".agent", "skills", "vcs-pr", "scripts", "index.js");
  if (existsSync(projectScript)) return projectScript;

  const bundledScript = path.resolve(
    __dirname,
    "..",
    "..",
    "templates",
    "en",
    ".agent",
    "skills",
    "vcs-pr",
    "scripts",
    "index.js"
  );
  return existsSync(bundledScript) ? bundledScript : null;
}

function prCommand(ctx, dependencies = {}) {
  const parsed = parsePrArgs(Array.isArray(ctx.args) ? ctx.args : []);
  if (parsed.error) {
    process.stderr.write(`[pr] ${parsed.error}\n`);
    return exit(1);
  }
  if (parsed.help || !parsed.subcommand) {
    printHelp();
    return exit(0);
  }
  if (parsed.subcommand !== "merge") {
    process.stderr.write(`[pr] unknown subcommand: ${parsed.subcommand}\n`);
    return exit(2);
  }
  if (!parsed.prNumber || !/^\d+$/.test(parsed.prNumber)) {
    process.stderr.write("[pr] merge requires a numeric <pr-number>\n");
    return exit(1);
  }
  if (parsed.gate !== "user") {
    process.stderr.write("[pr] merge requires explicit --gate user authorization\n");
    return exit(2);
  }

  const existsSync = dependencies.existsSync || fs.existsSync;
  const script = dependencies.script || resolveVcsPrScript(ctx.cwd, existsSync);
  if (!script) {
    process.stderr.write("[pr] vcs-pr runtime is unavailable; run cortex-agent update first\n");
    return exit(3);
  }

  const spawn = dependencies.spawnSync || spawnSync;
  const result = spawn(
    process.execPath,
    [script, "merge", "--pr-number", parsed.prNumber, ...parsed.forwarded],
    { cwd: ctx.cwd, stdio: "inherit" }
  );
  if (result.error) {
    process.stderr.write(`[pr] failed to start vcs-pr runtime: ${result.error.message}\n`);
    return exit(3);
  }
  return exit(Number.isInteger(result.status) ? result.status : 3);
}

module.exports = { parsePrArgs, prCommand, resolveVcsPrScript };
