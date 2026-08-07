"use strict";

// ─── state-sync (T-FOLLOW-002 v2) ─────────────────────────────────────────────
//
// Purpose:  keep `.agent/` state in lock-step across machines by
//   (a) scanning 9 state classes for dirty / untracked files,
//   (b) `git add`ing them, optionally `git commit`ing,
//   (c) optionally `git push`ing to origin.
//
// Why this lives here (not in `lib/commands.js`):
//   - 9 state classes are an inner-`.agent/` concern (own git repo).
//     Adding it to `lib/commands.js` would force the outer repo to
//     know about inner-`.agent/` topology.
//   - Strictly additive: the switch case in bin/cli.js only adds
//     one entry; lib/commands.js is not touched.
//
// State classes (9):
//   decisions/  waitpoints/  tasks/  missions/  plans/
//   dispatch/   workflows/   skills/  branches/registry.json
//
// The first 8 are directories; `branches/registry.json` is a single file.
// New state classes go here and in the matching pre-commit hook.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const STATE_DIRS = Object.freeze([
  "decisions",
  "waitpoints",
  "tasks",
  "missions",
  "plans",
  "dispatch",
  "workflows",
  "skills",
]);

const STATE_FILES = Object.freeze([
  "branches/registry.json",
]);

// Parse porcelain status output.
// `git status --porcelain` lines look like:
//   " M decisions/D-001.json"   (unstaged modification)
//   "M  decisions/D-002.json"   (staged modification)
//   "?? plans/proposals/foo.md" (untracked)
//   "R  old -> new"             (rename)
function parsePorcelain(stdout) {
  const lines = stdout.split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    // First 2 chars are XY status, then space, then filename (possibly with " -> ").
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const arrowIdx = rest.indexOf(" -> ");
    const file = arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest;
    const staged = xy[0] !== " " && xy[0] !== "?";
    const unstaged = xy[1] !== " " && xy[1] !== "?";
    const untracked = xy[0] === "?" && xy[1] === "?";
    entries.push({ xy, file, staged, unstaged, untracked });
  }
  return entries;
}

// Classify a file path as a state-class path or not.
function isStatePath(file) {
  for (const dir of STATE_DIRS) {
    if (file === dir || file.startsWith(dir + "/")) return true;
  }
  for (const f of STATE_FILES) {
    if (file === f) return true;
  }
  return false;
}

// Run `git -C <cwd> <args...>` and return { status, stdout, stderr }.
// stdio: pipe (we read the output and report), env: inherit (so user
// GPG / SSH agent / gh auth works for `git commit` / `git push`).
function gitRun(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

// Scan the inner-`.agent/` repo and return the dirty / staged state-class changes.
// Returns:
//   {
//     ok: boolean,
//     error: string | null,
//     dirty:   string[]   // state-class files that are unstaged / untracked
//     staged:  string[]   // state-class files that are already staged (informational)
//     branch:  string     // current branch of inner .agent/ (for push)
//     remoteConfigured: boolean
//   }
function scanState(cwd) {
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    return {
      ok: false,
      error: `${cwd} is not a git repository (no .git/ found)`,
      dirty: [],
      staged: [],
      branch: null,
      remoteConfigured: false,
    };
  }

  const statusRes = gitRun(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (statusRes.status !== 0) {
    return {
      ok: false,
      error: `git status failed: ${(statusRes.stderr || "").trim()}`,
      dirty: [],
      staged: [],
      branch: null,
      remoteConfigured: false,
    };
  }

  const entries = parsePorcelain(statusRes.stdout);
  const dirty = [];
  const staged = [];
  for (const e of entries) {
    if (!isStatePath(e.file)) continue;
    if (e.unstaged || e.untracked) dirty.push(e.file);
    if (e.staged) staged.push(e.file);
  }

  // Branch + remote detection (for the push message).
  let branch = null;
  const branchRes = gitRun(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchRes.status === 0) branch = branchRes.stdout.trim() || null;

  let remoteConfigured = false;
  const remoteRes = gitRun(cwd, ["remote", "get-url", "origin"]);
  if (remoteRes.status === 0 && remoteRes.stdout.trim()) {
    remoteConfigured = true;
  }

  return { ok: true, error: null, dirty, staged, branch, remoteConfigured };
}

// Build a deterministic conventional-commit message from the changed files.
function suggestCommitMessage(dirty, staged) {
  const all = [...new Set([...dirty, ...staged])].sort();
  const dirs = new Set();
  for (const f of all) {
    const top = f.split("/")[0];
    if (STATE_DIRS.includes(top) || STATE_FILES.some((sf) => f === sf || f.startsWith(sf + "/"))) {
      dirs.add(top);
    }
  }
  const dirList = [...dirs].sort().join(", ");
  return `chore(state-sync): sync ${all.length} file(s) across ${dirList || "state classes"}`;
}

// `git add` the 9 state classes. Returns { ok, error, staged }.
// Only adds pathspecs that actually exist — `git add -- foo` fails the
// whole batch if `foo` doesn't exist, which would block first-time
// clones where some state dirs haven't been created yet.
function addState(cwd) {
  const args = ["add", "--"];
  let planned = 0;
  for (const dir of STATE_DIRS) {
    if (fs.existsSync(path.join(cwd, dir))) {
      args.push(dir);
      planned += 1;
    }
  }
  for (const file of STATE_FILES) {
    if (fs.existsSync(path.join(cwd, file))) {
      args.push(file);
      planned += 1;
    }
  }
  if (planned === 0) {
    return { ok: true, error: null, staged: 0 };
  }
  const res = gitRun(cwd, args);
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "git add failed").trim(), staged: 0 };
  }
  return { ok: true, error: null, staged: planned };
}

// `git commit -m <message>`. Returns { ok, error, sha }.
function commitState(cwd, message) {
  const res = gitRun(cwd, ["commit", "-m", message]);
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "git commit failed").trim(), sha: null };
  }
  const shaRes = gitRun(cwd, ["rev-parse", "--short", "HEAD"]);
  const sha = shaRes.status === 0 ? shaRes.stdout.trim() : null;
  return { ok: true, error: null, sha };
}

// `git push origin <branch>`. Returns { ok, error }.
function pushState(cwd, branch) {
  const res = gitRun(cwd, ["push", "origin", branch]);
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "git push failed").trim() };
  }
  return { ok: true, error: null };
}

// Interactive Y/N prompt; returns false in non-TTY (CI / piped input).
function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y");
    });
  });
}

function printHelp() {
  console.log(`Usage: cortex-agent state-sync [options]

Scan the 9 state classes in .agent/ and add / commit / push them so
project-management state stays in lock-step across machines.

State classes (9):
  decisions/  waitpoints/  tasks/  missions/  plans/
  dispatch/   workflows/   skills/  branches/registry.json

Options:
  --dry-run          Only report dirty / staged state files (default)
  --add              git add the 9 state classes
  --commit           --add + git commit (uses suggested message)
  --push             --commit + git push origin <branch>
  --yes              Skip the Y/N confirmation prompt
  -h, --help         Show this help

Examples:
  cortex-agent state-sync --dry-run
  cortex-agent state-sync --add
  cortex-agent state-sync --commit --yes
  cortex-agent state-sync --push --yes

The inner .agent/ repo is detected at <cwd>/.agent (must be a git repo,
e.g. Kucell/cortex-agent-agent). Override with --project.
`);
}

// Public entry point wired from bin/cli.js.
// ctx = { cwd, args, options, ... }
async function stateSync(ctx) {
  const args = (ctx.args || []).slice(1); // drop "state-sync"
  const options = ctx.options || {};

  // Parse flags.
  let dryRun = false;
  let doAdd = false;
  let doCommit = false;
  let doPush = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--add") doAdd = true;
    else if (a === "--commit") { doAdd = true; doCommit = true; }
    else if (a === "--push") { doAdd = true; doCommit = true; doPush = true; }
    else if (a === "--yes") yes = true;
    else if (a === "--help" || a === "-h") { printHelp(); return; }
    else {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exitCode = 2;
      return;
    }
  }
  if (!doAdd && !doCommit && !doPush) dryRun = true;

  // Inner .agent/ repo path.
  const agentDir = path.join(ctx.cwd, ".agent");
  if (!fs.existsSync(agentDir)) {
    console.error(`❌ .agent/ not found at ${agentDir}`);
    console.error("   state-sync requires the inner .agent/ git repo.");
    process.exitCode = 1;
    return;
  }

  // One-time bootstrap reminder for core.hooksPath.
  const hooksDir = path.join(agentDir, ".githooks");
  const hooksReadme = path.join(hooksDir, "README.md");
  if (fs.existsSync(hooksReadme)) {
    const hooksConfigured = gitRun(agentDir, ["config", "--get", "core.hooksPath"]);
    const configured = hooksConfigured.status === 0 &&
      hooksConfigured.stdout.trim() === ".githooks";
    if (!configured) {
      console.log(`ℹ️  Detected ${hooksDir}/ but core.hooksPath is not pointing there.`);
      console.log(`   One-time setup: cd ${agentDir} && git config core.hooksPath .githooks`);
      console.log(`   (This is what wires the state-class pre-commit reminder.)`);
    }
  }

  // 1. Scan.
  const scan = scanState(agentDir);
  if (!scan.ok) {
    console.error(`❌ ${scan.error}`);
    process.exitCode = 1;
    return;
  }

  const total = scan.dirty.length + scan.staged.length;
  if (total === 0) {
    console.log("✅ .agent/ working tree is clean across the 9 state classes.");
    console.log("   (decisions/  waitpoints/  tasks/  missions/  plans/");
    console.log("    dispatch/   workflows/   skills/  branches/registry.json)");
    return;
  }

  // 2. Dry-run output.
  if (dryRun) {
    console.log(`🔍 Found ${total} state change(s) in .agent/:\n`);
    if (scan.staged.length) {
      console.log(`  Staged (${scan.staged.length}):`);
      for (const f of scan.staged) console.log(`    A  ${f}`);
    }
    if (scan.dirty.length) {
      console.log(`  Unstaged / untracked (${scan.dirty.length}):`);
      for (const f of scan.dirty) console.log(`    ?? ${f}`);
    }
    console.log(`\n📝 Suggested commit message:`);
    console.log(`  ${suggestCommitMessage(scan.dirty, scan.staged)}`);
    console.log(`\nNext steps:`);
    console.log(`  cortex-agent state-sync --add      # stage`);
    console.log(`  cortex-agent state-sync --commit   # stage + commit`);
    console.log(`  cortex-agent state-sync --push     # stage + commit + push to origin`);
    return;
  }

  // 3. Confirmation.
  if (!yes) {
    const targets = [];
    if (doAdd) targets.push("git add");
    if (doCommit) targets.push("git commit");
    if (doPush) targets.push("git push");
    console.log(`🔍 About to: ${targets.join(" → ")} across ${total} state change(s)`);
    if (doPush && !scan.remoteConfigured) {
      console.error(`❌ No 'origin' remote configured in ${agentDir}.`);
      console.error(`   Add one with: cd ${agentDir} && git remote add origin <url>`);
      process.exitCode = 1;
      return;
    }
    const ok = await askYesNo("Proceed? [y/N] ");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // 4. git add.
  if (doAdd) {
    const res = addState(agentDir);
    if (!res.ok) {
      console.error(`❌ git add failed: ${res.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ git add: ${STATE_DIRS.length} dirs + ${STATE_FILES.length} files staged`);
  }

  // 5. git commit.
  if (doCommit) {
    const message = suggestCommitMessage(scan.dirty, scan.staged);
    const res = commitState(agentDir, message);
    if (!res.ok) {
      // `git commit` returns non-zero when there's nothing to commit.
      // That's not an error in our flow (--add might have staged nothing new).
      if (/nothing to commit/i.test(res.error)) {
        console.log(`ℹ️  Nothing to commit (already committed).`);
      } else {
        console.error(`❌ git commit failed: ${res.error}`);
        process.exitCode = 1;
        return;
      }
    } else {
      console.log(`✅ git commit: ${res.sha || "(no sha)"} ${message}`);
    }
  }

  // 6. git push.
  if (doPush) {
    if (!scan.branch) {
      console.error(`❌ Could not detect current branch in ${agentDir}.`);
      process.exitCode = 1;
      return;
    }
    const res = pushState(agentDir, scan.branch);
    if (!res.ok) {
      console.error(`❌ git push failed: ${res.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ git push origin ${scan.branch}`);
  }
}

module.exports = {
  stateSync,
  scanState,
  parsePorcelain,
  isStatePath,
  suggestCommitMessage,
  addState,
  commitState,
  pushState,
  STATE_DIRS,
  STATE_FILES,
};
