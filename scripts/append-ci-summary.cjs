#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// scripts/append-ci-summary.cjs
// ---------------------------------------------------------------------------
// Renders benchmark summaries into the GitHub Actions job summary.
//
// A gate that only writes a JSON file into .agent/metrics/ is invisible to
// whoever reads the CI run. The number that matters — how the candidate
// scored, and against which threshold — has to be readable without opening an
// artifact.
//
// The script is a no-op outside CI: with no GITHUB_STEP_SUMMARY it prints the
// same markdown to stdout, so a local run shows exactly what CI would show.
//
// Usage:
//   node scripts/append-ci-summary.cjs --title "<heading>" \
//     --input <summary.json> [--input <summary.json> ...]
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = { inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    if (key === "input") args.inputs.push(value);
    else args[key] = value;
    index += 1;
  }
  return args;
}

function readSummary(file) {
  // A step that runs `if: always()` must not fail because an earlier gate
  // failed before it wrote its file. A missing summary is reported, not fatal.
  if (!fs.existsSync(path.resolve(file))) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    return null;
  }
  if (!Array.isArray(data.candidates)) return null;
  return data;
}

function render(title, summaries, missing) {
  const lines = [];
  lines.push(`### ${title}`);
  lines.push("");
  if (summaries.length) {
    lines.push("| dataset | candidate | quality (bp) | passed | total | cost (µ$) | duration (ms) |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const summary of summaries) {
      for (const candidate of summary.candidates) {
        lines.push(
          `| ${summary.dataset_id} | ${candidate.candidate_id} | ${candidate.quality_basis_points} | ${candidate.passed_assertions} | ${candidate.total_assertions} | ${candidate.cost_microunits} | ${candidate.duration_ms} |`
        );
      }
    }
    lines.push("");
  }
  for (const file of missing) {
    lines.push(`> ⚠️ \`${file}\` 未生成——对应门禁可能在此之前就失败了。`);
  }
  if (missing.length) lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputs.length) {
    process.stderr.write("append-ci-summary: at least one --input is required\n");
    process.exit(2);
  }

  const missing = [];
  const summaries = [];
  for (const file of args.inputs) {
    const summary = readSummary(file);
    if (summary) summaries.push(summary);
    else missing.push(file);
  }
  if (!summaries.length) {
    process.stderr.write(`append-ci-summary: no readable summary in ${args.inputs.join(", ")}\n`);
    process.exit(2);
  }

  const markdown = render(String(args.title || "Benchmark"), summaries, missing);

  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) {
    fs.appendFileSync(target, markdown);
  }
  process.stdout.write(markdown);
}

if (require.main === module) {
  main();
}

module.exports = { render };
