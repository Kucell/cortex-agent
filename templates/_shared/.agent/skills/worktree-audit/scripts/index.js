#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 || !process.argv[index + 1] ? fallback : process.argv[index + 1];
}

function git(cwd, args, encoding = "utf8") {
  try {
    return { ok: true, stdout: execFileSync("git", args, { cwd, encoding, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { ok: false, stdout: encoding === "buffer" ? Buffer.alloc(0) : "", error: String(error.stderr || error.message || error).trim() };
  }
}

function parseWorktrees(raw) {
  return String(raw).split(/\n(?=worktree )/).filter(Boolean).map((block) => {
    const record = {};
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(" ");
      if (key) record[key] = rest.join(" ");
    }
    return record;
  });
}

function parseStatus(buffer) {
  const fields = Buffer.from(buffer).toString("utf8").split("\0");
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const file = { code, path: field.slice(3), untracked: code === "??", ignored: code === "!!", unmerged: UNMERGED.has(code) };
    files.push(file);
    if (/[RC]/.test(code[0])) index += 1;
  }
  return files.filter((file) => !file.ignored);
}

function fileTime(cwd, relativePath) {
  try { return fs.statSync(path.join(cwd, relativePath)).mtime.toISOString(); } catch { return null; }
}

function isDist(file) {
  return file.path === "dist" || file.path.startsWith("dist/") || file.path.includes("/dist/");
}

function classify(files) {
  if (!files.length) return { state: "clean", reasons: [], next_action: "No action required." };
  if (files.some((file) => file.unmerged)) {
    return {
      state: "recovery_required",
      reasons: ["Unmerged paths indicate an interrupted merge, rebase, or cherry-pick."],
      next_action: "The owner must explicitly resolve and continue, or explicitly abort the Git operation. Do not commit or merge this worktree first.",
    };
  }
  const reasons = [];
  if (files.some((file) => isDist(file))) reasons.push("dist changes require repository-specific tracked/generated-artifact review.");
  if (files.some((file) => file.untracked)) reasons.push("Untracked files require an owner decision before handoff or cleanup.");
  if (files.some((file) => !file.untracked && !isDist(file))) reasons.push("Tracked source changes require an explicit commit or handoff.");
  return { state: "owner_action_required", reasons, next_action: "Record an explicit owner decision: commit verified changes, create a handoff, or preserve the worktree for later recovery." };
}

function inspectWorktree(record) {
  const cwd = record.worktree;
  const status = git(cwd, ["status", "--porcelain=v1", "-z"], "buffer");
  if (!status.ok) return { path: cwd, state: "unavailable", error: status.error, files: [] };
  const files = parseStatus(status.stdout).map((file) => ({ ...file, modified_at: fileTime(cwd, file.path), category: file.unmerged ? "unmerged" : isDist(file) ? "dist" : file.untracked ? "untracked" : "tracked" }));
  return {
    path: cwd,
    branch: record.branch ? record.branch.replace(/^refs\/heads\//, "") : record.detached ? "detached" : "",
    head: record.HEAD || "",
    file_count: files.length,
    oldest_observed_file_mtime: files.map((file) => file.modified_at).filter(Boolean).sort()[0] || null,
    files,
    ...classify(files),
  };
}

function report(repo) {
  const listed = git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(`Unable to list worktrees: ${listed.error}`);
  return {
    type: "worktree_dirty_audit",
    observed_at: new Date().toISOString(),
    repository: path.resolve(repo),
    read_only: true,
    note: "oldest_observed_file_mtime is filesystem evidence, not a proven dirty-state start time.",
    worktrees: parseWorktrees(listed.stdout).map(inspectWorktree),
  };
}

function printHuman(value) {
  for (const worktree of value.worktrees) {
    if (worktree.state === "clean") continue;
    console.log(`${worktree.state}: ${worktree.path} (${worktree.file_count || 0} files)`);
    for (const reason of worktree.reasons || []) console.log(`  - ${reason}`);
    console.log(`  next: ${worktree.next_action || worktree.error}`);
  }
}

try {
  const value = report(option("--repo", process.cwd()));
  if (process.argv.includes("--dirty-only")) value.worktrees = value.worktrees.filter((worktree) => worktree.file_count > 0 || worktree.state === "unavailable");
  if (process.argv.includes("--json")) console.log(JSON.stringify(value, null, 2));
  else printHuman(value);
} catch (error) {
  console.error(`worktree audit failed: ${error.message}`);
  process.exitCode = 2;
}
