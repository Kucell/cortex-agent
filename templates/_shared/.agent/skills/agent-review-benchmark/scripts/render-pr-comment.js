#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// .agent/skills/agent-review-benchmark/scripts/render-pr-comment.js
// ---------------------------------------------------------------------------
// Renders a guided-review artifact into the markdown body of a pull request
// comment.
//
// Why this exists: the review loop was open at both ends.  `reviewer-backend`
// produces a validated artifact, but nothing could carry it to the place a
// human actually reads — the pull request.  This renderer is the missing
// middle: artifact in, comment body out.
//
// The renderer is deliberately pure and total:
//
//   * It never touches the network and never reads the workspace.  The
//     artifact is already validated by the backend; re-validating here would
//     create a second, weaker gate.
//   * It never invents content.  Every line it emits comes from a field of
//     the artifact.  A finding with an empty follow-up list contributes no
//     follow-up section — not a placeholder that reads like content.
//   * It is deterministic.  The same artifact renders to the same bytes, so
//     a re-render can be diffed against the previous one.
//
// Usage:
//   node .../render-pr-comment.js --input <guided-review.json> [--output <file>]
//
// The output is written to stdout when --output is absent.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

const RISK_ORDER = ["critical", "high", "medium", "low"];

// The CLI reports failures as JSON on stdout and exits non-zero.  As a
// library the same conditions throw, so a caller (or a test) can observe the
// failure instead of the process disappearing mid-assertion.
function fail(error, details, code = 1) {
  const failure = new Error(typeof details === "string" ? details : `${error}: ${JSON.stringify(details)}`);
  failure.code = code;
  failure.error = error;
  failure.details = details;
  throw failure;
}

// The CLI has no subcommand: every argument is a flag.  The parser starts at
// index 0 — treating argv[0] as a command would swallow `--input`.
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function readJson(file, label) {
  if (!file || file === true) fail(`${label}_required`, `Pass --${label}.`, 2);
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    fail(`${label}_unreadable`, { file, message: error.message }, 2);
    return null;
  }
}

// A heading must not contain a newline — a finding title with an embedded
// newline would break the markdown structure of everything after it.
function oneLine(value) {
  return String(value == null ? "" : value).replace(/\s*\n+\s*/g, " ").trim();
}

function headingFor(risk) {
  const labels = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
  };
  return labels[risk] || "Unknown";
}

// Findings are grouped by risk so the reader sees the severe ones first.
// Within a group the order is the artifact's own order — the backend already
// sorted findings by group_id, and re-sorting here would hide that.
function groupByRisk(groups) {
  const buckets = new Map();
  for (const group of groups) {
    const risk = group && group.risk ? group.risk : "low";
    if (!buckets.has(risk)) buckets.set(risk, []);
    buckets.get(risk).push(group);
  }
  const ordered = [];
  for (const risk of RISK_ORDER) {
    if (buckets.has(risk)) ordered.push({ risk, groups: buckets.get(risk) });
  }
  // Any risk value outside the known set still gets rendered — dropping a
  // finding because its risk label is unknown would hide a real finding.
  for (const [risk, groups] of buckets) {
    if (!RISK_ORDER.includes(risk)) ordered.push({ risk, groups });
  }
  return ordered;
}

function renderFinding(group, index) {
  const lines = [];
  const title = oneLine(group.title);
  lines.push(`#### ${index}. ${title}`);
  lines.push("");
  lines.push(`- **Risk**: ${headingFor(group.risk)}`);
  if (group.category) lines.push(`- **Category**: ${oneLine(group.category)}`);
  const files = Array.isArray(group.files) ? group.files : [];
  if (files.length) {
    lines.push(`- **Files**: ${files.map((file) => `\`${file}\``).join(", ")}`);
  }
  lines.push("");

  if (group.summary) {
    lines.push(oneLine(group.summary));
    lines.push("");
  }
  if (group.intent) {
    lines.push(`**Intent**: ${oneLine(group.intent)}`);
    lines.push("");
  }
  if (group.impact) {
    lines.push(`**Impact**: ${oneLine(group.impact)}`);
    lines.push("");
  }
  const validationRefs = Array.isArray(group.validation_refs) ? group.validation_refs : [];
  if (validationRefs.length) {
    lines.push("**Validation**:");
    lines.push("");
    for (const ref of validationRefs) lines.push(`- ${oneLine(ref)}`);
    lines.push("");
  }
  const followUps = Array.isArray(group.follow_ups) ? group.follow_ups : [];
  if (followUps.length) {
    lines.push("**Follow-ups**:");
    lines.push("");
    for (const followUp of followUps) lines.push(`- ${oneLine(followUp)}`);
    lines.push("");
  }
  return lines;
}

function renderSummary(summary) {
  const lines = [];
  const riskCounts = (summary && summary.risk_counts) || {};
  const parts = RISK_ORDER.filter((risk) => riskCounts[risk]).map(
    (risk) => `${riskCounts[risk]} ${headingFor(risk).toLowerCase()}`
  );
  const counts = [];
  if (summary && typeof summary.group_count === "number") counts.push(`${summary.group_count} finding(s)`);
  if (summary && typeof summary.file_count === "number") counts.push(`${summary.file_count} file(s)`);
  if (parts.length) counts.push(parts.join(", "));
  if (counts.length) lines.push(counts.join(" · "));
  return lines;
}

function renderComment(artifact) {
  if (!artifact || typeof artifact !== "object") {
    fail("invalid_artifact", "The artifact must be a JSON object.", 2);
  }
  const groups = Array.isArray(artifact.groups) ? artifact.groups : [];
  if (!groups.length) {
    fail("no_findings_to_render", "The artifact carries no findings.", 2);
  }

  const lines = [];
  lines.push("## Guided review");
  lines.push("");
  const summaryLines = renderSummary(artifact.summary);
  if (summaryLines.length) {
    lines.push(summaryLines.join(""));
    lines.push("");
  }

  let counter = 0;
  for (const bucket of groupByRisk(groups)) {
    // The risk bucket is a level-3 heading and each finding a level-4 one,
    // so a finding reads as *inside* its risk group rather than beside it.
    lines.push(`### ${headingFor(bucket.risk)} risk`);
    lines.push("");
    for (const group of bucket.groups) {
      counter += 1;
      lines.push(...renderFinding(group, counter));
    }
  }

  // The trailing blank line keeps the rendered body from ending mid-block,
  // and the marker makes the comment identifiable in a PR timeline.
  lines.push("---");
  lines.push("");
  lines.push(`_Guided review artifact \`${oneLine(artifact.artifact_id)}\`_`);
  lines.push("");

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const artifact = readJson(args.input, "input");
    const body = renderComment(artifact);
    if (args.output && args.output !== true) {
      const target = path.resolve(args.output);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      process.stdout.write(`${JSON.stringify({ ok: true, output: target, bytes: Buffer.byteLength(body) })}\n`);
      return;
    }
    process.stdout.write(body);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: error.error || "render_failed", details: error.details || error.message })}\n`
    );
    process.exit(error.code || 1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { groupByRisk, oneLine, parseArgs, renderComment };
