#!/usr/bin/env node
"use strict";

// ─── skill browse (P-007 §3.3 / BR-5) ─────────────────────────────────────────
//
// `cortex-agent skill browse [--area office|swe|aiapp|agent-tuning] [--top-n N] [--json]`
//
// Zero-dep scan of templates/{zh,en,_shared,general}/.agent/skills/*/SKILL.md
// frontmatter; returns cards (name + area + summary) grouped by area, sorted
// alphabetically. Used by host agent / discover CLI to surface skills without
// loading the full SKILL.md bodies.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

const VALID_AREAS = new Set(["office", "swe", "aiapp", "agent-tuning"]);
const DEFAULT_TOP_N = 5;

function findSkillFiles() {
  const out = new Map();  // name -> { area, summary, paths: [..] }
  const roots = [
    path.join(ROOT, "templates", "zh"),
    path.join(ROOT, "templates", "en"),
    path.join(ROOT, "templates", "_shared"),
    path.join(ROOT, "templates", "general"),
  ];
  for (const r of roots) {
    const skillsDir = path.join(r, ".agent", "skills");
    let entries;
    try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillFile = path.join(skillsDir, e.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const meta = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
      if (!meta) continue;
      const name = meta.name || e.name;
      if (!out.has(name)) out.set(name, { name, area: meta.area || "uncategorized", summary: meta.summary || meta.description || "", paths: [] });
      out.get(name).paths.push(path.relative(ROOT, skillFile));
    }
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const lines = text.slice(3, end).split("\n");
  const out = {};
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function skillBrowse({ area = null, topN = DEFAULT_TOP_N } = {}) {
  if (area != null && !VALID_AREAS.has(area)) {
    const err = new Error(`invalid area "${area}". Valid: ${[...VALID_AREAS].join(", ")}.`);
    err.code = "ERR_INVALID_AREA";
    throw err;
  }
  const all = findSkillFiles();
  let cards = [];
  for (const m of all.values()) cards.push(m);
  if (area != null) cards = cards.filter((c) => c.area === area);
  cards.sort((a, b) => a.name.localeCompare(b.name));
  const returned = cards.slice(0, topN);
  // group counts by area (always full population, not just returned)
  const fullByArea = {};
  for (const c of cards) fullByArea[c.area] = (fullByArea[c.area] || 0) + 1;
  return {
    area: area,
    top_n: topN,
    scanned: cards.length,
    returned: returned.length,
    by_area: fullByArea,
    skills: returned.map((c) => ({ name: c.name, area: c.area, summary: c.summary })),
  };
}

function skillBrowseCommand(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  // strip "skill" leading subcommand
  const rest = args[0] === "skill" ? args.slice(1) : args;
  if (rest[0] !== "browse" && rest[0] !== "list") {
    process.stderr.write(`Usage: cortex-agent skill browse [--area <area>] [--top-n N] [--json]\n`);
    process.exitCode = 2;
    return;
  }
  let area = null, topN = DEFAULT_TOP_N, json = false;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--area") { area = rest[++i]; continue; }
    if (a.startsWith("--area=")) { area = a.slice("--area=".length); continue; }
    if (a === "--top-n") { topN = Number(rest[++i]) || DEFAULT_TOP_N; continue; }
    if (a.startsWith("--top-n=")) { topN = Number(a.slice("--top-n=".length)) || DEFAULT_TOP_N; continue; }
    if (a === "--json" || a === "--output=json") { json = true; continue; }
  }
  let result;
  try {
    result = skillBrowse({ area, topN });
  } catch (error) {
    process.stderr.write(`skill browse error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  // human: group by area
  process.stdout.write(`Scanned ${result.scanned} skills (area=${result.area || "all"})\n`);
  for (const a of Object.keys(result.by_area).sort()) {
    process.stdout.write(`  ${a}: ${result.by_area[a]}\n`);
  }
  process.stdout.write(`\nReturned top ${result.returned} (top_n=${result.top_n}):\n`);
  for (const s of result.skills) {
    process.stdout.write(`  [${s.area}] ${s.name} — ${s.summary}\n`);
  }
}

module.exports = { skillBrowse, skillBrowseCommand, VALID_AREAS };
