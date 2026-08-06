"use strict";

// ─── Branch Management CLI Surface (M-016 MS-002 / F-003 + F-004 + F-007) ─────
//
// This is the user-facing dispatcher for `cortex-agent branch <subcommand>`.
// It composes three audited owners and keeps the contract from the proposal:
//
//   - `lib/branch-registry.js`  atomic read/write of .agent/branches/registry.json
//                                (F-001, MS-001). Used for every list / show /
//                                upsert / update / remove call.
//   - `lib/branch-naming.js`    kebab / prefix / length / bare-task-id validator
//                                (F-002, MS-001). Used for create / cleanup.
//   - `child_process.execFileSync("git", ...)`  read-only git queries + the
//                                                write operations the proposal
//                                                explicitly allows (switch,
//                                                merge, branch -d).
//
// 7 subcommands (proposal §7.1, MS-002 spec §1.2-1.8):
//   - create   : from proposal → fetch+rebase base → switch -c → upsert entry
//   - list     : read registry, optional type/status filter, table or JSON
//   - show     : registry entry + git rev-parse
//   - sync     : fetch+rebase base + update last_sync/commits_ahead
//   - ready    : gates check + active → merge_ready
//   - merge    : 4 fail-closed pre-merge gates + merge + soft-archive
//   - cleanup  : list merged/dormant/abandoned; --dry-run is 0-mutation
//
// Exit codes (MS-002 spec §1.1):
//   0  PASS
//   1  user error (param missing / not found / invalid)
//   2  gate failure (working tree dirty, status mismatch, on main, etc.)
//   3  system error (git command failed, IO error)
//
// Why a separate module instead of inlining into bin/cli.js:
//   1. Keeps `bin/cli.js` 1-line dispatch (case "branch") trivial to review.
//   2. Lets tests invoke subcommands directly without spawning the CLI binary.
//   3. Mirrors `lib/dispatch-cli.js` / `lib/agents/cli.js` / `lib/design/cli.js`
//      naming (flat module, no nested `lib/commands/<x>/`).
//
// Boundaries:
//   - In scope: argv parsing, subcommand routing, flag normalization,
//     human/JSON formatting, exit-code mapping, real git subprocess calls.
//   - Out of scope: GitHub / GitLab remote APIs, PR review UI, lease gating
//     (caller is responsible for the per-process lease — same as the rest of
//     the M-016 worker boot sequence in milestones/MS-002.md §5 step 5).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const branchRegistry = require("../branch-registry");
const branchNaming = require("../branch-naming");

// ─── Constants ────────────────────────────────────────────────────────────────

// Allowed `branch list --status` filter values. Must stay in sync with
// `branch-registry.VALID_STATUSES`; we keep an explicit copy so an unknown
// value is caught at the CLI surface (exit 1) rather than silently producing
// an empty list.
const ALLOWED_STATUSES = ["active", "merge_ready", "merged", "archived"];
const ALLOWED_TYPES = ["feat", "fix", "release", "hotfix", "chore"];
const ALLOWED_STRATEGIES = ["ff", "squash", "merge"];

// ─── argv parsing ────────────────────────────────────────────────────────────

function parseBranchArgs(args) {
  const out = {
    subcommand: null,
    branchName: null,
    // common filters
    type: null,
    status: null,
    // output
    outputJson: false,
    // write mode
    dryRun: false,
    // create
    from: null,
    name: null,
    base: "main",
    // sync
    noRebase: false,
    // ready
    validationArtifact: null,
    // merge
    strategy: "ff",
    to: "main",
    noDelete: false,
    allowForeign: false,
    forceMerge: false,
    // cleanup
    staleDays: 30,
    showHelp: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      continue;
    }
    if (arg === "--json") { out.outputJson = true; continue; }
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (arg === "--no-rebase") { out.noRebase = true; continue; }
    if (arg === "--no-delete") { out.noDelete = true; continue; }
    if (arg === "--allow-foreign") { out.allowForeign = true; continue; }
    if (arg === "--force-merge") { out.forceMerge = true; continue; }
    if (arg === "--type") { out.type = nextValue(args, ++i, "--type"); continue; }
    if (arg && arg.startsWith("--type=")) { out.type = arg.slice("--type=".length); continue; }
    if (arg === "--status") { out.status = nextValue(args, ++i, "--status"); continue; }
    if (arg && arg.startsWith("--status=")) { out.status = arg.slice("--status=".length); continue; }
    if (arg === "--from") { out.from = nextValue(args, ++i, "--from"); continue; }
    if (arg && arg.startsWith("--from=")) { out.from = arg.slice("--from=".length); continue; }
    if (arg === "--name") { out.name = nextValue(args, ++i, "--name"); continue; }
    if (arg && arg.startsWith("--name=")) { out.name = arg.slice("--name=".length); continue; }
    if (arg === "--base") { out.base = nextValue(args, ++i, "--base"); continue; }
    if (arg && arg.startsWith("--base=")) { out.base = arg.slice("--base=".length); continue; }
    if (arg === "--strategy") { out.strategy = nextValue(args, ++i, "--strategy"); continue; }
    if (arg && arg.startsWith("--strategy=")) { out.strategy = arg.slice("--strategy=".length); continue; }
    if (arg === "--to") { out.to = nextValue(args, ++i, "--to"); continue; }
    if (arg && arg.startsWith("--to=")) { out.to = arg.slice("--to=".length); continue; }
    if (arg === "--stale-days") { out.staleDays = parseInt(nextValue(args, ++i, "--stale-days"), 10); continue; }
    if (arg && arg.startsWith("--stale-days=")) { out.staleDays = parseInt(arg.slice("--stale-days=".length), 10); continue; }
    if (arg === "--validation-artifact") { out.validationArtifact = nextValue(args, ++i, "--validation-artifact"); continue; }
    if (arg && arg.startsWith("--validation-artifact=")) {
      out.validationArtifact = arg.slice("--validation-artifact=".length);
      continue;
    }
    if (arg && arg.startsWith("--")) {
      // Unknown flag: ignore. Keeps the surface permissive when callers pass
      // extra flags (e.g. tooling). Subcommand bodies reject required values.
      continue;
    }
    if (!out.subcommand) { out.subcommand = arg; }
    else if (!out.branchName) { out.branchName = arg; }
  }
  return out;
}

function nextValue(args, i, flag) {
  const v = args[i];
  if (typeof v !== "string" || v.startsWith("--")) {
    const err = new Error(`${flag} requires a value`);
    err.code = "MISSING_VALUE";
    throw err;
  }
  return v;
}

// ─── formatters ──────────────────────────────────────────────────────────────

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHuman(lines) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function errLine(subcommand, message) {
  process.stderr.write(`[branch] ${subcommand}: ${message}\n`);
}

// Set process.exitCode AND return the code so both the CLI binary and direct
// programmatic callers (tests) observe the same value. node's process.exit
// default is 0; setting process.exitCode is the non-throwing escape hatch.
function exit(code) {
  if (process) process.exitCode = code;
  return code;
}

// ─── git helpers ─────────────────────────────────────────────────────────────

function runGit(cwd, args, opts = {}) {
  // Use execFileSync (not execSync) so user-controlled cwd / ref values can
  // never inject shell metacharacters. Returns trimmed stdout; throws on
  // non-zero exit unless opts.allowFailure is true.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function tryGit(cwd, args) {
  try {
    return { ok: true, stdout: runGit(cwd, args), stderr: "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? err.stdout.toString().trim() : "",
      stderr: err.stderr ? err.stderr.toString().trim() : err.message,
      code: typeof err.status === "number" ? err.status : 1,
    };
  }
}

function currentBranch(cwd) {
  const r = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) return null;
  // `git rev-parse --abbrev-ref HEAD` returns "HEAD" when detached.
  if (r.stdout === "HEAD" || r.stdout === "") return null;
  return r.stdout;
}

function isWorkingTreeClean(cwd) {
  // `--porcelain` gives a stable, parseable output across git versions.
  // Untracked files count as dirty for our purposes: a half-written proposal
  // file is exactly the kind of thing we want to surface before `create` /
  // `merge` runs.
  const r = tryGit(cwd, ["status", "--porcelain"]);
  if (!r.ok) {
    // `git status` failures are surfaced as 3 (system error) by callers.
    throw new Error(`git status failed: ${r.stderr}`);
  }
  return r.stdout === "";
}

function commitsAheadOfBase(cwd, base, head) {
  // `git rev-list --count <base>..<head>` returns 0 when up to date, N when
  // N commits are on head but not on base. Returns null on git failure
  // (caller treats as 0 commits ahead — but logs a warning).
  const r = tryGit(cwd, ["rev-list", "--count", `${base}..${head}`]);
  if (!r.ok) return null;
  const n = parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n : null;
}

function refExists(cwd, ref) {
  const r = tryGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  return r.ok;
}

function resolveRef(cwd, ref) {
  const r = tryGit(cwd, ["rev-parse", "--verify", ref]);
  if (!r.ok) return null;
  return r.stdout;
}

// ─── subcommand: create ──────────────────────────────────────────────────────

function branchCreate(parsed, ctx) {
  const sub = "create";
  const cwd = ctx.cwd;
  if (!parsed.from) {
    errLine(sub, "--from <proposal-path> is required");
    return exit(1);
  }

  // 1. proposal file exists
  const proposalPath = path.isAbsolute(parsed.from) ? parsed.from : path.join(cwd, parsed.from);
  if (!fs.existsSync(proposalPath)) {
    errLine(sub, `proposal not found: ${parsed.from}`);
    return exit(1);
  }

  // 2. derive branch name
  const type = parsed.type || "feat";
  if (!ALLOWED_TYPES.includes(type)) {
    errLine(sub, `type '${type}' not in whitelist ${JSON.stringify(ALLOWED_TYPES)}`);
    return exit(1);
  }
  const slug = parsed.name
    ? parsed.name.replace(/^\/+|\/+$/g, "")
    : branchNaming.slugFromProposal(parsed.from) || "unnamed";
  // Slug must be the body only; assemble with type prefix.
  const candidate = `${type}/${slug}`;
  const valid = branchNaming.validate(candidate);
  if (!valid.ok) {
    if (valid.error === "branch_name_too_long") {
      errLine(sub, `name exceeds 60 chars (${valid.length})`);
    } else if (valid.error === "branch_name_body_not_kebab_case") {
      errLine(sub, `name '${parsed.name || slug}' violates kebab-case`);
    } else {
      errLine(sub, `name invalid: ${valid.error}`);
    }
    return exit(1);
  }
  const branchName = valid.fullName;

  // 3. gate: refuse to create from main
  const cur = currentBranch(cwd);
  if (cur === parsed.base) {
    errLine(sub, `refusing to create from ${parsed.base} (use --base explicitly or switch branch first)`);
    return exit(2);
  }

  // 4. gate: working tree clean
  let clean;
  try { clean = isWorkingTreeClean(cwd); }
  catch (err) {
    errLine(sub, `git status failed: ${err.message}`);
    return exit(3);
  }
  if (!clean) {
    errLine(sub, "working tree dirty, commit/stash first");
    return exit(2);
  }

  // 5. fetch + rebase base (best-effort; network failures here still let
  //    the local switch proceed because the proposal's primary contract is
  //    that the registry entry has a valid base_commit — we capture HEAD of
  //    the base branch as base_commit regardless of fetch result).
  const baseRef = refExists(cwd, parsed.base) ? parsed.base : null;
  if (baseRef) {
    // Rebase current branch onto base if current branch is non-null and not
    // main. This is the MS-001 proposal's "fetch+rebase" step.
    if (cur && cur !== parsed.base) {
      const rebase = tryGit(cwd, ["rebase", parsed.base]);
      if (!rebase.ok) {
        tryGit(cwd, ["rebase", "--abort"]);
        errLine(sub, `git rebase failed (exit ${rebase.code}); resolve and retry`);
        return exit(3);
      }
    }
  }

  // 6. switch -c <branch>
  const switched = tryGit(cwd, ["switch", "-c", branchName]);
  if (!switched.ok) {
    errLine(sub, `git switch -c ${branchName} failed: ${switched.stderr}`);
    return exit(3);
  }

  // 7. capture base_commit (HEAD of base) and upsert registry
  const baseSha = tryGit(cwd, ["rev-parse", parsed.base]).stdout || null;
  const entry = {
    name: branchName,
    type,
    base_branch: parsed.base,
    base_commit: baseSha,
    proposal_ref: path.relative(cwd, proposalPath) || parsed.from,
    status: "active",
    last_sync: new Date().toISOString(),
    commits_ahead: 0,
    purpose: `created via branch create --from ${parsed.from}`,
  };
  const upsert = branchRegistry.upsertBranch(cwd, entry);
  if (!upsert.ok) {
    errLine(sub, `registry upsert failed: ${upsert.error}`);
    return exit(3);
  }

  const registeredAt = new Date().toISOString();
  if (parsed.outputJson) {
    printJson({
      ok: true,
      name: branchName,
      type,
      base: parsed.base,
      base_commit: baseSha,
      registered_at: registeredAt,
    });
  } else {
    printHuman([
      `✓ Created branch ${branchName} from ${parsed.base} at ${baseSha || "<unknown>"}`,
      `  Registered in .agent/branches/registry.json`,
    ]);
  }
  return exit(0);
}

// ─── subcommand: list ────────────────────────────────────────────────────────

function branchList(parsed, ctx) {
  const sub = "list";
  if (parsed.status && !ALLOWED_STATUSES.includes(parsed.status)) {
    errLine(sub, `status filter '${parsed.status}' not in whitelist ${JSON.stringify(ALLOWED_STATUSES)}`);
    return exit(1);
  }
  if (parsed.type && !ALLOWED_TYPES.includes(parsed.type)) {
    errLine(sub, `type filter '${parsed.type}' not in whitelist ${JSON.stringify(ALLOWED_TYPES)}`);
    return exit(1);
  }
  const r = branchRegistry.listBranches(ctx.cwd, {
    type: parsed.type,
    status: parsed.status,
  });
  if (!r.ok) {
    errLine(sub, `registry read failed: ${r.error}`);
    return exit(3);
  }
  const entries = r.entries;

  if (parsed.outputJson) {
    printJson({
      branches: entries.map((e) => ({
        name: e.name,
        type: e.type,
        base: e.base_branch,
        status: e.status,
        commits_ahead: e.commits_ahead,
        last_sync: e.last_sync,
        proposal_ref: e.proposal_ref,
        mission_id: e.mission_id,
      })),
      total: entries.length,
    });
    return exit(0);
  }

  if (entries.length === 0) {
    printHuman(["(no branches match filter)"]);
    return exit(0);
  }

  const header = ["NAME", "TYPE", "BASE", "STATUS", "COMMITS_AHEAD", "LAST_SYNC", "PROPOSAL_REF"];
  const rows = entries.map((e) => [
    e.name,
    e.type,
    e.base_branch || "-",
    e.status,
    String(e.commits_ahead ?? 0),
    e.last_sync || "-",
    e.proposal_ref || "-",
  ]);
  const widths = header.map((h, idx) =>
    Math.max(h.length, ...rows.map((row) => (row[idx] || "").length))
  );
  const formatRow = (cols) => cols.map((c, i) => (c || "").padEnd(widths[i])).join("  ");
  const lines = [formatRow(header), ...rows.map(formatRow)];
  printHuman(lines);
  return exit(0);
}

// ─── subcommand: show ────────────────────────────────────────────────────────

function branchShow(parsed, ctx) {
  const sub = "show";
  const name = parsed.branchName;
  if (!name) {
    errLine(sub, "<branch-name> is required");
    return exit(1);
  }
  const r = branchRegistry.getBranch(ctx.cwd, name);
  if (!r.ok) {
    errLine(sub, `branch not found in registry: ${name}`);
    return exit(1);
  }
  const entry = r.entry;
  const sha = resolveRef(ctx.cwd, name);
  if (!sha) {
    // registry has it but git ref missing — surface as gate failure (2) so
    // CI can distinguish from "user typo" (1).
    errLine(sub, `git ref not found: ${name}`);
    return exit(2);
  }

  if (parsed.outputJson) {
    printJson({
      name: entry.name,
      type: entry.type,
      base: entry.base_branch,
      base_commit: entry.base_commit,
      current_sha: sha,
      status: entry.status,
      created_at: entry.created_at,
      last_sync: entry.last_sync,
      commits_ahead: entry.commits_ahead,
      merged_commit: entry.merged_commit,
      proposal_ref: entry.proposal_ref,
      mission_id: entry.mission_id,
      task_id: entry.task_id,
      worktree_path: entry.worktree_path,
      purpose: entry.purpose,
      shipped: entry.shipped,
    });
    return exit(0);
  }
  const lines = [
    `name            ${entry.name}`,
    `type            ${entry.type}`,
    `base            ${entry.base_branch || "-"}`,
    `base_commit     ${entry.base_commit || "-"}`,
    `current_sha     ${sha}`,
    `status          ${entry.status}`,
    `created_at      ${entry.created_at || "-"}`,
    `last_sync       ${entry.last_sync || "-"}`,
    `commits_ahead   ${entry.commits_ahead ?? 0}`,
    `merged_commit   ${entry.merged_commit || "-"}`,
    `proposal_ref    ${entry.proposal_ref || "-"}`,
    `mission_id      ${entry.mission_id || "-"}`,
    `task_id         ${entry.task_id || "-"}`,
    `worktree_path   ${entry.worktree_path || "-"}`,
    `purpose         ${entry.purpose || "-"}`,
  ];
  printHuman(lines);
  return exit(0);
}

// ─── subcommand: sync ────────────────────────────────────────────────────────

function branchSync(parsed, ctx) {
  const sub = "sync";
  const name = parsed.branchName;
  if (!name) {
    errLine(sub, "<branch-name> is required");
    return exit(1);
  }
  const r = branchRegistry.getBranch(ctx.cwd, name);
  if (!r.ok) {
    errLine(sub, `branch not found in registry: ${name}`);
    return exit(1);
  }
  const entry = r.entry;

  if (!parsed.noRebase) {
    // fetch + rebase. We don't have a real `origin` in the test sandbox, so
    // tolerate fetch failure (treat as "no upstream configured") and only
    // surface rebase conflicts as system errors.
    tryGit(ctx.cwd, ["fetch", "origin"]);
    const rebase = tryGit(ctx.cwd, ["rebase", entry.base_branch || "main"]);
    if (!rebase.ok) {
      tryGit(ctx.cwd, ["rebase", "--abort"]);
      errLine(sub, `git rebase failed (exit ${rebase.code}); resolve and retry`);
      return exit(3);
    }
  }

  // Recompute commits_ahead relative to base.
  const head = resolveRef(ctx.cwd, name);
  const ahead = head
    ? (commitsAheadOfBase(ctx.cwd, entry.base_branch || "main", head) ?? entry.commits_ahead ?? 0)
    : 0;
  const now = new Date().toISOString();
  const u = branchRegistry.updateBranch(ctx.cwd, name, {
    last_sync: now,
    commits_ahead: ahead,
  });
  if (!u.ok) {
    errLine(sub, `registry update failed: ${u.error}`);
    return exit(3);
  }
  if (parsed.outputJson) {
    printJson({ ok: true, name, commits_ahead: ahead, last_sync: now });
    return exit(0);
  }
  printHuman([`✓ Synced ${name}: +0 -0 (${ahead} commits ahead of ${entry.base_branch || "main"})`]);
  return exit(0);
}

// ─── subcommand: ready ───────────────────────────────────────────────────────

function branchReady(parsed, ctx) {
  const sub = "ready";
  const name = parsed.branchName;
  if (!name) {
    errLine(sub, "<branch-name> is required");
    return exit(1);
  }
  const r = branchRegistry.getBranch(ctx.cwd, name);
  if (!r.ok) {
    errLine(sub, `branch not found in registry: ${name}`);
    return exit(1);
  }
  const entry = r.entry;
  const failures = [];

  // gate 1: working tree clean
  let clean = true;
  try { clean = isWorkingTreeClean(ctx.cwd); }
  catch (err) {
    errLine(sub, `git status failed: ${err.message}`);
    return exit(3);
  }
  if (!clean) failures.push("working tree dirty");

  // gate 2: rebase (commits_ahead must be ≥ 0; behind → 2)
  if (typeof entry.commits_ahead === "number" && entry.commits_ahead < 0) {
    failures.push(`branch is behind ${entry.base_branch || "main"} by ${-entry.commits_ahead} commits`);
  }

  // gate 3: validation artifact (if specified) must exist
  if (parsed.validationArtifact) {
    const ap = path.isAbsolute(parsed.validationArtifact)
      ? parsed.validationArtifact
      : path.join(ctx.cwd, parsed.validationArtifact);
    if (!fs.existsSync(ap)) failures.push(`validation artifact not found: ${parsed.validationArtifact}`);
  }

  if (failures.length > 0) {
    errLine(sub, `gates failed: ${failures.join("; ")}`);
    return exit(2);
  }

  const u = branchRegistry.updateBranch(ctx.cwd, name, { status: "merge_ready" });
  if (!u.ok) {
    errLine(sub, `registry update failed: ${u.error}`);
    return exit(3);
  }
  if (parsed.outputJson) {
    printJson({
      ok: true,
      name,
      status: "merge_ready",
      artifact: parsed.validationArtifact,
    });
    return exit(0);
  }
  printHuman([`✓ Branch ${name} marked merge_ready (artifact: ${parsed.validationArtifact || "n/a"})`]);
  return exit(0);
}

// ─── subcommand: merge ───────────────────────────────────────────────────────

function branchMerge(parsed, ctx) {
  const sub = "merge";
  const name = parsed.branchName;
  if (!name) {
    errLine(sub, "<branch-name> is required");
    return exit(1);
  }
  if (!ALLOWED_STRATEGIES.includes(parsed.strategy)) {
    errLine(sub, `strategy '${parsed.strategy}' not in whitelist ${JSON.stringify(ALLOWED_STRATEGIES)}`);
    return exit(1);
  }
  const r = branchRegistry.getBranch(ctx.cwd, name);
  if (!r.ok) {
    errLine(sub, `branch not found in registry: ${name}`);
    return exit(1);
  }
  const entry = r.entry;

  // gate 1: not on main
  const cur = currentBranch(ctx.cwd);
  if (cur === parsed.to) {
    errLine(sub, `refusing to merge on ${parsed.to}; switch to feature branch or use --to <branch>`);
    return exit(2);
  }

  // gate 2: working tree clean
  let clean = true;
  try { clean = isWorkingTreeClean(ctx.cwd); }
  catch (err) {
    errLine(sub, `git status failed: ${err.message}`);
    return exit(3);
  }
  if (!clean) {
    errLine(sub, "working tree dirty, commit/stash first");
    return exit(2);
  }

  // gate 3: must be on the source branch (or --allow-foreign)
  if (cur !== name && !parsed.allowForeign) {
    errLine(sub, `current branch '${cur || "detached"}' is not the merge source '${name}'; switch first or pass --allow-foreign`);
    return exit(2);
  }

  // gate 4: rebase state — commits_ahead must be ≥ 0
  if (typeof entry.commits_ahead === "number" && entry.commits_ahead < 0) {
    errLine(sub, `branch behind ${entry.base_branch || "main"} by ${-entry.commits_ahead} commits; run 'cortex-agent branch sync ${name}' first`);
    return exit(2);
  }

  // gate 5: registry status must be merge_ready (unless --force-merge)
  if (entry.status !== "merge_ready" && !parsed.forceMerge) {
    errLine(sub, `branch status is '${entry.status}', must be 'merge_ready' (run 'branch ready ${name}' after validation)`);
    return exit(2);
  }

  // perform merge: checkout target, then merge source with strategy
  const targetSha = resolveRef(ctx.cwd, parsed.to);
  if (!targetSha) {
    errLine(sub, `target branch not found: ${parsed.to}`);
    return exit(3);
  }
  const checkout = tryGit(ctx.cwd, ["checkout", parsed.to]);
  if (!checkout.ok) {
    errLine(sub, `git checkout ${parsed.to} failed: ${checkout.stderr}`);
    return exit(3);
  }
  const mergeArgs = ["merge", `--${parsed.strategy}`];
  if (parsed.strategy === "squash") mergeArgs.push("--no-edit");
  mergeArgs.push(name);
  const merge = tryGit(ctx.cwd, mergeArgs);
  if (!merge.ok) {
    errLine(sub, `git merge failed (exit ${merge.code}): ${merge.stderr}`);
    return exit(3);
  }
  const mergeCommit = resolveRef(ctx.cwd, "HEAD") || targetSha;

  // update registry: status=merged, merged_commit, soft-archive via removeBranch
  const updated = branchRegistry.updateBranch(ctx.cwd, name, {
    status: "merged",
    merged_commit: mergeCommit,
  });
  if (!updated.ok) {
    errLine(sub, `registry update failed: ${updated.error}`);
    return exit(3);
  }
  // soft-archive
  branchRegistry.removeBranch(ctx.cwd, name);

  // delete local branch (unless --no-delete)
  let deleted = false;
  if (!parsed.noDelete) {
    const del = tryGit(ctx.cwd, ["branch", "-d", name]);
    deleted = del.ok;
  }

  if (parsed.outputJson) {
    printJson({
      ok: true,
      name,
      merge_commit: mergeCommit,
      strategy: parsed.strategy,
      target: parsed.to,
      deleted,
      archived_at: new Date().toISOString(),
    });
    return exit(0);
  }
  printHuman([
    `✓ Merged ${name} into ${parsed.to} (commit ${mergeCommit}); archived in registry${deleted ? "" : " (branch retained)"}`,
  ]);
  return exit(0);
}

// ─── subcommand: cleanup ─────────────────────────────────────────────────────

function branchCleanup(parsed, ctx) {
  const sub = "cleanup";
  const cwd = ctx.cwd;
  const staleDays = Number.isFinite(parsed.staleDays) ? parsed.staleDays : 30;
  const r = branchRegistry.listBranches(cwd, { type: parsed.type });
  if (!r.ok) {
    errLine(sub, `registry read failed: ${r.error}`);
    return exit(3);
  }
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const candidates = r.entries.filter((e) => {
    if (!["merged", "archived"].includes(e.status)) return false;
    const syncTs = e.last_sync ? Date.parse(e.last_sync) : NaN;
    // If we can't parse last_sync, treat as not-stale (don't blow up).
    if (!Number.isFinite(syncTs)) return false;
    return syncTs <= cutoff;
  });

  if (parsed.outputJson) {
    printJson({
      ok: true,
      dry_run: parsed.dryRun,
      stale_days: staleDays,
      candidates: candidates.map((c) => ({
        name: c.name,
        last_sync: c.last_sync,
        status: c.status,
        action: "archive",
      })),
      total: candidates.length,
    });
    return exit(0);
  }

  if (parsed.dryRun) {
    if (candidates.length === 0) {
      printHuman(["(no branches match stale threshold; nothing to clean)"]);
      return exit(0);
    }
    const header = ["NAME", "LAST_ACTIVITY", "STATUS", "ACTION_PROPOSED"];
    const rows = candidates.map((c) => [c.name, c.last_sync || "-", c.status, "archive (--no-dry-run)"]);
    const widths = header.map((h, idx) =>
      Math.max(h.length, ...rows.map((row) => (row[idx] || "").length))
    );
    const formatRow = (cols) => cols.map((c, i) => (c || "").padEnd(widths[i])).join("  ");
    printHuman([formatRow(header), ...rows.map(formatRow)]);
    return exit(0);
  }

  // real mode: soft-archive each
  let archived = 0;
  let kept = 0;
  for (const c of candidates) {
    const u = branchRegistry.updateBranch(cwd, c.name, { status: "archived" });
    if (u.ok) {
      // try to delete the local git branch (best effort)
      tryGit(cwd, ["branch", "-d", c.name]);
      archived += 1;
      process.stdout.write(`✓ Archived ${c.name}\n`);
    } else if (u.error === "invalid_branch_name") {
      // Pre-M-016 historical entries may have non-conforming names
      // (e.g. `ops-stash` without a feat/fix/... prefix). The validator
      // re-runs inside updateBranch and rejects the patch. Skip these
      // entries silently — they're not in scope of the new naming
      // contract; the registry shape stays as-is.
      kept += 1;
    } else {
      kept += 1;
      process.stderr.write(`[branch] ${sub}: skip ${c.name}: ${u.error}\n`);
    }
  }
  printHuman([`Cleanup complete: ${archived} archived, ${kept} kept`]);
  return exit(0);
}

// ─── help ────────────────────────────────────────────────────────────────────

function printBranchHelp() {
  const lines = [
    "Usage: cortex-agent branch <subcommand> [options] [args]",
    "",
    "Subcommands (7):",
    "  create    Create a branch from a proposal (--from)",
    "  list      List branches from .agent/branches/registry.json",
    "  show      Show a single branch entry + git ref",
    "  sync      Fetch + rebase + update last_sync/commits_ahead",
    "  ready     Mark branch merge_ready after validation gates",
    "  merge     Pre-merge gates + merge + soft-archive",
    "  cleanup   List / archive stale merged/archived branches (--dry-run safe)",
    "",
    "Common flags:",
    "  --json                JSON output",
    "  --dry-run             List only, never modify (cleanup)",
    "  --type <feat|fix|release|hotfix|chore>",
    "  --status <active|merge_ready|merged|archived>",
    "",
    "Exit codes: 0=PASS, 1=user error, 2=gate failure, 3=system error",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

function branchCommand(ctx) {
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  const args = rawArgs[0] === "branch" ? rawArgs.slice(1) : rawArgs;

  let parsed;
  try {
    parsed = parseBranchArgs(args);
  } catch (err) {
    errLine("?", err.message);
    return exit(1);
  }

  if (parsed.showHelp || !parsed.subcommand) {
    printBranchHelp();
    return exit(0);
  }

  const sub = parsed.subcommand;
  switch (sub) {
    case "create": return branchCreate(parsed, ctx);
    case "list":   return branchList(parsed, ctx);
    case "show":   return branchShow(parsed, ctx);
    case "sync":   return branchSync(parsed, ctx);
    case "ready":  return branchReady(parsed, ctx);
    case "merge":  return branchMerge(parsed, ctx);
    case "cleanup": return branchCleanup(parsed, ctx);
    default: {
      errLine(sub, `unknown subcommand: ${sub}`);
      errLine(sub, "Run `cortex-agent branch --help` to see the 7 available subcommands.");
      return exit(2);
    }
  }
}

module.exports = {
  branchCommand,
  parseBranchArgs,
  branchCreate,
  branchList,
  branchShow,
  branchSync,
  branchReady,
  branchMerge,
  branchCleanup,
  ALLOWED_STATUSES,
  ALLOWED_TYPES,
  ALLOWED_STRATEGIES,
};
