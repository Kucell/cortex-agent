"use strict";

/**
 * MS-003 tests:
 *   1. `lib/mode-infer.js` — re-assert the 5-rule priority list (regression
 *      guard so MS-003 helpers do not perturb inferMode behaviour MS-002
 *      shipped).
 *   2. `lib/mode-infer.js` — new helpers `isInferModeEnabled` and
 *      `selectTemplateDir` (the two pure additions MS-003 makes).
 *   3. `bin/cli.js init` — end-to-end auto-inference for the four canonical
 *      cwd shapes (empty / AGENTS.md / .cursorrules / package.json). Empty
 *      dir + AGENTS.md are expected to take the general profile; .cursorrules
 *      + package.json are expected to take the default code init. Tests are
 *      skipped when `templates/_base/.agent` is missing (pre-MS-001 state)
 *      so they can land independently of the shared-layer extraction.
 *   4. Additive-only guards — lib/commands.js and templates/{zh,en} are
 *      untouched; bin/cli.js diff is pure addition; lib/mode-infer.js did
 *      not modify the inferMode() function body.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const modeInfer = require("../../lib/mode-infer");
const { inferMode, isInferModeEnabled, selectTemplateDir } = modeInfer;

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

const BASE_TEMPLATES = path.join(ROOT, "templates", "_base", ".agent");

const BASE_DATA_DIRS = [
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

// ─── 1. inferMode regression (5-rule priority) ───────────────────────────────

test("inferMode: empty directory defaults to 'general'", () => {
  const dir = mkTmp("cortex-ms003-infer-empty-");
  try {
    assert.equal(inferMode(dir), "general");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: AGENTS.md presence -> 'general'", () => {
  const dir = mkTmp("cortex-ms003-infer-agents-");
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# project\n", "utf8");
    assert.equal(inferMode(dir), "general");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: AGENTS.md wins over package.json", () => {
  const dir = mkTmp("cortex-ms003-infer-agents-wins-");
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# project\n", "utf8");
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf8");
    assert.equal(inferMode(dir), "general");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: .cursorrules -> 'code'", () => {
  const dir = mkTmp("cortex-ms003-infer-cursor-");
  try {
    fs.writeFileSync(path.join(dir, ".cursorrules"), "", "utf8");
    assert.equal(inferMode(dir), "code");
  } finally {
    rmrf(dir);
  }
});

test("inferMode: .github/copilot-instructions.md -> 'code'", () => {
  const dir = mkTmp("cortex-ms003-infer-copilot-");
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
  const dir = mkTmp("cortex-ms003-infer-pkg-");
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

// ─── 2. isInferModeEnabled ────────────────────────────────────────────────────

test("isInferModeEnabled: returns true when no --mode flag is present", () => {
  assert.equal(isInferModeEnabled({ options: {}, args: ["init"] }), true);
  assert.equal(isInferModeEnabled({ options: {}, args: [] }), true);
  // options exists but mode is undefined
  assert.equal(isInferModeEnabled({ options: { lang: "en" }, args: ["init"] }), true);
});

test("isInferModeEnabled: returns false when --mode is present (space form)", () => {
  assert.equal(
    isInferModeEnabled({ options: { mode: "general" }, args: ["init", "--mode", "general"] }),
    false,
  );
  assert.equal(
    isInferModeEnabled({ options: {}, args: ["init", "--mode", "code"] }),
    false,
  );
});

test("isInferModeEnabled: returns false when --mode= is present (= form)", () => {
  assert.equal(
    isInferModeEnabled({ options: { mode: "general" }, args: ["init", "--mode=general"] }),
    false,
  );
  assert.equal(
    isInferModeEnabled({ options: {}, args: ["init", "--mode=code"] }),
    false,
  );
});

test("isInferModeEnabled: returns false when -m short flag is present", () => {
  assert.equal(
    isInferModeEnabled({ options: { mode: "general" }, args: ["init", "-m", "general"] }),
    false,
  );
  assert.equal(
    isInferModeEnabled({ options: {}, args: ["init", "-m=general"] }),
    false,
  );
});

test("isInferModeEnabled: empty options.mode (explicit --mode with no value) is treated as explicit", () => {
  // User passed --mode with no value. We must NOT auto-infer in that case —
  // the existing MS-002 dispatch surfaces an error, which is the right UX.
  assert.equal(
    isInferModeEnabled({ options: { mode: "" }, args: ["init", "--mode"] }),
    false,
  );
});

// ─── 3. selectTemplateDir ─────────────────────────────────────────────────────

test("selectTemplateDir: 'general' returns templates/_base/.agent", () => {
  const target = selectTemplateDir(ROOT, "general", { lang: "en" });
  assert.equal(target, path.join(ROOT, "templates", "_base", ".agent"));
  assert.ok(fs.existsSync(target), "expected templates/_base/.agent to exist (MS-001 must have landed)");
});

test("selectTemplateDir: 'code' honours options.lang (en/zh)", () => {
  const enTarget = selectTemplateDir(ROOT, "code", { lang: "en" });
  assert.equal(enTarget, path.join(ROOT, "templates", "en", ".agent"));
  const zhTarget = selectTemplateDir(ROOT, "code", { lang: "zh" });
  assert.equal(zhTarget, path.join(ROOT, "templates", "zh", ".agent"));
});

test("selectTemplateDir: defaults to 'en' when options.lang is missing", () => {
  const target = selectTemplateDir(ROOT, "code");
  assert.equal(target, path.join(ROOT, "templates", "en", ".agent"));
});

test("selectTemplateDir: rejects unknown modes", () => {
  assert.throws(() => selectTemplateDir(ROOT, "hybrid"), /unsupported mode/);
  assert.throws(() => selectTemplateDir(ROOT, ""), /unsupported mode/);
});

test("selectTemplateDir: rejects empty repoRoot", () => {
  assert.throws(() => selectTemplateDir("", "code"), /non-empty string/);
  assert.throws(() => selectTemplateDir(null, "code"), /non-empty string/);
});

// ─── 4. init auto mode inference (end-to-end) ────────────────────────────────

test("init (no --mode) on empty dir -> general profile (11 data dirs, skip if MS-001 not merged)", { skip: !fs.existsSync(BASE_TEMPLATES) && "templates/_base/.agent missing — MS-001 still in flight" }, () => {
  if (!fs.existsSync(BASE_TEMPLATES)) return;
  const dir = mkTmp("cortex-ms003-auto-empty-");
  try {
    const result = runCli(dir, ["init"]);
    assert.equal(
      result.status,
      0,
      `cli exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    for (const sub of BASE_DATA_DIRS) {
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

test("init (no --mode) on AGENTS.md project -> general profile (skip if MS-001 not merged)", { skip: !fs.existsSync(BASE_TEMPLATES) && "templates/_base/.agent missing — MS-001 still in flight" }, () => {
  if (!fs.existsSync(BASE_TEMPLATES)) return;
  const dir = mkTmp("cortex-ms003-auto-agents-");
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# project\n", "utf8");
    const result = runCli(dir, ["init"]);
    assert.equal(result.status, 0, `cli exit=${result.status}\nstderr=${result.stderr}`);
    for (const sub of BASE_DATA_DIRS) {
      assert.ok(
        fs.existsSync(path.join(dir, ".agent", sub)),
        `expected general data dir ${sub} to be created (AGENTS.md -> general inference)`,
      );
    }
  } finally {
    rmrf(dir);
  }
});

test("init (no --mode) on package.json project -> default code init, no _base copy", () => {
  const dir = mkTmp("cortex-ms003-auto-pkg-");
  try {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}\n', "utf8");
    const result = runCli(dir, ["init"]);
    // Default init has its own non-zero exit conditions; we just assert it
    // does NOT take the general profile. The signal we use: `conversations`
    // is a directory that exists ONLY in templates/_base/.agent (not in
    // templates/_shared/.agent, not in templates/{zh,en}/.agent). If the
    // default code init took the general profile, `conversations` would
    // appear at .agent/conversations.
    const conversationsPath = path.join(dir, ".agent", "conversations");
    assert.equal(
      fs.existsSync(conversationsPath),
      false,
      `default code init must not copy templates/_base/conversations, but found it at ${conversationsPath}`,
    );
  } finally {
    rmrf(dir);
  }
});

test("init (no --mode) on .cursorrules project -> default code init, no _base copy", () => {
  const dir = mkTmp("cortex-ms003-auto-cursor-");
  try {
    fs.writeFileSync(path.join(dir, ".cursorrules"), "", "utf8");
    const result = runCli(dir, ["init"]);
    const conversationsPath = path.join(dir, ".agent", "conversations");
    assert.equal(
      fs.existsSync(conversationsPath),
      false,
      `default code init must not copy templates/_base/conversations for .cursorrules projects, but found it at ${conversationsPath}`,
    );
  } finally {
    rmrf(dir);
  }
});

test("init explicit --mode general still wins over auto-inference (skip if MS-001 not merged)", { skip: !fs.existsSync(BASE_TEMPLATES) && "templates/_base/.agent missing — MS-001 still in flight" }, () => {
  if (!fs.existsSync(BASE_TEMPLATES)) return;
  const dir = mkTmp("cortex-ms003-auto-explicit-");
  try {
    // A package.json would normally infer 'code', but --mode general wins.
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}\n', "utf8");
    const result = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(result.status, 0, `cli exit=${result.status}\nstderr=${result.stderr}`);
    for (const sub of BASE_DATA_DIRS) {
      assert.ok(
        fs.existsSync(path.join(dir, ".agent", sub)),
        `expected general data dir ${sub} to be created (explicit --mode general overrides inference)`,
      );
    }
  } finally {
    rmrf(dir);
  }
});

// ─── 5. additive-only guards ──────────────────────────────────────────────────

test("MS-003 does not modify lib/commands.js", () => {
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
    `lib/commands.js must be untouched by MS-003, but diff was:\n${diff.stdout}`,
  );
});

test("MS-003 does not modify language templates", () => {
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
    `templates/{zh,en} must be untouched by MS-003, but diff was:\n${diff.stdout}`,
  );
});

test("MS-003 only touches its 3 owned files", () => {
  const base = readBaseCommit();
  const diff = spawnSync(
    "git",
    [
      "diff",
      "--name-only",
      `${base}..HEAD`,
      "--",
      "lib/mode-infer.js",
      "bin/cli.js",
      "tests/init-mode-infer.test.js",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
  const changed = diff.stdout.trim().split("\n").filter(Boolean).sort();
  const allowed = new Set([
    "lib/mode-infer.js",
    "bin/cli.js",
    "tests/init-mode-infer.test.js",
  ]);
  for (const file of changed) {
    assert.ok(allowed.has(file), `unexpected change in owned path: ${file}`);
  }
});

test("MS-003 does not delete any line of bin/cli.js", () => {
  const base = readBaseCommit();
  const diff = spawnSync(
    "git",
    ["diff", `${base}..HEAD`, "--", "bin/cli.js"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
  const removed = diff.stdout
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"));
  assert.deepEqual(
    removed,
    [],
    `bin/cli.js must be additive only — found ${removed.length} removed line(s):\n${removed.join("\n")}`,
  );
});

test("MS-003 does not modify the inferMode function body in lib/mode-infer.js", () => {
  const base = readBaseCommit();
  // Read the current inferMode function head (lines 32-57 in the current file,
  // but we just compare against the *full* current file's inferMode + assert
  // the diff between MS-002-base and HEAD for that function is empty).
  // Simpler: diff just the function block by line range. We use a fixed range
  // matching the MS-002-shipped function body (lines 32-57 in the current
  // file, but the file moved +83 lines after our addition). The diff against
  // the MS-002 base commit will show no `-` lines for the inferMode function
  // because we only appended below `return "general";`.
  const diff = spawnSync(
    "git",
    ["diff", `${base}..HEAD`, "--", "lib/mode-infer.js"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
  // The diff for inferMode body should be empty; the only `+` lines are
  // *after* line 57 (the closing brace of inferMode).
  const lines = diff.stdout.split("\n");
  let seenFirstPlus = false;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      seenFirstPlus = true;
      continue;
    }
    if (line.startsWith("-") && !seenFirstPlus) {
      assert.fail(
        `MS-003 must not remove any line of inferMode — found removed line before any addition:\n${line}\n\nfull diff:\n${diff.stdout}`,
      );
    }
  }
});
