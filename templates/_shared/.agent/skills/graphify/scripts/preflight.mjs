#!/usr/bin/env node
// MS-001 (P-009) - Graphify preflight: dry-run fs/path checks, no network IO.
//
// Usage:
//   node .agent/skills/graphify/scripts/preflight.mjs [--project <path>]
//
// Prints a machine-readable JSON report and exits 0 only when every check
// passes. The script never imports a network module and never writes outside
// the project it inspects.

import { existsSync, statSync, accessSync, constants } from "node:fs";
import { resolve, join } from "node:path";

const argv = process.argv.slice(2);

function flagValue(name) {
  const inline = argv.find((arg) => typeof arg === "string" && arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && typeof argv[index + 1] === "string") return argv[index + 1];
  return null;
}

const projectRoot = resolve(flagValue("--project") || process.cwd());

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail || "" });
}

function isDirectory(target) {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch (_) {
    return false;
  }
}

// 1. The resolved project root exists and is a directory.
check("project_root", isDirectory(projectRoot), projectRoot);

// 2. The project carries a .agent governance root.
const agentRoot = join(projectRoot, ".agent");
check("agent_dir", isDirectory(agentRoot), agentRoot);

// 3. The graphify skill is installed.
const skillRoot = join(agentRoot, "skills", "graphify");
check("graphify_skill", isDirectory(skillRoot), skillRoot);

// 4. A real graphify entry point is present (skill scripts or plugin). The
//    preflight script itself is excluded so this check cannot self-satisfy.
const entryCandidates = [
  join(skillRoot, "scripts", "index.mjs"),
  join(skillRoot, "scripts", "index.js"),
  join(agentRoot, "plugins", "graphify", "scripts", "extract-subgraph.js"),
];
const entry = entryCandidates.find((candidate) => existsSync(candidate)) || null;
check("graphify_entry", Boolean(entry), entry || entryCandidates.join(" | "));

// 5. The project root is writable so graphify-out/ can be created later.
let writable = false;
let writableDetail = projectRoot;
try {
  accessSync(projectRoot, constants.W_OK);
  writable = true;
} catch (err) {
  writableDetail = err.message;
}
check("graphify_cache_writable", writable, writableDetail);

const pass = checks.filter((item) => item.ok).length;
const fail = checks.length - pass;
const report = { ok: fail === 0, checks, summary: { total: checks.length, pass, fail } };

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(fail === 0 ? 0 : 1);
