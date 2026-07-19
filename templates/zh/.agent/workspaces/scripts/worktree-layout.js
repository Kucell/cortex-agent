#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) out._.push(value);
    else {
      const key = value.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}

function git(repo, commandArgs) {
  return cp.execFileSync("git", ["-C", repo, ...commandArgs], { encoding: "utf8" });
}

function canonical(input) {
  const absolute = path.resolve(input);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(canonical(parent), path.basename(absolute));
}

function repoRoot(input) {
  const root = git(path.resolve(input || process.cwd()), ["rev-parse", "--show-toplevel"]).trim();
  if (!root) fail("repository root not found");
  return canonical(root);
}

function cleanName(value, repoName) {
  let name = String(value || "").trim();
  if (name.startsWith(`${repoName}-`)) name = name.slice(repoName.length + 1);
  name = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name || name === "." || name === "..") fail("invalid worktree child name");
  return name;
}

function layout(root, options) {
  const repoName = path.basename(root);
  const configured = options.root || process.env.CORTEX_WORKTREE_ROOT;
  const container = canonical(configured || path.join(path.dirname(root), `${repoName}-worktrees`));
  if (container === root || container.startsWith(`${root}${path.sep}`)) {
    if (!options["allow-internal"]) fail("repository-internal worktree roots require --allow-internal");
  }
  return { repo_root: root, repo_name: repoName, worktree_root: container };
}

function parsePorcelain(value) {
  const records = [];
  let current = null;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice(9), branch: null, head: null, detached: false, prunable: false };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7);
    else if (current && line === "detached") current.detached = true;
    else if (current && line.startsWith("prunable")) current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

function resolveCommand(options) {
  const root = repoRoot(options.repo);
  const info = layout(root, options);
  const raw = options.name || options["task-id"] || options["mission-id"];
  if (!raw) fail("resolve requires --name, --task-id, or --mission-id");
  const name = cleanName(raw, info.repo_name);
  return { ...info, child_name: name, worktree_path: path.join(info.worktree_root, name) };
}

function planCommand(options) {
  const root = repoRoot(options.repo);
  const info = layout(root, options);
  const records = parsePorcelain(git(root, ["worktree", "list", "--porcelain"]));
  const targets = new Set();
  const worktrees = records.map((record) => {
    const absolute = path.resolve(record.path);
    if (absolute === root) return { ...record, is_main: true, target_path: root, migration: "keep" };
    const child = cleanName(path.basename(absolute), info.repo_name);
    const target = path.join(info.worktree_root, child);
    let migration = "inspect_required";
    const blockers = ["full_status_and_active_process_audit_required"];
    if (fs.existsSync(target) && target !== absolute) { migration = "blocked"; blockers.push("target_exists"); }
    if (targets.has(target)) { migration = "blocked"; blockers.push("target_collision"); }
    targets.add(target);
    return { ...record, is_main: false, target_path: target, migration, blockers };
  });
  return { schema_version: "1.0", mode: "read_only_migration_plan", ...info, worktrees };
}

const options = args(process.argv.slice(2));
const command = options._[0];
let result;
try {
  if (command === "resolve") result = resolveCommand(options);
  else if (command === "plan") result = planCommand(options);
  else fail("usage: worktree-layout.js resolve|plan --repo <path> [--root <path>] [--name <id>]");
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
