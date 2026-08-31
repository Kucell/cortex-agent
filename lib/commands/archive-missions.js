#!/usr/bin/env node
"use strict";

// ─── archive-missions (L3 framework self-bootstrap) ───────────────────────────
// Move Missions that have reached terminal `State: COMPLETE` from
// .agent/missions/M-* into .agent/missions/archive/M-*, so the Reality
// Reconciliation gate (reality-reconciliation.js::collectMissions) no longer
// counts them as active — clearing RR-002 without touching the detector.
//
// Ownership: L3 ONLY. This script lives in the cortex-agent main repository and
// is NOT distributed via init/upgrade (see .agent/rules/agent-scope.md). User
// projects never have self-check, so they never need this.
//
// Invariants (per .agent/rules/runtime-state-integration.md):
//   - Never fabricate history. We only relocate directories whose own
//     mission-plan.md already declares `State: COMPLETE`.
//   - Never overwrite: if archive/M-xxx already exists, report a conflict.
//   - Idempotent: a second run finds nothing to archive.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function missionsDir(root) {
  return path.join(root, ".agent", "missions");
}

// Read the `State:` value inside the `## Current State` section of a
// mission-plan.md. Returns the raw token (e.g. "COMPLETE") or null.
function readMissionState(missionPlanPath) {
  let text;
  try {
    text = fs.readFileSync(missionPlanPath, "utf8");
  } catch {
    return null;
  }
  const sectionMatch = text.match(/^##\s+Current State\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
  const scope = sectionMatch ? sectionMatch[1] : text;
  // Accept either: `State: COMPLETE` / `State: COMPLETED` (canonical)
  //              / `State: **COMPLETE**` (bold markdown)
  //              / `State: MISSION COMPLETE` (prose form)
  //              / `State: MISSION COMPLETE + ...` (annotated prose)
  // Capture up to 3 ASCII tokens and let isCompleteState() decide.
  const stateMatch = scope.match(/^[-*]\s*State:\s*[*_]*((?:[A-Za-z_]+\s*){1,3})/m);
  if (!stateMatch) return null;
  const raw = stateMatch[1].trim().toUpperCase();
  const tokens = raw.split(/\s+/);
  return tokens[tokens.length - 1];
}

function isCompleteState(state) {
  return state === "COMPLETE" || state === "COMPLETED";
}

// Find M-* mission directories at the top level of .agent/missions whose
// mission-plan.md declares a terminal COMPLETE state.
function findCompleteMissions(root) {
  const dir = missionsDir(root);
  const candidates = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^M-/.test(entry.name)) continue;          // only M-* missions
    if (/archive/i.test(entry.name)) continue;      // never re-process archive
    const planPath = path.join(dir, entry.name, "mission-plan.md");
    if (!fs.existsSync(planPath)) continue;          // defensive: not a mission
    const state = readMissionState(planPath);
    if (isCompleteState(state)) {
      candidates.push({ mission: entry.name, state, planPath });
    }
  }
  return candidates;
}

function isGitRepo(root) {
  const res = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  return !res.error && res.status === 0 && String(res.stdout).trim() === "true";
}

function moveMission(root, mission, useGit) {
  const dir = missionsDir(root);
  const from = path.join(dir, mission);
  const archiveDir = path.join(dir, "archive");
  const to = path.join(archiveDir, mission);

  if (fs.existsSync(to)) {
    return { ok: false, error: "archive_target_exists", from, to };
  }
  fs.mkdirSync(archiveDir, { recursive: true });

  if (useGit) {
    const res = spawnSync("git", ["-C", root, "mv", from, to], { encoding: "utf8" });
    if (!res.error && res.status === 0) return { ok: true, from, to, mode: "git" };
    // fall through to fs rename on git failure
  }
  try {
    fs.renameSync(from, to);
    return { ok: true, from, to, mode: "fs" };
  } catch (error) {
    return { ok: false, error: error.message, from, to };
  }
}

// options: { dryRun }
function archiveMissions(root, options = {}) {
  const dryRun = options.dryRun === true;
  const candidates = findCompleteMissions(root);
  const useGit = !dryRun && isGitRepo(root);

  const result = {
    ok: true,
    dry_run: dryRun,
    scanned: candidates.length,
    archived: [],
    errors: [],
    runs: [],
  };

  for (const c of candidates) {
    if (dryRun) {
      result.runs.push({ mission: c.mission, state: c.state, action: "would_archive" });
      continue;
    }
    const moved = moveMission(root, c.mission, useGit);
    if (moved.ok) {
      result.archived.push(c.mission);
      result.runs.push({ mission: c.mission, from: moved.from, to: moved.to, mode: moved.mode });
    } else {
      result.errors.push({ mission: c.mission, error: moved.error });
      result.runs.push({ mission: c.mission, error: moved.error });
    }
  }

  if (result.errors.length) result.ok = false;
  return result;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const root = process.cwd();
  const result = archiveMissions(root, { dryRun });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = {
  readMissionState,
  isCompleteState,
  findCompleteMissions,
  archiveMissions,
};
