#!/usr/bin/env node
"use strict";

// ─── runtime-state-layout-migration ────────────────────────────────────────
// Migration helper for the runtime-state layout (per `runtime-layout.schema.json`).
//
// Provides two modes:
//   - forward (default): detect what would change going from --from-revision
//     to --to-revision
//   - rollback: detect what would be reverted going from --to back to --from
//
// The script is intentionally dry-run only by default. It reads both
// revisions from git, computes the set of `contracts/runtime-state/*.schema.json`
// files that would be added / removed / changed, and reports the result as
// JSON to stdout. It NEVER modifies the working tree, never writes the
// ledger, and never publishes anything.
//
// Exit code: 0 if the rollback dry-run plan is clean, 1 if any unexpected
// condition is found (missing revisions, divergent paths, etc.).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// ─── CLI parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    mode: "rollback",
    from: null,
    fromPolicyRevision: "HEAD",
    to: null,
    dryRun: false,
    repo: null,
    contractsGlob: "templates/_shared/.agent/contracts/runtime-state/*.schema.json",
    layoutPath: "templates/_shared/.agent/workspaces/runtime-layout.schema.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "rollback" || arg === "forward") opts.mode = arg;
    else if (arg === "--from-policy-revision") opts.fromPolicyRevision = argv[++i];
    else if (arg === "--from") opts.from = argv[++i];
    else if (arg === "--to") opts.to = argv[++i];
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--repo") opts.repo = argv[++i];
    else if (arg === "--contracts-glob") opts.contractsGlob = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    "Usage: runtime-state-layout-migration [rollback|forward] [options]",
    "",
    "Dry-run only: reports what would change between two revisions for",
    "the runtime-state layout (contracts + workspace schemas).",
    "",
    "Modes:",
    "  rollback (default)  detect what would revert from --to back to --from",
    "  forward             detect what would change from --from to --to",
    "",
    "Options:",
    "  --from REV           source revision",
    "  --to REV             target revision",
    "  --from-policy-revision REV",
    "                        head revision for the policy branch (default: HEAD)",
    "  --repo PATH          repo root (default: cwd)",
    "  --dry-run            always dry-run (script never writes anyway)",
    "  --contracts-glob PATTERN",
    "                        glob pattern for contracts (default:",
    "                        templates/_shared/.agent/contracts/runtime-state/*.schema.json)",
    "  --layout-path PATH    path to the runtime-layout schema (default:",
    "                        templates/_shared/.agent/workspaces/runtime-layout.schema.json)",
    "  -h, --help           show help",
    "",
  ].join("\n"));
}

// ─── Git helpers ──────────────────────────────────────────────────────────
// globToRegex converts a simple glob (with `*`) into a RegExp. Used to
// filter `git ls-tree` results, since git pathspecs don't expand `*` in
// tree listings the way users expect.
function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function gitLsTree(repo, revision, pattern) {
  try {
    const out = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", revision],
      { cwd: repo, encoding: "utf8" },
    );
    const re = globToRegex(pattern);
    return out.split("\n").filter(Boolean).filter((p) => re.test(p)).sort();
  } catch (_) {
    return [];
  }
}

function gitDiffNames(repo, from, to) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ADM", `${from}..${to}`],
      { cwd: repo, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean).sort();
  } catch (_) {
    return [];
  }
}

function gitShowContent(repo, revision, filePath) {
  try {
    return execFileSync(
      "git",
      ["show", `${revision}:${filePath}`],
      { cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (_) {
    return null;
  }
}

function resolveRevision(repo, revision) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  } catch (_) {
    return null;
  }
}

// ─── Plan computation ─────────────────────────────────────────────────────
function buildPlan(opts) {
  const repo = opts.repo || process.cwd();
  if (!fs.existsSync(path.join(repo, ".git")) && !fs.existsSync(path.join(repo, "..", ".git"))) {
    return { ok: false, error: "not_a_git_repository", repo };
  }
  // --to defaults to HEAD~1 (rollback drills always inspect a one-step rewind)
  const from = opts.from || opts.fromPolicyRevision;
  const to = opts.to || "HEAD~1";
  if (opts.mode === "rollback") {
    // rollback: source = current (to), destination = prior (from)
  } else {
    // forward: source = from, destination = to
  }
  const source = opts.mode === "rollback" ? to : from;
  const dest = opts.mode === "rollback" ? from : to;

  const sourceSha = resolveRevision(repo, source);
  const destSha = resolveRevision(repo, dest);
  if (!sourceSha || !destSha) {
    return { ok: false, error: "revision_not_found", source, sourceSha, dest, destSha };
  }
  if (sourceSha === destSha) {
    return { ok: true, mode: opts.mode, no_op: true, source: sourceSha, dest: destSha };
  }

  const sourceSet = new Set(gitLsTree(repo, sourceSha, opts.contractsGlob));
  const destSet = new Set(gitLsTree(repo, destSha, opts.contractsGlob));

  const added = [...destSet].filter((p) => !sourceSet.has(p)).sort();
  const removed = [...sourceSet].filter((p) => !destSet.has(p)).sort();
  const both = [...sourceSet].filter((p) => destSet.has(p));
  const changed = [];
  for (const p of both) {
    const a = gitShowContent(repo, sourceSha, p);
    const b = gitShowContent(repo, destSha, p);
    if (a !== null && b !== null && a !== b) changed.push(p);
  }

  // Detect schemas that look orphan (not referenced by the runtime layout
  // index after the migration).
  const orphanInDest = [];
  const destLayoutContent = gitShowContent(repo, destSha, opts.layoutPath);
  if (destLayoutContent) {
    try {
      const layout = JSON.parse(destLayoutContent);
      const referenced = new Set();
      const collect = (node) => {
        if (!node || typeof node !== "object") return;
        if (typeof node.$ref === "string") referenced.add(node.$ref.split("/").pop());
        for (const v of Object.values(node)) collect(v);
      };
      collect(layout);
      for (const p of added) {
        const basename = path.basename(p);
        if (!referenced.has(basename)) orphanInDest.push(p);
      }
    } catch (_) { /* parse failure is non-fatal */ }
  }

  return {
    ok: true,
    mode: opts.mode,
    source_revision: source,
    source_sha: sourceSha,
    dest_revision: dest,
    dest_sha: destSha,
    contracts_glob: opts.contractsGlob,
    dry_run: true,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      orphan_in_dest: orphanInDest.length,
    },
    added,
    removed,
    changed,
    orphan_in_dest: orphanInDest,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  const plan = buildPlan(opts);
  if (opts.dryRun) plan.dry_run = true;

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  // Treat unexpected plan conditions as exit-code-1 so the preflight drill
  // surfaces them. Real rollback blockers (orphan schemas on dest) are the
  // primary signal.
  if (!plan.ok) process.exitCode = 1;
  else if (plan.orphan_in_dest && plan.orphan_in_dest.length > 0) process.exitCode = 1;
}

main();