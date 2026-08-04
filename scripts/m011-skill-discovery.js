#!/usr/bin/env node
"use strict";

// ─── M-011 Portable Skill Discovery (ARI P-005) ────────────────────────────
// Usage:
//   node scripts/m011-skill-discovery.js [--project-root <path>] [--templates-root <path>] [--out <file>]
//
// Behaviour:
//   - Enumerates 13 portable Skill paths (Claude Code / Cursor / Pi / Codex /
//     common × user / project / template, where common has no user scope).
//   - Reports present=false (does NOT create files) for missing paths.
//   - Never invokes `mmx`.

const fs = require("node:fs");
const path = require("node:path");

const skillDiscovery = require("../lib/runtime-adapters/minimax-cli-skill-discovery");

function parseArgs(argv) {
  const args = {
    projectRoot: process.cwd(),
    templatesRoot: undefined,
    out: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project-root") args.projectRoot = path.resolve(argv[++i]);
    else if (a === "--templates-root") args.templatesRoot = path.resolve(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    "M-011 Skill Discovery (ARI P-005)",
    "",
    "Usage:",
    "  node scripts/m011-skill-discovery.js [--project-root <path>] [--templates-root <path>] [--out <file>]",
    "",
  ].join("\n"));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const options = { projectRoot: args.projectRoot };
  if (args.templatesRoot) options.templatesRoot = args.templatesRoot;

  const descriptors = skillDiscovery.discoverSkills(options);
  const summary = skillDiscovery.summarizeSkills(descriptors);
  const out = {
    schema_version: "1.0",
    discovered_at: new Date().toISOString(),
    project_root: args.projectRoot,
    templates_root: args.templatesRoot || path.join(args.projectRoot, "templates"),
    descriptors,
    summary,
  };
  const json = JSON.stringify(out, null, 2);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    const tmp = `${args.out}.tmp`;
    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, args.out);
  } else {
    process.stdout.write(json + "\n");
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`m011-skill-discovery failed: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, main };