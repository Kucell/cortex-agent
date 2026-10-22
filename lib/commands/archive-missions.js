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
//   - Never overwrite: if archive/M-xxx already exists, the move goes to a
//     qualified directory name (see resolveArchiveTarget) — or, when the
//     mission carries no creation date to qualify with, reports a conflict.
//   - Idempotent: a second run finds nothing to archive.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
// The `State:` reader is shared with the mission state derivation rule, so the
// archive gate and `mission.json` can never disagree about what a plan
// declares. See .agent/rules/mission-state-derivation.md.
//
// The governance repository keeps the same rule in
// `.agent/missions/scripts/mission-state.js`; the two repositories are
// independent, so the rule is vendored in `lib/mission-state.js` and the drift
// between the copies is locked by `tests/mission-state-parity.test.js`.
const { readStateToken, isCompleteState } = require("../mission-state.js");

// The missions live under `<project>/.agent/missions` in a managed project and
// directly under `missions/` in the governance repository itself — the L3
// fallback copy of this script runs there, and a fresh checkout has no
// `.agent/` subdirectory (only a stale self-referential symlink, which is not
// part of the repository and must not be relied on).
function missionsDir(root) {
  const candidates = [path.join(root, ".agent", "missions"), path.join(root, "missions")];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch (_) { /* try the next layout */ }
  }
  return candidates[0];
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
  return readStateToken(text);
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
      candidates.push({ mission: entry.name, state, planPath, missionDir: path.join(dir, entry.name) });
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

// A mission id may be reused by a later, unrelated mission: the archive
// already holds a different M-032 (AI-Native SDLC Governance, 2026-08-27)
// than the one the archive is asked to move (Team Knowledge Recall, 2026-09-09).
//
// Archiving must never overwrite the earlier record, so when the plain target
// name is taken the move goes to a qualified directory name derived from the
// mission's own creation date. Both records stay readable, the mission keeps
// its id and its files, and nothing about the earlier mission is rewritten.
//
// A mission without a `mission.json` has no creation date to qualify with, so
// it keeps the old behaviour: report the conflict and change nothing.
function archiveQualifier(missionDir) {
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(path.join(missionDir, "mission.json"), "utf8"));
  } catch {
    return null;
  }
  const createdAt = record && record.created_at;
  if (!createdAt) return null;
  const match = String(createdAt).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

// Resolve where a mission should be archived to.
// Returns { to, qualified } or null when the move must not happen.
function resolveArchiveTarget(archiveDir, mission, missionDir) {
  const plain = path.join(archiveDir, mission);
  if (!fs.existsSync(plain)) return { to: plain, qualified: false };
  const qualifier = archiveQualifier(missionDir);
  if (!qualifier) return null;
  const qualified = path.join(archiveDir, `${mission}-${qualifier}`);
  if (fs.existsSync(qualified)) return null;
  return { to: qualified, qualified: true };
}

function moveMission(root, mission, useGit) {
  const dir = missionsDir(root);
  const from = path.join(dir, mission);
  const archiveDir = path.join(dir, "archive");
  const target = resolveArchiveTarget(archiveDir, mission, from);
  if (!target) {
    return { ok: false, error: "archive_target_exists", from, to: path.join(archiveDir, mission) };
  }
  const to = target.to;

  fs.mkdirSync(archiveDir, { recursive: true });

  if (useGit) {
    const res = spawnSync("git", ["-C", root, "mv", from, to], { encoding: "utf8" });
    if (!res.error && res.status === 0) return { ok: true, from, to, mode: "git", qualified: target.qualified };
    // fall through to fs rename on git failure
  }
  try {
    fs.renameSync(from, to);
    return { ok: true, from, to, mode: "fs", qualified: target.qualified };
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
      // The dry run has to show where the mission WOULD land, including the
      // qualified name a reused id resolves to — otherwise the operator
      // learns about the collision only after the move.
      const target = resolveArchiveTarget(path.join(missionsDir(root), "archive"), c.mission, c.missionDir);
      result.runs.push({
        mission: c.mission,
        state: c.state,
        action: "would_archive",
        to: target ? path.relative(root, target.to) : null,
        qualified: target ? target.qualified : false,
        conflict: !target,
      });
      continue;
    }
    const moved = moveMission(root, c.mission, useGit);
    if (moved.ok) {
      result.archived.push(c.mission);
      result.runs.push({
        mission: c.mission,
        from: moved.from,
        to: moved.to,
        mode: moved.mode,
        qualified: moved.qualified === true,
      });
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
