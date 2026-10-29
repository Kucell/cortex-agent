#!/usr/bin/env node
/**
 * replay — Replay a retrieval trajectory JSONL file.
 *
 * Inspired by OpenViking's test-fixture replay: re-runs the recorded steps
 * and verifies they still hit the same URIs. Useful for:
 *   - Regression: "did this query decay when the index changed?"
 *   - Debugging: "why did the agent pick this skill?"
 *   - Fixture building: turn a real trajectory into a deterministic test
 *
 * Usage:
 *   node replay.js --task-id T-DEMO-001
 *   node replay.js --file .agent/runtime-evidence/trajectory/T-DEMO-001_*.jsonl
 *   node replay.js --task-id T-DEMO-001 --verify-resolve    # also resolve cortex:// URIs
 *   node replay.js --task-id T-DEMO-001 --as-fixture         # output JSON for tests
 *
 * Output: JSON to stdout with replay summary.
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

function findActiveFile(taskId) {
  if (!fs.existsSync(TRAJECTORY_DIR)) return null;
  const files = fs.readdirSync(TRAJECTORY_DIR)
    .filter((f) => f.startsWith(taskId + "_") && f.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (!files.length) return null;
  return path.join(TRAJECTORY_DIR, files[0]);
}

function readTrajectory(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function resolveUri(uri) {
  // Try to resolve cortex:// URIs without uri-resolver dependency
  if (typeof uri !== "string" || !uri.startsWith("cortex://")) return { ok: false, uri };
  const stripped = uri.slice("cortex://".length);
  const slash = stripped.indexOf("/");
  if (slash === -1) return { ok: false, uri };
  const scope = stripped.slice(0, slash);
  const rest = stripped.slice(slash + 1);
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, ".agent", "registry", "uri-map.json"), "utf8"));
  const root = map.scopes && map.scopes[scope];
  if (!root) return { ok: false, uri, reason: `scope ${scope} not in uri-map.json` };
  const target = path.join(ROOT, root, ...rest.split("/"));
  return { ok: fs.existsSync(target), uri, path: path.relative(ROOT, target) };
}

function main() {
  const args = parseArgs();
  const file = args.file || (args["task-id"] ? findActiveFile(args["task-id"]) : null);
  if (!file) {
    console.log(JSON.stringify({ ok: false, error: "no trajectory file; specify --task-id or --file" }, null, 2));
    return;
  }
  const lines = readTrajectory(file);
  const header = lines.find((l) => l.event === "header");
  const summary = lines.find((l) => l.event === "summary");
  const steps = lines.filter((l) => l.event === "step");

  const verify = !!args["verify-resolve"];
  const asFixture = !!args["as-fixture"];

  const replay = {
    ok: true,
    file: path.relative(ROOT, file),
    header,
    summary,
    steps: steps.map((s) => {
      const out = { ...s };
      if (verify && s.uri) out.resolved = resolveUri(s.uri);
      return out;
    }),
  };

  if (verify) {
    const failed = replay.steps.filter((s) => s.resolved && s.resolved.ok === false);
    replay.resolution_failures = failed.length;
    replay.resolved_ok = replay.steps.length - failed.length;
    if (failed.length) {
      replay.ok = false;
      replay.failures = failed.map((f) => ({ uri: f.uri, reason: f.resolved.reason || "no path" }));
    }
  }

  if (asFixture) {
    replay.fixture = {
      trajectory_file: replay.file,
      task: (header && header.task) || null,
      expected_promoted: replay.steps.filter((s) => s.action === "promote").map((s) => s.uri),
      expected_l0_only: replay.steps.filter((s) => s.action === "l0_only").map((s) => s.uri),
    };
  }

  console.log(JSON.stringify(replay, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

module.exports = { readTrajectory, resolveUri };
