#!/usr/bin/env node
"use strict";

// Read-only Mission Lite status reporter. It intentionally reads only the
// standard .agent/missions layout and never discovers sibling repositories.
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const options = { cwd: process.cwd(), format: "md", mode: "full" };
const requestedIds = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--cwd") options.cwd = args[++index];
  else if (arg.startsWith("--cwd=")) options.cwd = arg.slice(6);
  else if (arg === "--format") options.format = args[++index];
  else if (arg.startsWith("--format=")) options.format = arg.slice(9);
  else if (arg === "--parallel") options.mode = "parallel";
  else if (arg === "--blocked") options.mode = "blocked";
  else if (arg === "--graph-only") options.mode = "graph";
  else if (arg === "--help" || arg === "-h") printHelpAndExit();
  else if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
  else requestedIds.push(normalizeMissionId(arg));
}

if (!["md", "json"].includes(options.format)) fail("--format must be md or json");

function printHelpAndExit() { console.log("Usage: report.js [M-001 ...] [--cwd <project>] [--parallel|--blocked|--graph-only] [--format md|json]"); process.exit(0); }
function fail(message) { console.error(`mission-progress: ${message}`); process.exit(1); }
function normalizeMissionId(value) { const digits = String(value).match(/\d+/); if (!digits) fail(`invalid mission id: ${value}`); return `M-${digits[0].padStart(3, "0")}`; }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }
function findMissionDirectory(root, missionId) { const directory = path.join(root, ".agent", "missions"); if (!fs.existsSync(directory)) return null; const exact = path.join(directory, missionId); if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) return exact; const match = fs.readdirSync(directory, { withFileTypes: true }).find((entry) => entry.isDirectory() && new RegExp(`^${missionId}(?:[-_]|$)`).test(entry.name)); return match ? path.join(directory, match.name) : null; }
function valueInStatus(text, key) { const pattern = new RegExp(`^\\s*-\\s*${key.replace(/ /g, "\\s+")}:\\s*(.+)$`, "im"); return text.match(pattern)?.[1].replace(/\*\*/g, "").trim() || ""; }
function stateBucket(state) { const value = state.toLowerCase().replace(/_/g, " "); if (/completed|\bdone\b|merged|\bpass(?:ed)?\b/.test(value)) return "done"; if (/in progress|partial pass|in review|active|executing/.test(value)) return "active"; if (/waiting|blocked|pending decision|awaiting|delta gate/.test(value)) return "waiting"; if (/planned|ready|not started/.test(value)) return "planned"; return "unknown"; }
function stateIcon(state) { return ({ done: "✅", active: "🔵", waiting: "⏸", planned: "🟡", unknown: "❔" })[stateBucket(state)]; }
function parseDependencies(text) { const result = new Set(); for (const match of text.matchAll(/depends?\s+on\s*:\s*([^\n]+)/ig)) for (const token of match[1].split(/[,，、\s]+/)) { if (/^MS-\d{3}$/i.test(token) || /^M-\d{3}(?:\/MS-\d{3})?$/i.test(token)) result.add(token.toUpperCase()); } return [...result]; }
function parseTitle(text, fallback) { return text.match(/^#\s+(?:Mission(?: Plan)?|Milestone:)\s*(?:M(?:S)?-\d{3})?\s*[—-]?\s*(.+)$/im)?.[1]?.trim() || fallback; }
function readMission(root, missionId) { const directory = findMissionDirectory(root, missionId); const plan = directory && readText(path.join(directory, "mission-plan.md")); if (!plan) return null; const milestoneDirectory = path.join(directory, "milestones"); const milestones = !fs.existsSync(milestoneDirectory) ? [] : fs.readdirSync(milestoneDirectory).filter((file) => /^MS-\d{3}\.md$/.test(file)).sort().map((file) => { const text = readText(path.join(milestoneDirectory, file)) || ""; return { id: file.slice(0, -3), title: parseTitle(text, file.slice(0, -3)), state: valueInStatus(text, "State") || valueInStatus(text, "Status") || "unknown", dependsOn: parseDependencies(text) }; }); return { id: missionId, title: parseTitle(plan, missionId), milestones }; }
function discoverMissions(root) { const directory = path.join(root, ".agent", "missions"); if (!fs.existsSync(directory)) return []; return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name.match(/^M-\d{3}/)?.[0]).filter(Boolean).sort(); }
function nodeId(mission, milestone) { return `${mission.id}/${milestone.id}`; }
function dependencyNode(mission, dependency) { return dependency.startsWith("MS-") ? `${mission.id}/${dependency}` : dependency; }
function completedNodes(missions) { return new Set(missions.flatMap((mission) => mission.milestones.filter((milestone) => stateBucket(milestone.state) === "done").map((milestone) => nodeId(mission, milestone)))); }
function taskRows(missions) { const completed = completedNodes(missions); return missions.flatMap((mission) => mission.milestones.map((milestone) => { const dependencies = milestone.dependsOn.map((dependency) => dependencyNode(mission, dependency)); return { mission, milestone, dependencies, unmet: dependencies.filter((dependency) => !completed.has(dependency)), bucket: stateBucket(milestone.state) }; })).filter((item) => item.bucket !== "done" && item.bucket !== "waiting"); }
function renderGraph(missions) { const lines = ["```mermaid", "graph TD"]; const known = new Set(missions.flatMap((mission) => mission.milestones.map((milestone) => nodeId(mission, milestone)))); for (const mission of missions) for (const milestone of mission.milestones) { const id = `${mission.id.replace("-", "")}_${milestone.id.replace("-", "")}`; lines.push(`  ${id}["${mission.id}/${milestone.id} ${stateIcon(milestone.state)}"]`); for (const dependency of milestone.dependsOn) { const resolved = dependencyNode(mission, dependency); const source = known.has(resolved) ? resolved.replace(/-/g, "").replace("/", "_") : `external_${dependency.replace(/[^A-Z0-9]/g, "_")}`; lines.push(`  ${source} --> ${id}`); } } lines.push("```"); return lines.join("\n"); }
function renderParallel(rows) { const ready = rows.filter((item) => item.unmet.length === 0); if (!ready.length) return "_No runnable milestones._"; return ["| Milestone | State | Dependencies |", "|---|---|---|", ...ready.map((item) => `| ${nodeId(item.mission, item.milestone)} | ${item.milestone.state} | ${item.dependencies.join(", ") || "—"} |`)].join("\n"); }
function renderBlocked(missions) { const blocked = missions.flatMap((mission) => mission.milestones.filter((milestone) => stateBucket(milestone.state) === "waiting").map((milestone) => `- ${nodeId(mission, milestone)} — ${milestone.state}`)); return blocked.length ? blocked.join("\n") : "_No blocked milestones._"; }
function renderMarkdown(missions) { const rows = taskRows(missions); if (options.mode === "graph") return renderGraph(missions); if (options.mode === "parallel") return renderParallel(rows); if (options.mode === "blocked") return renderBlocked(missions); const matrix = missions.map((mission) => `| ${mission.id} | ${mission.milestones.map((milestone) => `${milestone.id}${stateIcon(milestone.state)}`).join(" ") || "—"} |`).join("\n"); return [`# Mission Progress Report — ${new Date().toISOString().slice(0, 10)}`, "", "## Mission Status Matrix", "| Mission | Milestones |", "|---|---|", matrix, "", "## Dependency Graph", renderGraph(missions), "", "## Parallel Tasks", renderParallel(rows), "", "## Blocked", renderBlocked(missions)].join("\n"); }
const root = path.resolve(options.cwd); const missionIds = requestedIds.length ? requestedIds : discoverMissions(root); const missions = missionIds.map((id) => readMission(root, id)).filter(Boolean); if (!missions.length) fail(`no Mission Lite data found under ${root}/.agent/missions`); console.log(options.format === "json" ? JSON.stringify({ missions }, null, 2) : renderMarkdown(missions));
