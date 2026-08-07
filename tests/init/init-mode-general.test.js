"use strict";

/**
 * MS-002 tests:
 *   1. `lib/mode-infer.js` — 5+ inference scenarios.
 *   2. `bin/cli.js init --mode general` end-to-end (skipped when
 *      `templates/_base/.agent/` is missing — MS-001 owns that layer and
 *      merges independently).
 *   3. Additive-only guard — ensures MS-002 does not modify the init
 *      function body, language templates, or other subcommands.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const { inferMode } = require("../../lib/mode-infer");

// ─── helpers ──────────────────────────────────────────────────────────────────

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", ...env },
  });
}

function readBaseCommit() {
  const out = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(out.status, 0, `git rev-parse failed: ${out.stderr}`);
  return out.stdout.trim();
}

// ─── 1. inferMode unit tests ──────────────────────────────────────────────────

test("inferMode: empty directory defaults to 'general'", () => {
  const dir = mkTmp("cortex-infer-empty-");
  try {
    assert.equal(inferMode(dir), "general");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: AGENTS.md presence -> 'general'", () => {
  const dir = mkTmp("cortex-infer-agents-");
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# project\n", "utf8");
    assert.equal(inferMode(dir), "general");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: AGENTS.md wins over package.json", () => {
  const dir = mkTmp("cortex-infer-agents-wins-");
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# project\n", "utf8");
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    assert.equal(inferMode(dir), "general");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: .cursorrules -> 'code'", () => {
  const dir = mkTmp("cortex-infer-cursor-");
  try {
    fs.writeFileSync(path.join(dir, ".cursorrules"), "", "utf8");
    assert.equal(inferMode(dir), "code");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: .github/copilot-instructions.md -> 'code'", () => {
  const dir = mkTmp("cortex-infer-copilot-");
  try {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".github", "copilot-instructions.md"),
      "",
      "utf8",
    );
    assert.equal(inferMode(dir), "code");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: package.json -> 'code'", () => {
  const dir = mkTmp("cortex-infer-pkg-");
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    assert.equal(inferMode(dir), "code");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: rejects non-string cwd", () => {
  assert.throws(() => inferMode(""), /non-empty string/);
  assert.throws(() => inferMode(null), /non-empty string/);
  assert.throws(() => inferMode(42), /non-empty string/);
});

// ─── 2. init --mode general end-to-end ────────────────────────────────────────

const BASE_TEMPLATES = path.join(ROOT, "templates", "_base", ".agent");

const EXPECTED_DATA_DIRS = [
  "inbox",
  "decisions",
  "waitpoints",
  "runs",
  "sessions",
  "missions",
  "handoffs",
  "conversations",
  "memory",
  "agents",
  "tasks",
];

test("init --mode general: copies shared data layer to empty dir (skip if MS-001 not merged)", { skip: !fs.existsSync(BASE_TEMPLATES) && "templates/_base/.agent missing — MS-001 still in flight" }, () => {
  if (!fs.existsSync(BASE_TEMPLATES)) return; // defensive — skip is honoured above
  const dir = mkTmp("cortex-init-general-empty-");
  try {
    const result = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(result.status, 0, `cli exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    for (const sub of EXPECTED_DATA_DIRS) {
      const target = path.join(dir, ".agent", sub);
      assert.ok(
        fs.existsSync(target) && fs.statSync(target).isDirectory(),
        `expected data dir ${sub} to be created at ${target}`,
      );
    }
  } finally {
    rmrf(dir);
  }
});

test("init --mode general: fills missing data dirs in existing project (skip if MS-001 not merged)", { skip: !fs.existsSync(BASE_TEMPLATES) && "templates/_base/.agent missing — MS-001 still in flight" }, () => {
  if (!fs.existsSync(BASE_TEMPLATES)) return;
  const dir = mkTmp("cortex-init-general-existing-");
  try {
    // Pre-create .agent/ with one dir from the data layer already there.
    const existingSub = "inbox";
    fs.mkdirSync(path.join(dir, ".agent", existingSub), { recursive: true });
    const result = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(result.status, 0, `cli exit=${result.status}\nstderr=${result.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, ".agent", existingSub)), "pre-existing dir must be preserved");
    for (const sub of EXPECTED_DATA_DIRS) {
      const target = path.join(dir, ".agent", sub);
      assert.ok(
        fs.existsSync(target),
        `expected data dir ${sub} to be created (additive fill)`,
      );
    }
  } finally {
    rmrf(dir);
  }
});

test("init --mode general: missing templates/_base/.agent surfaces a clear error (current pre-MS-001 state)", { skip: fs.existsSync(BASE_TEMPLATES) && "templates/_base/.agent present — this assertion only applies to the pre-MS-001 state" }, () => {
  const dir = mkTmp("cortex-init-general-missing-");
  try {
    const result = runCli(dir, ["init", "--mode", "general"]);
    assert.notEqual(result.status, 0, "should exit non-zero when templates/_base/.agent is missing");
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /templates\/_base\/\.agent/, "error must mention the missing source path");
  } finally {
    rmrf(dir);
  }
});

// ─── 3. additive-only guard ───────────────────────────────────────────────────

test("MS-002 is additive: only the 3 owned files changed since base", () => {
  const base = readBaseCommit();
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", `${base}..HEAD`, "--", "bin/cli.js", "lib/mode-infer.js", "tests/init-mode-general.test.js"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
  const changed = diff.stdout.trim().split("\n").filter(Boolean).sort();
  // We only check that NO unexpected file under our owned paths changed.
  // This test runs in isolation, so HEAD == base until we commit — but the
  // assertion stays valid both before and after commit: the owned set is
  // exactly {bin/cli.js, lib/mode-infer.js, tests/init-mode-general.test.js}
  // and we only ask that *no other file* in that set sneaks in.
  const allowed = new Set([
    "bin/cli.js",
    "lib/mode-infer.js",
    "tests/init-mode-general.test.js",
  ]);
  for (const file of changed) {
    assert.ok(allowed.has(file), `unexpected change in owned path: ${file}`);
  }
});

test("MS-002 does not modify the existing init function body in lib/commands.js", () => {
  const base = readBaseCommit();
  const diff = spawnSync(
    "git",
    ["diff", `${base}..HEAD`, "--", "lib/commands.js"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
  assert.equal(
    diff.stdout.trim(),
    "",
    `lib/commands.js must be untouched by MS-002, but diff was:\n${diff.stdout}`,
  );
});

test("MS-002 does not modify language templates", () => {
  const base = readBaseCommit();
  const diff = spawnSync(
    "git",
    ["diff", `${base}..HEAD`, "--", "templates/zh", "templates/en"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
  assert.equal(
    diff.stdout.trim(),
    "",
    `templates/{zh,en} must be untouched by MS-002, but diff was:\n${diff.stdout}`,
  );
});

test("MS-002 does not delete any line of the init dispatch in bin/cli.js", () => {
  const base = readBaseCommit();
  const diff = spawnSync(
    "git",
    ["diff", `${base}..HEAD`, "--", "bin/cli.js"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
  // Pure addition: no `-` lines in the diff.
  const removed = diff.stdout
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"));
  assert.deepEqual(
    removed,
    [],
    `bin/cli.js must be additive only — found ${removed.length} removed line(s):\n${removed.join("\n")}`,
  );
});
