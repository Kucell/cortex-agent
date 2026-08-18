#!/usr/bin/env node
// ─── backfill-skill-area (M2 / BR-5) ───────────────────────────────────────────
//
// Zero-dep backfill: for every SKILL.md under templates/, add `area:` and
// `summary:` to the YAML frontmatter if missing. Idempotent. Run once.
//
// Mapping is hand-maintained here (21 distinct skills, 4 area buckets).
// If a new skill is added without area, run with --print-unassigned to see
// which ones need classification before merging.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// area: skill-dir-name
const MAP = {
  // agent-tuning (评估/优化/架构/可观测性)
  "code-evaluation": "agent-tuning",
  "knowledge-lint": "agent-tuning",
  "architecture-guard": "agent-tuning",
  "agent-visibility": "agent-tuning",
  "evolution-pipeline": "agent-tuning",
  "context-budget": "agent-tuning",
  "retrieval-trajectory": "agent-tuning",
  "prompt-inject": "agent-tuning",
  "experience-recall": "agent-tuning",
  "code-review-benchmark": "agent-tuning",

  // aiapp (运行时/数据/管理)
  "management-api": "aiapp",
  "coordination": "aiapp",
  "dashboard-supervisor": "aiapp",
  "activity-recording": "aiapp",
  "doc-gardening": "aiapp",
  "knowledge-retrieval": "aiapp",
  "handoff": "aiapp",
  "agent-dashboard": "aiapp",
  "memory-curator": "aiapp",
  "runtime-continuity": "aiapp",
  "branch-namespace": "aiapp",
  "cleanup-debug": "aiapp",
  "claude-code-dispatch": "aiapp",

  // swe (开发工具/集成/集成)
  "github-repo-research": "swe",
  "graphify": "swe",
  "resource-ingest": "swe",
  "minimax-cli": "swe",
  "design-system": "swe",
  "dependency-analysis": "swe",
  "changelog-generator": "swe",
  "self-check": "swe",

  // second pass (unassigned from first dry-run)
  "agent-review-benchmark": "agent-tuning",
  "maturity-tracker": "agent-tuning",
  "phase-gate": "agent-tuning",
  "security-scan": "agent-tuning",
  "subagent-trace": "agent-tuning",
  "superpowers": "agent-tuning",
  "validation-contract": "agent-tuning",

  "runtime-evidence": "aiapp",
  "runtime-state-integration": "aiapp",
  "runtime-state-mcp": "aiapp",
  "secrets": "aiapp",
  "session-triage": "aiapp",
  "sync-global": "aiapp",
  "uri-resolver": "aiapp",
  "weekly-report": "aiapp",

  "karpathy-guidelines": "swe",
  "vcs-pr": "swe",

  // office (团队协作/框架同步)
  "framework-project-sync": "office",
};

function findSkillFiles() {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === "SKILL.md") out.push(p);
    }
  }
  walk(path.join(ROOT, "templates"));
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const fm = text.slice(3, end).trim();
  return { fm, body: text.slice(end + 4).replace(/^\n/, "") };
}

function upsertField(fm, key, value) {
  const lines = fm.split("\n");
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}:`)) { found = i; break; }
  }
  if (found >= 0) {
    if (lines[found] === `${key}: ${value}`) return fm;  // no change
    lines[found] = `${key}: ${value}`;
  } else {
    lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

function skillDirName(skillMdPath) {
  // templates/{lang}/.agent/skills/<name>/SKILL.md → <name>
  // templates/general/.agent/skills/<name>/SKILL.md → <name>
  const parts = skillMdPath.split(path.sep);
  const idx = parts.lastIndexOf("SKILL.md");
  return parts[idx - 1];
}

function main() {
  const args = process.argv.slice(2);
  const printUnassigned = args.includes("--print-unassigned");
  const dryRun = args.includes("--dry-run");
  const targets = printUnassigned ? null : findSkillFiles();

  if (printUnassigned) {
    const files = findSkillFiles();
    const seen = new Set();
    for (const f of files) seen.add(skillDirName(f));
    const unassigned = [...seen].filter((n) => !MAP[n]);
    process.stdout.write(JSON.stringify({ unassigned }, null, 2) + "\n");
    return;
  }

  let touched = 0;
  let skipped = 0;
  let missingMap = 0;
  const touchedPaths = [];

  for (const file of targets) {
    const text = fs.readFileSync(file, "utf8");
    const parsed = parseFrontmatter(text);
    if (!parsed) { skipped++; continue; }
    const name = skillDirName(file);
    const area = MAP[name];
    if (!area) { missingMap++; continue; }

    // summary: keep description (already exists) but ensure it's ≤ 200 chars
    let fm = parsed.fm;
    const descMatch = fm.match(/^description:\s*(.*)$/m);
    let summary = "";
    if (descMatch) summary = descMatch[1].trim().slice(0, 200);

    const before = fm;
    fm = upsertField(fm, "area", area);
    fm = upsertField(fm, "summary", summary);
    if (fm !== before) {
      const newText = `---\n${fm}\n---\n${parsed.body}`;
      if (!dryRun) fs.writeFileSync(file, newText, "utf8");
      touched++;
      touchedPaths.push(file);
    } else {
      skipped++;
    }
  }

  process.stdout.write(JSON.stringify({
    mode: dryRun ? "dry-run" : "apply",
    touched,
    skipped,
    missing_map: missingMap,
    touched_paths: touchedPaths.map((p) => path.relative(ROOT, p)),
  }, null, 2) + "\n");
}

main();
