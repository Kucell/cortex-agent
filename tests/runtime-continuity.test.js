"use strict";

// Tests for P-001 session CLI facade + runtime-continuity skill scripts.
//
// Strategy:
//   - The CLI facade (`bin/cli.js session`) is exercised end-to-end in a
//     throwaway git project so we can assert on real filesystem side-effects
//     in `~/.agent/contexts/<project>/` and `.agent/runtime-continuity/`.
//   - We DO NOT spy on internal module state. Every assertion reads back
//     from disk, mirroring how a downstream tool (Dashboard, audit-trail) would
//     consume the same paths.
//   - Node.js stdlib only — matches the skill's "zero dependency" guarantee.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const skillScript = path.join(
  repoRoot,
  "templates",
  "_shared",
  ".agent",
  "skills",
  "runtime-continuity",
  "scripts",
  "index.js"
);

const KNOWN_SUBCOMMANDS = [
  "assess",
  "log",
  "checkpoint",
  "archive",
  "restore",
  "resume-bundle",
  "status",
  "warm",
  "host-switch",
  "list-contexts",
];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rc-p001-"));
  // Init a git repo so the script's `git rev-parse` calls succeed.
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "rc-p001@test"], { cwd: root });
  spawnSync("git", ["config", "user.name", "rc-p001"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "# rc-p001 fixture\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  // Set up a stub active run so the script's appendRunEvent() has a target.
  const runsDir = path.join(root, ".agent", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, "R-p001-1.json"),
    JSON.stringify({
      run_id: "R-p001-1",
      status: "running",
      events: [],
      updated_at: "2026-07-31T00:00:00.000Z",
    })
  );
  return root;
}

function runCli(project, args, env = {}) {
  return spawnSync(process.execPath, [cli, "session", ...args], {
    cwd: project,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function runScript(project, args, env = {}) {
  return spawnSync(process.execPath, [skillScript, ...args], {
    cwd: project,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("bin/cli.js session --help lists all 10 subcommands", () => {
  const result = spawnSync(process.execPath, [cli, "session", "--help"], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  for (const name of KNOWN_SUBCOMMANDS) {
    assert.ok(
      result.stdout.includes(name),
      `expected --help output to mention subcommand ${name}`
    );
  }
  // Sanity: the help output should mention the authoritative protocol source
  // so a new agent can find the deeper docs.
  assert.match(result.stdout, /session-manager\.md/);
});

test("bin/cli.js session rejects unknown subcommand with exit 2", () => {
  const result = spawnSync(process.execPath, [cli, "session", "definitely-not-real"], { encoding: "utf8" });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Unknown session subcommand/);
});

test("assess returns a JSON envelope with phases + risk", () => {
  const project = makeProject();
  const result = runScript(project, [
    "assess",
    "--task-description",
    "designing cross-host migration bus for runtime continuity v2",
    "--gate",
    "user",
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "assess");
  assert.ok(typeof out.phases === "number" && out.phases >= 1, "phases must be a positive integer");
  assert.ok(["low", "medium", "high"].includes(out.risk), "risk must be one of low/medium/high");
  assert.ok(out.optimistic > 0 && out.pessimistic >= out.optimistic);
});

test("archive writes markdown, symlink latest.md, and structured JSON", () => {
  const project = makeProject();
  const result = runScript(project, [
    "archive",
    "--project",
    "p001-archive",
    "--gate",
    "user",
    "--note-json",
    JSON.stringify({ done: ["wrote fixture"], in_progress: "verifying archive", next: ["restore"] }),
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.match(out.archivePath, /ctx_.*\.md$/);
  assert.match(out.latestPath, /latest\.md$/);
  // Both files should exist on disk.
  assert.ok(fs.existsSync(out.archivePath), "markdown archive must exist on disk");
  assert.ok(fs.existsSync(out.latestPath), "latest.md must exist on disk");
  // latest.md must be a symlink (or copy fallback on platforms without symlink).
  const latestStat = fs.lstatSync(out.latestPath);
  assert.ok(latestStat.isSymbolicLink() || latestStat.isFile(), "latest.md should be symlink or file");
  // The linked/copied body should mention the project name.
  const body = fs.readFileSync(out.latestPath, "utf8");
  assert.match(body, /p001-archive/);
});

test("restore --list enumerates existing archives", () => {
  const project = makeProject();
  // First archive.
  runScript(project, [
    "archive",
    "--project",
    "p001-list",
    "--gate",
    "user",
    "--note-json",
    JSON.stringify({ done: ["a"], next: ["b"] }),
  ]);
  const result = runScript(project, ["restore", "--project", "p001-list", "--list"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "list");
  assert.ok(Array.isArray(out.contexts) && out.contexts.length >= 1, "expected at least one archive in --list");
  for (const entry of out.contexts) {
    assert.match(entry.name, /^ctx_.*\.md$/);
  }
});

test("restore --auto returns archive body and resume-bundle pointer", () => {
  const project = makeProject();
  runScript(project, [
    "archive",
    "--project",
    "p001-restore",
    "--gate",
    "user",
    "--note-json",
    JSON.stringify({ done: ["x"], in_progress: "y", next: ["z"] }),
  ]);
  const result = runScript(project, ["restore", "--project", "p001-restore", "--auto"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "restore");
  assert.strictEqual(out.mode, "auto");
  assert.ok(out.markdown_path, "expected markdown_path in restore --auto");
  assert.ok(out.archive_json_path, "expected archive_json_path in restore --auto");
  assert.ok(typeof out.archive === "object" && out.archive, "expected archive JSON in restore --auto");
  assert.ok(out.resume_bundle_command && out.resume_bundle_command.includes("resume-bundle"));
});

test("status reports age of the latest archive", () => {
  const project = makeProject();
  runScript(project, [
    "archive",
    "--project",
    "p001-status",
    "--gate",
    "user",
    "--note-json",
    JSON.stringify({ done: ["a"], next: ["b"] }),
  ]);
  const result = runScript(project, ["status", "--project", "p001-status"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "status");
  assert.strictEqual(out.project, "p001-status");
  assert.match(out.latest, /^ctx_.*\.md$/);
  assert.ok(typeof out.age_hours === "number" && out.age_hours >= 0);
  assert.ok(["ok", "archive_now"].includes(out.stale_recommendation));
});

test("warm returns the 5-hour rolling-window prompt", () => {
  const project = makeProject();
  const result = runScript(project, ["warm"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "warm");
  assert.strictEqual(out.duration_hours, 5);
  assert.ok(out.checkpoint_reminder_hours >= 1, "expected explicit checkpoint reminder hour");
  assert.match(out.prompt_for_host_paste, /5 小时计时窗口/);
});

test("host-switch writes cross-host payload and emits host_switch_initiated event", () => {
  const project = makeProject();
  const result = runScript(project, [
    "host-switch",
    "--project",
    "p001-hostswitch",
    "--from-host",
    "claude-code",
    "--to-host",
    "codex",
    "--reason",
    "user wants to try codex",
    "--gate",
    "user",
    "--note-json",
    JSON.stringify({ done: ["phase1"], in_progress: "phase2", next: ["phase3"] }),
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "host-switch");
  assert.strictEqual(out.from_host, "claude-code");
  assert.strictEqual(out.to_host, "codex");
  // Cross-host payload must include archive + session_id + next_steps_for_new_host.
  assert.ok(out.archive && out.archive.archivePath);
  assert.ok(out.session_id);
  assert.ok(Array.isArray(out.next_steps_for_new_host) && out.next_steps_for_new_host.length >= 3);
  // The run event was appended.
  const run = JSON.parse(fs.readFileSync(path.join(project, ".agent", "runs", "R-p001-1.json"), "utf8"));
  const event = run.events.find((e) => e.type === "host_switch_initiated");
  assert.ok(event, "expected host_switch_initiated event in active run");
  assert.strictEqual(event.from_host, "claude-code");
  assert.strictEqual(event.to_host, "codex");
});

test("resume-bundle aggregates archive + runs + sessions + handoffs + git state", () => {
  const project = makeProject();
  runScript(project, [
    "archive",
    "--project",
    "p001-bundle",
    "--gate",
    "user",
    "--note-json",
    JSON.stringify({ done: ["x"], next: ["y"] }),
  ]);
  const result = runScript(project, ["resume-bundle", "--project", "p001-bundle"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "resume-bundle");
  assert.ok(out.latest_archive, "resume-bundle should reference latest_archive");
  assert.ok(out.latest_markdown_archive, "resume-bundle should reference latest_markdown_archive");
  assert.ok(out.archive && out.archive.archive_id);
  assert.ok(Array.isArray(out.runs));
  assert.ok(Array.isArray(out.sessions));
  assert.ok(Array.isArray(out.read_first) && out.read_first.length >= 1);
  assert.ok(Array.isArray(out.recommended_commands) && out.recommended_commands.length >= 1);
  // Git state is populated because we ran inside a real git repo.
  assert.ok(out.git && out.git.branch);
});

test("bin/cli.js session assess delegates to scripts/index.js (integration)", () => {
  const project = makeProject();
  const result = runCli(project, [
    "assess",
    "--task-description",
    "verifying facade delegation",
    "--gate",
    "user",
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  // Same envelope as the underlying script.
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "assess");
  assert.ok(typeof out.phases === "number");
});
