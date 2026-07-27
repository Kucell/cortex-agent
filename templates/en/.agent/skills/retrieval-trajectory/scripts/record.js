#!/usr/bin/env node
/**
 * record — Append a step to the current retrieval trajectory.
 *
 * Inspired by OpenViking's observable retrieval: every search step leaves a
 * line so the user can replay the path and debug why a result was (or wasn't)
 * selected.
 *
 * Usage:
 *   node record.js --task-id T-DEMO-001 --step 1 --action scan --candidates 42
 *   node record.js --task-id T-DEMO-001 --step 3 --action promote --tier tier1 \
 *      --uri "cortex://skills/context-budget" --tokens 1200 --reason "score=9"
 *   node record.js --task-id T-DEMO-001 --summary  # close trajectory with summary
 *
 * Input:  flags (see below)
 * Output: JSON to stdout (the appended line + the file it was written to)
 *
 * Lines:
 *   - Default: appended to `.agent/runtime-evidence/trajectory/{task-id}_{timestamp}.jsonl`
 *   - If `--file` is provided, appended to that file
 *   - If `--summary`, writes a final {event:"summary"} line with computed deltas
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TRAJECTORY_DIR = path.join(ROOT, ".agent", "runtime-evidence", "trajectory");

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function findActiveFile(taskId) {
  if (!fs.existsSync(TRAJECTORY_DIR)) return null;
  const files = fs.readdirSync(TRAJECTORY_DIR)
    .filter((f) => f.startsWith(taskId + "_") && f.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (!files.length) return null;
  return path.join(TRAJECTORY_DIR, files[0]);
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(line) + "\n");
}

function summarize(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const header = lines.find((l) => l.event === "header");
  const steps = lines.filter((l) => l.event === "step");
  const promoted = steps.filter((s) => s.action === "promote");
  const l0only = steps.filter((s) => s.action === "l0_only");
  const tokens = steps.reduce((s, l) => s + (l.tokens || 0), 0);
  return {
    event: "summary",
    task_id: header && header.task_id,
    trajectory_file: file,
    step_count: steps.length,
    promoted_count: promoted.length,
    l0_only_count: l0only.length,
    total_tokens: tokens,
    closed_at: new Date().toISOString(),
  };
}

function main() {
  const args = parseArgs();
  const taskId = args["task-id"];
  if (!taskId) {
    console.log(JSON.stringify({ ok: false, error: "--task-id required" }, null, 2));
    return;
  }
  const file = args.file || findActiveFile(taskId) || path.join(TRAJECTORY_DIR, `${taskId}_${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

  if (args.summary) {
    const sum = summarize(file);
    if (!sum) {
      console.log(JSON.stringify({ ok: false, error: "trajectory file not found", file }, null, 2));
      return;
    }
    appendLine(file, sum);
    console.log(JSON.stringify({ ok: true, ...sum }, null, 2));
    return;
  }

  const line = {
    event: "step",
    idx: Number.isFinite(parseInt(args.idx, 10)) ? parseInt(args.idx, 10) : undefined,
    step: args.step ? parseInt(args.step, 10) : undefined,
    action: args.action,
    ts: new Date().toISOString(),
  };
  for (const k of ["candidates", "scored", "top_score", "tokens", "task_tokens", "path_hints"]) {
    if (args[k] !== undefined) {
      const n = Number(args[k]);
      line[k] = Number.isFinite(n) ? n : args[k];
    }
  }
  for (const k of ["uri", "tier", "reason", "scanned_pool", "task"]) {
    if (args[k] !== undefined) line[k] = args[k];
  }

  appendLine(file, line);
  console.log(JSON.stringify({ ok: true, file, line }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

module.exports = { summarize, findActiveFile };
