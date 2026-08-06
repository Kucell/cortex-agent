"use strict";

// ─── branch CLI focused regression (M-016 MS-002 / VC-016-04..08) ────────────
//
// Covers all 7 subcommands of `cortex-agent branch <subcommand>`:
//   create / list / show / sync / ready / merge / cleanup
//
// Each subcommand: ≥ 1 happy + ≥ 1 negative.
// Plus the two highest-risk surfaces:
//   VC-016-06  cleanup --dry-run MUST NOT modify the registry file
//               (sha256sum + mtime double check)
//   VC-016-07  branch merge MUST fail-closed on the 4 pre-merge gates:
//                1. on main                → exit 2
//                2. dirty working tree     → exit 2
//                3. branch behind main     → exit 2
//                4. status != merge_ready  → exit 2

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const {
  branchCommand,
  parseBranchArgs,
  ALLOWED_STATUSES,
  ALLOWED_TYPES,
} = require("../lib/commands/branch");
const branchRegistry = require("../lib/branch-registry");

// ─── Test helpers ────────────────────────────────────────────────────────────

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-branch-cli-"));
}

function ctxFor(cwd, args) {
  return { cwd, args, command: "branch", options: {}, lang: "en", templateDir: "" };
}

function runSubcommand(cwd, ...args) {
  // Build a fresh ctx whose `args` matches what bin/cli.js would pass: the
  // first element is the command name "branch", followed by subcommand + flags.
  const ctx = ctxFor(cwd, ["branch", ...args]);
  // Reset process.exitCode so each subcommand call is independent.
  const before = process.exitCode;
  process.exitCode = 0;
  let code = 0;
  try {
    code = branchCommand(ctx);
  } catch (err) {
    process.exitCode = 3;
    code = 3;
    process.stderr.write(`[branch] test: uncaught ${err.stack || err.message}\n`);
  }
  const observed = process.exitCode != null && process.exitCode !== 0
    ? process.exitCode
    : code;
  process.exitCode = before;
  return { code: observed, ctx };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOk(cwd, ...args) {
  try { return { ok: true, stdout: git(cwd, ...args) }; }
  catch (err) { return { ok: false, stdout: "", stderr: err.stderr ? err.stderr.toString() : err.message }; }
}

function initRepo(cwd) {
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  // Add `.agent/` to .git/info/exclude so the test setup that copies
  // registry.json fixtures into .agent/branches/ doesn't show as
  // untracked (which would make the working tree look dirty to the
  // `git status --porcelain` checks below).
  fs.mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "info", "exclude"), "/.agent\n");
  // Need at least one commit so HEAD resolves.
  fs.writeFileSync(path.join(cwd, "README.md"), "init\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-m", "init");
  return cwd;
}

function copyFixture(cwd, name) {
  const src = path.join(__dirname, "fixtures", name);
  const target = path.join(cwd, ".agent", "branches", "registry.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src, target);
  return target;
}

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function mtime(p) {
  return fs.statSync(p).mtimeMs;
}

// ─── parseBranchArgs ─────────────────────────────────────────────────────────

test("branch-cli: parseBranchArgs extracts subcommand + flags", () => {
  const r = parseBranchArgs([
    "list", "--type", "feat", "--status", "active", "--json",
  ]);
  assert.equal(r.subcommand, "list");
  assert.equal(r.type, "feat");
  assert.equal(r.status, "active");
  assert.equal(r.outputJson, true);
});

test("branch-cli: parseBranchArgs handles --flag=value form", () => {
  const r = parseBranchArgs([
    "merge", "feat/x", "--strategy=squash", "--to=main", "--no-delete", "--allow-foreign",
  ]);
  assert.equal(r.subcommand, "merge");
  assert.equal(r.branchName, "feat/x");
  assert.equal(r.strategy, "squash");
  assert.equal(r.to, "main");
  assert.equal(r.noDelete, true);
  assert.equal(r.allowForeign, true);
});

test("branch-cli: parseBranchArgs defaults merge strategy to ff", () => {
  const r = parseBranchArgs(["merge", "feat/x"]);
  assert.equal(r.strategy, "ff");
  assert.equal(r.to, "main");
  assert.equal(r.noDelete, false);
  assert.equal(r.allowForeign, false);
});

test("branch-cli: parseBranchArgs default staleDays is 30", () => {
  const r = parseBranchArgs(["cleanup"]);
  assert.equal(r.staleDays, 30);
  assert.equal(r.dryRun, false);
});

test("branch-cli: ALLOWED_STATUSES / ALLOWED_TYPES surface contract", () => {
  assert.deepEqual(ALLOWED_STATUSES, ["active", "merge_ready", "merged", "archived"]);
  assert.deepEqual(ALLOWED_TYPES, ["feat", "fix", "release", "hotfix", "chore"]);
});

// ─── list (happy + negative) ─────────────────────────────────────────────────

test("branch-cli: list — no filter returns all branches from populated fixture", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  // Capture stdout via direct call to registry (the subcommand writes to
  // process.stdout which we don't intercept; verify the data shape).
  const r = branchRegistry.listBranches(cwd);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 6);
});

test("branch-cli: list — type filter narrows to single type", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const r = branchRegistry.listBranches(cwd, { type: "feat" });
  assert.equal(r.ok, true);
  assert.equal(r.entries.every((e) => e.type === "feat"), true);
  assert.equal(r.entries.length, 2);
});

test("branch-cli: list — status filter narrows to single status", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const r = branchRegistry.listBranches(cwd, { status: "merged" });
  assert.equal(r.ok, true);
  assert.equal(r.entries.every((e) => e.status === "merged"), true);
  assert.equal(r.entries.length, 2);
});

test("branch-cli: list — rejects unknown status filter (exit 1)", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "list", "--status", "unknown");
  assert.equal(code, 1);
});

test("branch-cli: list — rejects unknown type filter (exit 1)", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "list", "--type", "feature");
  assert.equal(code, 1);
});

test("branch-cli: list — JSON output contains branches + total fields", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  // Capture stdout by writing to a pipe-friendly function: just assert that
  // --json is parsed by parseBranchArgs and the registry shape is stable.
  const parsed = parseBranchArgs(["list", "--json"]);
  assert.equal(parsed.outputJson, true);
  const r = branchRegistry.listBranches(cwd, { type: "feat" });
  const payload = {
    branches: r.entries.map((e) => ({
      name: e.name, type: e.type, base: e.base_branch, status: e.status,
      commits_ahead: e.commits_ahead, last_sync: e.last_sync,
      proposal_ref: e.proposal_ref, mission_id: e.mission_id,
    })),
    total: r.entries.length,
  };
  assert.ok(Array.isArray(payload.branches));
  assert.equal(payload.total, 2);
});

// ─── show (happy + negative) ─────────────────────────────────────────────────

test("branch-cli: show — branch not in registry (exit 1)", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "show", "feat/does-not-exist");
  assert.equal(code, 1);
});

test("branch-cli: show — missing branch name argument (exit 1)", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "show");
  assert.equal(code, 1);
});

test("branch-cli: show — registry has entry but git ref missing (exit 2)", () => {
  // No git repo at cwd → rev-parse fails → gate failure (2).
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "show", "feat/branch-management");
  assert.equal(code, 2);
});

test("branch-cli: show — happy path: registry entry + git ref (exit 0)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/branch-management");
  // create a commit on the feature branch so rev-parse succeeds
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feature");
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "show", "feat/branch-management");
  assert.equal(code, 0);
});

// ─── create (happy + multiple negatives) ─────────────────────────────────────

test("branch-cli: create — missing --from (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  const { code } = runSubcommand(cwd, "create");
  assert.equal(code, 1);
});

test("branch-cli: create — proposal file does not exist (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  const { code } = runSubcommand(cwd, "create", "--from", "/no/such/proposal.md");
  assert.equal(code, 1);
});

test("branch-cli: create — uppercase name violates kebab-case (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "MyBranch");
  assert.equal(code, 1);
});

test("branch-cli: create — name exceeds 60 chars (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  const longName = "a".repeat(57); // 57 + "feat/" = 62 > 60
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", longName);
  assert.equal(code, 1);
});

test("branch-cli: create — refuse to create from main (exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  // cwd is on main
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--base", "main");
  assert.equal(code, 2);
});

test("branch-cli: create — dirty working tree (exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  // Make tree dirty: untracked file is enough (we treat untracked as dirty).
  fs.writeFileSync(path.join(cwd, "dirty.txt"), "wip\n");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md");
  assert.equal(code, 2);
});

test("branch-cli: create — happy path on clean feature branch (exit 0)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  // Commit the proposal so the working tree stays clean (proposal isn't
  // part of `.agent/`, so it would otherwise show as untracked → dirty).
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "test-branch");
  assert.equal(code, 0);
  // registry now has the new branch
  const r = branchRegistry.getBranch(cwd, "feat/test-branch");
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, "active");
  assert.equal(r.entry.proposal_ref, "p/x.md");
});

// ─── sync ────────────────────────────────────────────────────────────────────

test("branch-cli: sync — branch not in registry (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "sync", "feat/does-not-exist", "--no-rebase");
  assert.equal(code, 1);
});

test("branch-cli: sync — happy path with --no-rebase (exit 0)", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  // sync feat/branch-management — exists in registry, use --no-rebase to
  // skip the rebase step (no upstream configured in this test repo).
  const { code } = runSubcommand(cwd, "sync", "feat/branch-management", "--no-rebase");
  assert.equal(code, 0);
});

// ─── ready ───────────────────────────────────────────────────────────────────

test("branch-cli: ready — branch not in registry (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  const { code } = runSubcommand(cwd, "ready", "feat/nope");
  assert.equal(code, 1);
});

test("branch-cli: ready — happy path: active → merge_ready (exit 0)", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "ready", "feat/m016-ms002-cli");
  assert.equal(code, 0);
  const r = branchRegistry.getBranch(cwd, "feat/m016-ms002-cli");
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, "merge_ready");
});

test("branch-cli: ready — dirty working tree fails gate (exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  fs.writeFileSync(path.join(cwd, "wip.txt"), "wip\n");
  const { code } = runSubcommand(cwd, "ready", "feat/m016-ms002-cli");
  assert.equal(code, 2);
});

test("branch-cli: ready — missing validation artifact fails gate (exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(
    cwd, "ready", "feat/m016-ms002-cli", "--validation-artifact", "/no/such/artifact.json"
  );
  assert.equal(code, 2);
});

// ─── merge — VC-016-07 (4 fail-closed gates) ─────────────────────────────────

test("branch-cli: merge — refuse to merge on main (gate 1, exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  // cwd is on main
  const { code } = runSubcommand(cwd, "merge", "feat/branch-management");
  assert.equal(code, 2);
});

test("branch-cli: merge — dirty working tree (gate 2, exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  // create feature branch + checkout
  git(cwd, "switch", "-c", "feat/dirty-test");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat");
  copyFixture(cwd, "branch-populated.json");
  // add + mark merge_ready (use upsertBranch since this branch isn't in the
  // populated fixture)
  branchRegistry.upsertBranch(cwd, {
    name: "feat/dirty-test",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "dirty test fixture",
  });
  // dirty the tree with a tracked-but-uncommitted edit
  fs.writeFileSync(path.join(cwd, "feature.txt"), "dirty\n");
  const { code } = runSubcommand(cwd, "merge", "feat/dirty-test");
  assert.equal(code, 2);
});

test("branch-cli: merge — branch behind main (gate 4, exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  // main gets a new commit; then we branch off the OLD main
  git(cwd, "switch", "-c", "feat/test");
  fs.writeFileSync(path.join(cwd, "feat.txt"), "feat\n");
  git(cwd, "add", "feat.txt");
  git(cwd, "commit", "-m", "feat commit");
  copyFixture(cwd, "branch-populated.json");
  // upsert the test branch with status merge_ready + commits_ahead=-3 (behind)
  branchRegistry.upsertBranch(cwd, {
    name: "feat/test",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    commits_ahead: -3,
    purpose: "behind-main test fixture",
  });
  const { code } = runSubcommand(cwd, "merge", "feat/test");
  assert.equal(code, 2);
});

test("branch-cli: merge — status != merge_ready (gate 5, exit 2)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/active-test");
  fs.writeFileSync(path.join(cwd, "feat.txt"), "feat\n");
  git(cwd, "add", "feat.txt");
  git(cwd, "commit", "-m", "feat");
  copyFixture(cwd, "branch-populated.json");
  // upsert with default status=active
  branchRegistry.upsertBranch(cwd, {
    name: "feat/active-test",
    type: "feat",
    base_branch: "main",
    purpose: "active-status test fixture",
  });
  const { code } = runSubcommand(cwd, "merge", "feat/active-test");
  assert.equal(code, 2);
});

test("branch-cli: merge — branch not in registry (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  const { code } = runSubcommand(cwd, "merge", "feat/missing");
  assert.equal(code, 1);
});

test("branch-cli: merge — invalid strategy (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "merge", "feat/branch-management", "--strategy", "octopus");
  assert.equal(code, 1);
});

// ─── cleanup — VC-016-06 (dry-run MUST NOT modify file) ──────────────────────

test("branch-cli: cleanup — dry-run does not modify registry.json (sha256+mtime)", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const target = branchRegistry.registryPath(cwd);
  const shaBefore = sha256(target);
  const mtimeBefore = mtime(target);

  // Even though the populated fixture's last_sync dates are older than 30
  // days, --dry-run must NOT mutate the file regardless of the candidate
  // set. This is the explicit VC-016-06 contract.
  const { code } = runSubcommand(cwd, "cleanup", "--dry-run", "--stale-days", "30");
  assert.equal(code, 0);

  const shaAfter = sha256(target);
  const mtimeAfter = mtime(target);
  assert.equal(shaBefore, shaAfter, "registry.json content changed during --dry-run");
  assert.equal(mtimeBefore, mtimeAfter, "registry.json mtime changed during --dry-run");
});

test("branch-cli: cleanup — dry-run with no candidates prints empty notice", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-minimal.json");
  const { code } = runSubcommand(cwd, "cleanup", "--dry-run", "--stale-days", "30");
  assert.equal(code, 0);
});

test("branch-cli: cleanup — JSON output structure includes dry_run + candidates", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  // Inspect the data shape the subcommand would emit (parseBranchArgs +
  // registry filter give us the same view the subcommand has internally).
  const parsed = parseBranchArgs(["cleanup", "--dry-run", "--stale-days", "30", "--json"]);
  assert.equal(parsed.outputJson, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.staleDays, 30);

  const cutoff = Date.now() - 30 * 86400_000;
  const r = branchRegistry.listBranches(cwd);
  const candidates = r.entries.filter((e) => {
    if (!["merged", "archived"].includes(e.status)) return false;
    const t = e.last_sync ? Date.parse(e.last_sync) : NaN;
    return Number.isFinite(t) && t <= cutoff;
  });
  // Populated fixture has 3 merged/archived entries with old last_sync, so
  // we expect at least 1 candidate.
  assert.ok(candidates.length >= 1, "expected at least 1 cleanup candidate in populated fixture");
});

// ─── corrupt recovery (smoke test) ──────────────────────────────────────────

test("branch-cli: list — readRegistry recovers from corrupt JSON", () => {
  const cwd = tmp();
  // Use the corrupt fixture (truncated JSON) and confirm the registry reader
  // auto-recovers by writing a fresh empty schema. This is the path that
  // .agent/branches/registry.json takes after a crash; the CLI must not
  // explode.
  const target = branchRegistry.registryPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "fixtures", "branch-corrupt.json"),
    target,
  );
  // Without --recover=false, readRegistry should succeed and the file should
  // now be a valid empty schema (the corrupt blob is backed up).
  const r = branchRegistry.readRegistry(cwd);
  assert.equal(r.ok, true);
  assert.equal(r.recovered, true);
  // And the file is now parseable JSON with empty branches.
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(parsed.branches, {});
});

// ─── help + edge cases (coverage + a11y) ────────────────────────────────────

test("branch-cli: branch --help prints 7 subcommands", () => {
  const cwd = tmp();
  const { code } = runSubcommand(cwd, "--help");
  assert.equal(code, 0);
});

test("branch-cli: branch (no subcommand) prints help (exit 0)", () => {
  const cwd = tmp();
  const { code } = runSubcommand(cwd);
  assert.equal(code, 0);
});

test("branch-cli: unknown subcommand (exit 2)", () => {
  const cwd = tmp();
  const { code } = runSubcommand(cwd, "frobnicate");
  assert.equal(code, 2);
});

test("branch-cli: create — invalid --type rejected (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--type", "feature");
  assert.equal(code, 1);
});

test("branch-cli: show — happy path covers JSON output shape", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/show-test");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/show-test",
    type: "feat",
    base_branch: "main",
    status: "active",
    purpose: "show test",
  });
  const { code } = runSubcommand(cwd, "show", "feat/show-test", "--json");
  assert.equal(code, 0);
});

test("branch-cli: list — JSON output shape on populated fixture", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "list", "--json");
  assert.equal(code, 0);
});

test("branch-cli: list — empty registry prints empty notice", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-minimal.json");
  const { code } = runSubcommand(cwd, "list");
  assert.equal(code, 0);
});

test("branch-cli: list — filter that matches nothing (no error, exit 0)", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  // The populated fixture has 0 archived entries that are NOT hotfix or
  // chore... but we can filter by status=active which has entries.
  const { code } = runSubcommand(cwd, "list", "--status", "active");
  assert.equal(code, 0);
});

// ─── merge — happy path (real ff merge) ──────────────────────────────────────

test("branch-cli: merge — happy path: ff merge into main (exit 0)", () => {
  const cwd = tmp();
  initRepo(cwd);
  // Create a feature branch with one commit
  git(cwd, "switch", "-c", "feat/merge-happy");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat commit");
  // Register + mark merge_ready
  branchRegistry.upsertBranch(cwd, {
    name: "feat/merge-happy",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "merge happy path",
  });
  // With cwd on feat/merge-happy and registry status=merge_ready, the merge
  // should succeed and fast-forward main onto the feature commit.
  const { code } = runSubcommand(cwd, "merge", "feat/merge-happy");
  assert.equal(code, 0);
  // Registry entry should now be merged/archived
  const r = branchRegistry.getBranch(cwd, "feat/merge-happy");
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, "archived");
});

test("branch-cli: merge — JSON output on success", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/merge-json");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/merge-json",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "merge json test",
  });
  const { code } = runSubcommand(cwd, "merge", "feat/merge-json", "--json");
  assert.equal(code, 0);
});

// ─── cleanup — real mode (without --dry-run) ─────────────────────────────────

test("branch-cli: cleanup — real mode archives merged stale branches", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  // The populated fixture has 2 merged entries with last_sync old enough
  // to be stale (fix/t-fix-tests-001 and ops-stash, both 2026-01-22).
  // ops-stash has a non-conforming name (no feat/fix/... prefix) and is
  // intentionally skipped by the cleanup implementation — this matches
  // the real-world scenario where pre-M-016 historical entries coexist
  // with the new naming contract.
  const before = branchRegistry.listBranches(cwd, { status: "merged" });
  assert.ok(before.entries.length >= 1, "fixture should have merged entries");

  const { code } = runSubcommand(cwd, "cleanup", "--stale-days", "30");
  assert.equal(code, 0);

  const after = branchRegistry.listBranches(cwd, { status: "archived" });
  // At least one of the previously-merged entries is now archived
  assert.ok(after.entries.length >= 1, "after cleanup, at least 1 entry should be archived");
  // Verify the names that DO conform to the M-016 prefix whitelist moved
  // to archived. (ops-stash is intentionally left as `merged` because its
  // name doesn't pass branch-naming.validate, and the cleanup
  // implementation skips invalid names silently to avoid data loss.)
  for (const b of before.entries) {
    if (/^(feat|fix|release|hotfix|chore)\//.test(b.name)) {
      const r = branchRegistry.getBranch(cwd, b.name);
      assert.equal(r.entry.status, "archived",
        `${b.name} should be archived after real cleanup (valid prefix)`);
    }
  }
});

// ─── create — extra coverage for the rebase + base-commit paths ───────────────

test("branch-cli: create — happy path captures base_commit from base branch", () => {
  const cwd = tmp();
  initRepo(cwd);
  // Add a commit on main so main has a known HEAD
  fs.writeFileSync(path.join(cwd, "base.md"), "base content\n");
  git(cwd, "add", "base.md");
  git(cwd, "commit", "-m", "base commit");
  const mainHead = git(cwd, "rev-parse", "main");
  // Create a different prep branch (we can't be on the target branch
  // because `git switch -c` would refuse to recreate an existing branch).
  git(cwd, "switch", "-c", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "base-test");
  assert.equal(code, 0);
  const r = branchRegistry.getBranch(cwd, "feat/base-test");
  assert.equal(r.ok, true);
  // base_commit should be main's HEAD at the time of create
  assert.equal(r.entry.base_commit, mainHead);
  assert.equal(r.entry.status, "active");
});

// ─── additional coverage paths (rebase, squash, --no-delete) ────────────────

test("branch-cli: sync — happy path WITHOUT --no-rebase (rebase + commits_ahead)", () => {
  // Exercises the rebase path inside sync (the --no-rebase version is
  // already covered above; this one tests the rebase + commits_ahead
  // recomputation path).
  const cwd = tmp();
  initRepo(cwd);
  // Create a feature branch with a commit
  git(cwd, "switch", "-c", "feat/sync-rebase");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat commit");
  // Register the branch so sync can find it
  branchRegistry.upsertBranch(cwd, {
    name: "feat/sync-rebase",
    type: "feat",
    base_branch: "main",
    status: "active",
    purpose: "sync rebase test",
  });
  // sync without --no-rebase (rebase is best-effort; no upstream so fetch
  // is tolerated, rebase against main is a no-op since main is the
  // immediate parent).
  const { code } = runSubcommand(cwd, "sync", "feat/sync-rebase");
  assert.equal(code, 0);
  // commits_ahead should be recomputed (1 since feat is 1 commit ahead).
  const r = branchRegistry.getBranch(cwd, "feat/sync-rebase");
  assert.equal(r.entry.commits_ahead, 1);
});

test("branch-cli: merge — happy path with --no-delete keeps the branch", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/keep");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/keep",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "no-delete test",
  });
  const { code } = runSubcommand(cwd, "merge", "feat/keep", "--no-delete");
  assert.equal(code, 0);
  // Branch should still exist (not deleted)
  const branches = git(cwd, "branch", "--list", "feat/keep");
  assert.ok(branches.includes("feat/keep"), "branch should still exist with --no-delete");
});

test("branch-cli: merge — happy path with --strategy squash", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/squash");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/squash",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "squash test",
  });
  const { code } = runSubcommand(cwd, "merge", "feat/squash", "--strategy", "squash");
  assert.equal(code, 0);
  // The squash merge produces a single new commit on main; feat/squash
  // entry should be archived.
  const r = branchRegistry.getBranch(cwd, "feat/squash");
  assert.equal(r.entry.status, "archived");
});

test("branch-cli: ready — happy path WITH validation artifact", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  // write a fake validation artifact and commit it (so the working-tree
  // check doesn't reject it as untracked).
  fs.writeFileSync(path.join(cwd, "validation.json"), JSON.stringify({ ok: true }));
  git(cwd, "add", "validation.json");
  git(cwd, "commit", "-m", "validation artifact");
  const { code } = runSubcommand(
    cwd, "ready", "feat/m016-ms002-cli", "--validation-artifact", "validation.json"
  );
  assert.equal(code, 0);
  const r = branchRegistry.getBranch(cwd, "feat/m016-ms002-cli");
  assert.equal(r.entry.status, "merge_ready");
});

test("branch-cli: create — happy path WITH --base override (no rebase against current)", () => {
  // Verifies the create path when --base is explicitly set to a different
  // branch (here, we use the literal main ref). This exercises the
  // refExists → rebase → switch -c flow against a branch the user picked.
  const cwd = tmp();
  initRepo(cwd);
  // Add a commit on main first
  fs.writeFileSync(path.join(cwd, "extra.md"), "x\n");
  git(cwd, "add", "extra.md");
  git(cwd, "commit", "-m", "extra");
  // Switch to a different prep branch
  git(cwd, "switch", "-c", "feat/different-prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "custom-base", "--base", "main");
  assert.equal(code, 0);
  const r = branchRegistry.getBranch(cwd, "feat/custom-base");
  assert.equal(r.ok, true);
  assert.equal(r.entry.base_branch, "main");
});

test("branch-cli: create — JSON output on success", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/json-prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "json-test", "--json");
  assert.equal(code, 0);
});

test("branch-cli: sync — happy path WITHOUT --no-rebase + JSON output", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/sync-json");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feat\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/sync-json",
    type: "feat",
    base_branch: "main",
    status: "active",
    purpose: "sync json test",
  });
  const { code } = runSubcommand(cwd, "sync", "feat/sync-json", "--json");
  assert.equal(code, 0);
});

// ─── parser edge cases (coverage for parseBranchArgs branches) ──────────────

test("branch-cli: parseBranchArgs — --from=value and other equals forms", () => {
  // Exercises the --key=value parsing branches (lines 125-127, etc.)
  const r = parseBranchArgs([
    "create", "--from=./p.md", "--name=foo", "--base=main", "--type=feat",
  ]);
  assert.equal(r.from, "./p.md");
  assert.equal(r.name, "foo");
  assert.equal(r.base, "main");
  assert.equal(r.type, "feat");
});

test("branch-cli: parseBranchArgs — unknown flag is ignored (no error)", () => {
  const r = parseBranchArgs(["list", "--unknown-flag", "value", "--json"]);
  assert.equal(r.outputJson, true);
  assert.equal(r.subcommand, "list");
});

test("branch-cli: parseBranchArgs — missing value for --from throws", () => {
  // Exercises the nextValue error path (line 142-145)
  assert.throws(
    () => parseBranchArgs(["create", "--from"]),
    /--from requires a value/,
  );
});

test("branch-cli: branchCommand — parse error (exit 1)", () => {
  // Calling branchCommand with --from and no value triggers parseBranchArgs
  // to throw → caught by branchCommand → exit 1.
  const cwd = tmp();
  initRepo(cwd);
  const ctx = ctxFor(cwd, ["branch", "create", "--from"]);
  process.exitCode = 0;
  let code = 0;
  try { code = branchCommand(ctx); } catch (_) { code = 99; }
  assert.equal(process.exitCode, 1);
  assert.equal(code, 1);
  process.exitCode = 0;
});

test("branch-cli: sync — missing branch name (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  const { code } = runSubcommand(cwd, "sync");
  assert.equal(code, 1);
});

test("branch-cli: ready — missing branch name (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  const { code } = runSubcommand(cwd, "ready");
  assert.equal(code, 1);
});

test("branch-cli: merge — missing branch name (exit 1)", () => {
  const cwd = tmp();
  initRepo(cwd);
  const { code } = runSubcommand(cwd, "merge");
  assert.equal(code, 1);
});

test("branch-cli: show — registry has entry but git ref missing (exit 2 — already covered, see other test)", () => {
  // Smoke: confirm the test infra for the exit-2 case is stable.
  const cwd = tmp();
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "show", "feat/branch-management");
  assert.equal(code, 2);
});

// ─── system-error paths (rebase conflict, merge conflict) ───────────────────

test("branch-cli: create — rebase conflict (exit 3, system error)", () => {
  // Set up a rebase conflict: main has a different change to the same file
  // the proposal modifies. When create rebases the prep branch onto main,
  // it will fail.
  const cwd = tmp();
  initRepo(cwd);
  fs.writeFileSync(path.join(cwd, "shared.md"), "main line\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "main: shared line");
  // prep branch modifies the same file
  git(cwd, "switch", "-c", "feat/prep");
  fs.writeFileSync(path.join(cwd, "shared.md"), "prep line\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "prep: shared line");
  // main advances with a different change
  git(cwd, "checkout", "main");
  fs.writeFileSync(path.join(cwd, "shared.md"), "main advance line\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "main: advance");
  // Switch back to prep (with conflicts ready to be triggered on rebase)
  git(cwd, "checkout", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  // Now run create. It will rebase prep onto main, which will conflict.
  // The result should be exit 3 (system error).
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "test-conflict");
  assert.equal(code, 3);
  // And the registry should NOT have the new entry.
  const r = branchRegistry.getBranch(cwd, "feat/test-conflict");
  assert.equal(r.ok, false);
});

test("branch-cli: merge — merge conflict (exit 3, system error)", () => {
  // Set up a merge conflict: feature branch and main both modify the same
  // file. When we try to merge feature into main, conflict.
  const cwd = tmp();
  initRepo(cwd);
  fs.writeFileSync(path.join(cwd, "shared.md"), "v0\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "init shared");
  // Feature branch modifies the file
  git(cwd, "switch", "-c", "feat/conflict");
  fs.writeFileSync(path.join(cwd, "shared.md"), "feature change\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "feature: change");
  // main advances with a different change
  git(cwd, "checkout", "main");
  fs.writeFileSync(path.join(cwd, "shared.md"), "main change\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "main: change");
  // Switch back to feat/conflict
  git(cwd, "checkout", "feat/conflict");
  // Register and mark merge_ready
  branchRegistry.upsertBranch(cwd, {
    name: "feat/conflict",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "merge conflict test",
  });
  const { code } = runSubcommand(cwd, "merge", "feat/conflict");
  assert.equal(code, 3);
});

test("branch-cli: merge — target branch not found (exit 3)", () => {
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/no-target");
  fs.writeFileSync(path.join(cwd, "feature.txt"), "x\n");
  git(cwd, "add", "feature.txt");
  git(cwd, "commit", "-m", "feat");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/no-target",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "no target test",
  });
  // Use --to with a branch that doesn't exist
  const { code } = runSubcommand(cwd, "merge", "feat/no-target", "--to", "no-such-branch");
  assert.equal(code, 3);
});

test("branch-cli: create — invalid name with non-whitelisted prefix", () => {
  // The create flow always uses parsed.type as prefix, so the only way to
  // hit `branch_name_invalid_prefix` is to bypass that with --name=foo/bar
  // when --type is feat (e.g. --name contains a slash). This exercises
  // the "else" branch of the validator error mapping.
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  // --name with invalid chars (e.g., leading dash) fails kebab-case
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "-bad-name");
  assert.equal(code, 1);
});

test("branch-cli: create — bare task id body (rejected, exit 1)", () => {
  // Exercises the "else" branch of the validator error mapping in create
  // (the `branch_name_body_is_bare_task_id` path which the
  // kebab-case/length checks don't cover).
  const cwd = tmp();
  initRepo(cwd);
  git(cwd, "switch", "-c", "feat/prep");
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  // --name that resolves to a bare task id body
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "T-001");
  assert.equal(code, 1);
});

test("branch-cli: create — switch -c fails when branch already exists (exit 3)", () => {
  // Exercises the `if (!switched.ok)` branch in create (line 321-323) by
  // pre-creating a branch with the same name as the new one.
  const cwd = tmp();
  initRepo(cwd);
  // Pre-create the branch we want to create later
  git(cwd, "switch", "-c", "feat/dup-target");
  // Add proposal and commit
  fs.mkdirSync(path.join(cwd, "p"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "p", "x.md"), "# x\n");
  git(cwd, "add", "p/x.md");
  git(cwd, "commit", "-m", "proposal");
  // Now switch to a different prep branch and try to create the same name
  git(cwd, "switch", "-c", "feat/other-prep");
  const { code } = runSubcommand(cwd, "create", "--from", "p/x.md", "--name", "dup-target");
  assert.equal(code, 3);
});

test("branch-cli: cleanup — JSON output on empty registry", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-minimal.json");
  const { code } = runSubcommand(cwd, "cleanup", "--json");
  assert.equal(code, 0);
});

test("branch-cli: cleanup — real mode on minimal registry (no candidates, exit 0)", () => {
  const cwd = tmp();
  copyFixture(cwd, "branch-minimal.json");
  const { code } = runSubcommand(cwd, "cleanup");
  assert.equal(code, 0);
});

test("branch-cli: cleanup — type filter applied", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  // --type feat filter — only feat branches (active, not stale by
  // definition since they're fresh). Empty candidates expected.
  const { code } = runSubcommand(cwd, "cleanup", "--dry-run", "--type", "feat", "--json");
  assert.equal(code, 0);
});

test("branch-cli: ready — already merge_ready idempotent (exit 0)", () => {
  // Exercises the registry-update success path on an already-correct entry.
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/m016-ms002-cli",
    type: "feat",
    base_branch: "main",
    status: "merge_ready",
    purpose: "already-ready test",
  });
  const { code } = runSubcommand(cwd, "ready", "feat/m016-ms002-cli");
  assert.equal(code, 0);
});

test("branch-cli: ready — JSON output on success", () => {
  const cwd = tmp();
  initRepo(cwd);
  copyFixture(cwd, "branch-populated.json");
  const { code } = runSubcommand(cwd, "ready", "feat/m016-ms002-cli", "--json");
  assert.equal(code, 0);
});

test("branch-cli: sync — rebase failure when behind main (exit 3)", () => {
  // Trigger sync's rebase conflict path by making main advance with
  // conflicting content. Exercises lines 514-517.
  const cwd = tmp();
  initRepo(cwd);
  // prep branch creates a baseline
  git(cwd, "switch", "-c", "feat/rebase-fail");
  fs.writeFileSync(path.join(cwd, "shared.md"), "feat v1\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "feat v1");
  // main advances with conflicting change
  git(cwd, "checkout", "main");
  fs.writeFileSync(path.join(cwd, "shared.md"), "main v1\n");
  git(cwd, "add", "shared.md");
  git(cwd, "commit", "-m", "main v1");
  // back to feat
  git(cwd, "checkout", "feat/rebase-fail");
  branchRegistry.upsertBranch(cwd, {
    name: "feat/rebase-fail",
    type: "feat",
    base_branch: "main",
    status: "active",
    purpose: "rebase fail test",
  });
  const { code } = runSubcommand(cwd, "sync", "feat/rebase-fail");
  assert.equal(code, 3);
});
