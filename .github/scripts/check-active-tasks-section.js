#!/usr/bin/env node
"use strict";

// ─── check-active-tasks-section.js ──────────────────────────────────────────
//
// The task-progress.md view must contain exactly ONE active-tasks section.
//
// A long-lived file accumulates sections: writers append a new
// active-tasks block instead of updating the existing one, and readers then
// silently pick the wrong one. The parser resolves this by taking the last
// section with task rows, which is a recovery rule, not a permission to keep
// appending. This gate turns the drift into a build failure.
//
// Usage:
//   node .github/scripts/check-active-tasks-section.js [--file <path>]

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_REL = path.join(".agent", "plans", "task-progress.md");
const HEADING_RE = /^##\s+.*(?:当前活跃任务|Active Tasks).*$/gm;

function countActiveSections(content) {
  const matches = String(content || "").match(HEADING_RE);
  return matches ? matches.length : 0;
}

function main(argv) {
  const args = argv.slice(2);
  const index = args.findIndex((arg) => arg === "--file");
  const target = index >= 0 && args[index + 1]
    ? path.resolve(process.cwd(), args[index + 1])
    : path.resolve(process.cwd(), DEFAULT_REL);

  if (!fs.existsSync(target)) {
    console.log("ok: " + path.relative(process.cwd(), target) + " does not exist");
    return 0;
  }

  const count = countActiveSections(fs.readFileSync(target, "utf8"));
  if (count > 1) {
    console.error("task-progress.md has " + count + " active-tasks sections; exactly one is allowed.");
    console.error("Merge them into one, then re-run render-progress to regenerate the view.");
    return 1;
  }
  console.log("ok: " + count + " active-tasks section");
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { countActiveSections, main, HEADING_RE };
