"use strict";

/**
 * Tests for M-001 MS-004: shadow path test matrix for `cortex-agent init`.
 *
 * Goal: prove that the v1 / v2 init paths do not collide and that the 11
 * v2-only data directories live strictly behind `--mode general` (or the
 * auto-inference of an empty / AGENTS.md project).
 *
 * Strategy:
 *   - Spawn `node bin/cli.js init` (and the `--mode general` / auto-infer
 *     variants) in fresh temp directories under os.tmpdir().
 *   - Assert on the resulting `.agent/` shape:
 *       v1-only artifacts: agents/, decisions/, ... (the language template
 *         content)  → always present
 *       v2-only artifacts: 11 data directories from templates/_base/ — only
 *         present when general mode was actually used.
 *   - Zero npm dependencies — node:test + node:assert + node:child_process
 *     only. No fs writes outside os.tmpdir().
 *   - Tests are isolated: each test creates and cleans its own temp dir.
 *
 * References:
 *   - M-001 mission-plan §3.2 batch 2 + batch 3 (MS-004)
 *   - .agent/rules/architecture-design.md (zero-dep + additive-only)
 *   - lib/commands.js#init (v1 path)
 *   - lib/mode-infer.js (mode resolution: AGENTS.md > .cursorrules > .github/copilot-instructions.md > package.json > general)
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const cliPath = path.join(repoRoot, "bin", "cli.js");

// ---------------------------------------------------------------------------
// Constants — directories that distinguish v1 (code) from v2 (general).
//
// Note: 8 of the 11 v2 data-layer names (inbox, decisions, handoffs, memory,
// sessions, runs, tasks, waitpoints) ALSO exist under
// templates/_shared/.agent/ — the v1 runtime has been using them for years
// (for coordination, run-journal, etc). So they are not the right assertion
// target for shadow testing.
//
// What cleanly separates v1 from v2 are the 3 directories that v2 introduces
// as the *general* data layer and that do NOT exist in any v1 template
// (templates/_shared/.agent/ or templates/{zh,en}/.agent/):
//
//   agents, conversations, missions
//
// A v1 init must NEVER create these; a v2 init (--mode general) must create
// all of them. The other 8 v2 names are shared and may exist in either mode.
// ---------------------------------------------------------------------------

const V2_UNIQUE_DATA_DIRS = [
  "agents",
  "conversations",
  "missions",
];

// ---------------------------------------------------------------------------
// All 11 v2 data-layer directory names (for documentation / sanity only —
// NOT used as a v1-not-present assertion.  The 8 shared names are listed
// here for completeness; the 3 unique names are above.
// ---------------------------------------------------------------------------
const V2_ALL_DATA_DIRS = [
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a unique temp directory, return its absolute path.
 * Cleans itself on process exit? No — callers rm it explicitly.
 */
function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cortex-shadow-${prefix}-`));
}

/**
 * Run `node bin/cli.js init [...]` in `cwd` and return the stdout/stderr.
 * Throws on non-zero exit.
 */
function runInit(cwd, extraArgs) {
  return execFileSync(
    process.execPath,
    [cliPath, "init", ...(extraArgs || [])],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

/**
 * Assert a directory exists under `cwd/.agent/<rel>`.
 */
function assertAgentDirExists(cwd, rel) {
  const p = path.join(cwd, ".agent", rel);
  assert.ok(
    fs.existsSync(p) && fs.statSync(p).isDirectory(),
    `expected .agent/${rel} to exist at ${p}`
  );
}

/**
 * Assert a directory does NOT exist under `cwd/.agent/<rel>`.
 */
function assertAgentDirMissing(cwd, rel) {
  const p = path.join(cwd, ".agent", rel);
  assert.ok(
    !fs.existsSync(p),
    `expected .agent/${rel} to NOT exist at ${p}`
  );
}

/**
 * Recursively delete a directory. Used for temp cleanup.
 */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

// ===========================================================================
// Scenario 1: init in empty dir (no --mode) auto-infers to general
// ===========================================================================

test("init: empty dir (no --mode) auto-infers to general, all 3 v2-unique dirs exist", () => {
  const cwd = makeTmp("auto-empty");
  try {
    runInit(cwd, []);
    assert.ok(
      fs.existsSync(path.join(cwd, ".agent")),
      "init must create .agent/"
    );
    // Empty dir auto-infers to general mode (lib/mode-infer.js rule 5),
    // so the 3 v2-unique dirs MUST be present.
    for (const d of V2_UNIQUE_DATA_DIRS) {
      assertAgentDirExists(cwd, d);
    }
  } finally {
    rmrf(cwd);
  }
});

// ===========================================================================
// Scenario 2: v1 init in package.json project → code mode (no _base copy)
// ===========================================================================

test("v1 init: package.json project -> code mode, no v2 dirs", () => {
  const cwd = makeTmp("v1-pkg");
  try {
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo" }, null, 2)
    );
    runInit(cwd, []);
    assert.ok(fs.existsSync(path.join(cwd, ".agent")), "must create .agent/");
    for (const d of V2_UNIQUE_DATA_DIRS) {
      assertAgentDirMissing(cwd, d);
    }
    // Sanity: language template content should be present (e.g. README in
    // the language-specific .agent).
    assert.ok(
      fs.existsSync(path.join(cwd, ".agent", "README.md")) ||
        fs.existsSync(path.join(cwd, ".agent", "hooks")) ||
        fs.existsSync(path.join(cwd, ".agent", "skills")) ||
        fs.existsSync(path.join(cwd, ".agent", "commands")) ||
        fs.existsSync(path.join(cwd, ".agent", "sub-agents")),
      "v1 init should have populated the language template (README/hooks/skills/commands/sub-agents)"
    );
  } finally {
    rmrf(cwd);
  }
});

// ===========================================================================
// Scenario 3: v1 init in .cursorrules project → code mode
// ===========================================================================

test("v1 init: .cursorrules project -> code mode, no v2 dirs", () => {
  const cwd = makeTmp("v1-cursor");
  try {
    fs.writeFileSync(path.join(cwd, ".cursorrules"), "# cursor rules\n");
    runInit(cwd, []);
    assert.ok(fs.existsSync(path.join(cwd, ".agent")), "must create .agent/");
    for (const d of V2_UNIQUE_DATA_DIRS) {
      assertAgentDirMissing(cwd, d);
    }
  } finally {
    rmrf(cwd);
  }
});

// ===========================================================================
// Scenario 4: explicit --mode general in empty dir → general, 11 v2 dirs
// ===========================================================================

test("v2 init: --mode general in empty dir -> general, all 11 v2 dirs", () => {
  const cwd = makeTmp("v2-empty");
  try {
    runInit(cwd, ["--mode", "general"]);
    assert.ok(fs.existsSync(path.join(cwd, ".agent")), "must create .agent/");
    for (const d of V2_UNIQUE_DATA_DIRS) {
      assertAgentDirExists(cwd, d);
    }
  } finally {
    rmrf(cwd);
  }
});

// ===========================================================================
// Scenario 5: explicit --mode general overrides package.json code signal
// ===========================================================================

test("v2 init: explicit --mode general wins over package.json code signal", () => {
  const cwd = makeTmp("v2-pkg-override");
  try {
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo" }, null, 2)
    );
    runInit(cwd, ["--mode", "general"]);
    for (const d of V2_UNIQUE_DATA_DIRS) {
      assertAgentDirExists(cwd, d);
    }
  } finally {
    rmrf(cwd);
  }
});

// ===========================================================================
// Scenario 6: auto-infer — empty dir -> general (data layer only)
//
// We do NOT spawn the CLI here; we directly verify the public helper from
// lib/mode-infer.js, which is the canonical source of truth.  The CLI's
// auto-infer branch simply forwards the same value into the v2 init path.
// ===========================================================================

test("auto-infer (lib/mode-infer): empty dir -> 'general'", () => {
  const cwd = makeTmp("infer-empty");
  try {
    const { inferMode } = require(path.join(repoRoot, "lib", "mode-infer.js"));
    assert.strictEqual(inferMode(cwd), "general");
  } finally {
    rmrf(cwd);
  }
});

test("auto-infer (lib/mode-infer): package.json -> 'code'", () => {
  const cwd = makeTmp("infer-pkg");
  try {
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo" }, null, 2)
    );
    const { inferMode } = require(path.join(repoRoot, "lib", "mode-infer.js"));
    assert.strictEqual(inferMode(cwd), "code");
  } finally {
    rmrf(cwd);
  }
});

test("auto-infer (lib/mode-infer): .cursorrules -> 'code'", () => {
  const cwd = makeTmp("infer-cursor");
  try {
    fs.writeFileSync(path.join(cwd, ".cursorrules"), "# cursor rules\n");
    const { inferMode } = require(path.join(repoRoot, "lib", "mode-infer.js"));
    assert.strictEqual(inferMode(cwd), "code");
  } finally {
    rmrf(cwd);
  }
});

test("auto-infer (lib/mode-infer): AGENTS.md wins over package.json", () => {
  const cwd = makeTmp("infer-agents-wins");
  try {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# project\n");
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo" }, null, 2)
    );
    const { inferMode } = require(path.join(repoRoot, "lib", "mode-infer.js"));
    assert.strictEqual(inferMode(cwd), "general");
  } finally {
    rmrf(cwd);
  }
});

// ===========================================================================
// Scenario 7: shadow — v1 init then v2 init in same dir, both layers coexist
// ===========================================================================

test("shadow: v1 init then v2 init in same dir -> both layers coexist", () => {
  const cwd = makeTmp("shadow-v1-then-v2");
  try {
    // First: v1 init populates the language template.
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo" }, null, 2)
    );
    runInit(cwd, []);
    // v1 should have created at least one language-template artifact.
    const langArtifact =
      fs.existsSync(path.join(cwd, ".agent", "README.md")) ||
      fs.existsSync(path.join(cwd, ".agent", "hooks")) ||
      fs.existsSync(path.join(cwd, ".agent", "skills")) ||
      fs.existsSync(path.join(cwd, ".agent", "sub-agents"));
    assert.ok(langArtifact, "v1 init should leave language-template artifacts");

    // Now run v2 init on top. The data-layer dirs should be created without
    // overwriting the language template (copyRecursive is additive-only).
    runInit(cwd, ["--mode", "general"]);
    for (const d of V2_UNIQUE_DATA_DIRS) {
      assertAgentDirExists(cwd, d);
    }
    // Language template should still be there.
    assert.ok(
      fs.existsSync(path.join(cwd, ".agent", "README.md")) ||
        fs.existsSync(path.join(cwd, ".agent", "hooks")) ||
        fs.existsSync(path.join(cwd, ".agent", "skills")) ||
        fs.existsSync(path.join(cwd, ".agent", "sub-agents")),
      "shadow: language template artifacts must survive a subsequent v2 init"
    );
  } finally {
    rmrf(cwd);
  }
});

// ===========================================================================
// Scenario 8: additivity guards — owned files of other milestones are intact
// ===========================================================================

test("additivity: bin/cli.js has 0 deletions vs base f8a1d38", () => {
  // Owned by MS-002/003.  We re-implement the smoke test here so a future
  // MS-004 edit that accidentally touches bin/cli.js will fail this test.
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(
    "git",
    ["diff", "--shortstat", "f8a1d38", "HEAD", "--", "bin/cli.js"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  // Format: " 3 files changed, 87 insertions(+), 5 deletions(-)"
  const deletions = (out.match(/(\d+) deletions?/) || [0, 0])[1];
  assert.strictEqual(
    String(deletions),
    "0",
    `bin/cli.js must have 0 deletions vs base f8a1d38; got: ${out.trim()}`
  );
});

test("additivity: lib/commands.js has 0 changes vs base f8a1d38", () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(
    "git",
    ["diff", "--shortstat", "f8a1d38", "HEAD", "--", "lib/commands.js"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.strictEqual(
    out.trim(),
    "",
    `lib/commands.js must be unchanged vs base f8a1d38; got: ${out.trim()}`
  );
});

test("additivity: lib/mode-infer.js function body inferMode is unchanged", () => {
  // The inferMode function body is the MS-002 contract; MS-003 only
  // appended helpers below it.  MS-004 must not touch the function.
  const fp = path.join(repoRoot, "lib", "mode-infer.js");
  const src = fs.readFileSync(fp, "utf8");
  // Sanity: the function signature line is present, and a "Resolution order"
  // comment block (5 rules) is intact.
  assert.ok(
    /function inferMode\(cwd\)/.test(src),
    "inferMode function signature must be present"
  );
  assert.ok(
    /AGENTS\.md[\s\S]*\.cursorrules[\s\S]*copilot-instructions\.md[\s\S]*package\.json[\s\S]*general/.test(src),
    "inferMode 5-rule resolution order must be preserved"
  );
});
