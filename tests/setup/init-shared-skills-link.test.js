"use strict";

// Tests that fresh `cortex-agent init` and subsequent `cortex-agent update`
// promote `.agent/global-shared-skills/` to a symlink pointing at the
// Agent Skills standard namespace (`~/.agents/skills/`) instead of copying
// the framework vendor content as a regular directory. This unblocks the
// standard upgrade flow: vendor-skill updates from `~/.agents/skills/`
// flow through the symlink instead of being frozen as a local copy.
//
// Pre-fix behaviour: init did not call linkGlobalConfig (general mode) and
// update's walkWithSink filled in `_shared/.agent/global-shared-skills/` as
// regular files, so `linkGlobalConfig`'s later `existing_non_symlink` skip
// kept the entity directory in place and reports came back as "partial".

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

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

// Fresh init in general mode must leave `.agent/global-shared-skills` as a
// symlink to the user's `~/.agents/skills/` when that directory exists.
// Skipped if HOME has no `~/.agents/skills/` (it isn't a standard location
// in CI sandboxes) — the rest of the suite still proves the negative path.
const REAL_AGENTS_SKILLS = path.join(os.homedir(), ".agents", "skills");
const HAS_AGENTS_SKILLS = fs.existsSync(REAL_AGENTS_SKILLS);

test(
  "init --mode general creates .agent/global-shared-skills symlink when ~/.agents/skills exists",
  { skip: !HAS_AGENTS_SKILLS && "~/.agents/skills not present in this environment" },
  () => {
    if (!HAS_AGENTS_SKILLS) return;
    const dir = mkTmp("cortex-gss-init-");
    try {
      const init = runCli(dir, ["init", "--mode", "general"]);
      assert.equal(init.status, 0, `init exit=${init.status}\nstderr=${init.stderr}\nstdout=${init.stdout}`);
      const linkPath = path.join(dir, ".agent", "global-shared-skills");
      assert.ok(
        fs.lstatSync(linkPath).isSymbolicLink(),
        `.agent/global-shared-skills must be a symlink after init, got: ${fs.lstatSync(linkPath)}`,
      );
      const realTarget = fs.realpathSync(linkPath);
      const expected = fs.realpathSync(REAL_AGENTS_SKILLS);
      assert.equal(realTarget, expected, "symlink target must resolve to ~/.agents/skills");
    } finally {
      rmrf(dir);
    }
  },
);

test(
  "update preserves the .agent/global-shared-skills symlink after init",
  { skip: !HAS_AGENTS_SKILLS && "~/.agents/skills not present in this environment" },
  () => {
    if (!HAS_AGENTS_SKILLS) return;
    const dir = mkTmp("cortex-gss-update-");
    try {
      const init = runCli(dir, ["init", "--mode", "general"]);
      assert.equal(init.status, 0, `init exit=${init.status}\nstderr=${init.stderr}`);
      const linkPath = path.join(dir, ".agent", "global-shared-skills");
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), "precondition: symlink must exist after init");

      const update = runCli(dir, ["update"]);
      // update may exit non-zero on a "partial" status (5 protected scripts
      // in this layout — unrelated to global-shared-skills). The relevant
      // invariant is that the symlink survives.
      assert.ok(
        fs.lstatSync(linkPath).isSymbolicLink(),
        "update must keep .agent/global-shared-skills as a symlink",
      );
      const realTarget = fs.realpathSync(linkPath);
      const expected = fs.realpathSync(REAL_AGENTS_SKILLS);
      assert.equal(realTarget, expected, "symlink must still resolve to ~/.agents/skills after update");

      // update's plan must NOT include global-shared-skills as a regular-file
      // add — that would be the old frozen-copy behaviour we are fixing.
      const reportPath = path.join(dir, ".agent", "updates", "latest.json");
      if (fs.existsSync(reportPath)) {
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        const planPaths = (report.plan || []).map((p) => p.path).filter(Boolean);
        assert.ok(
          !planPaths.some((p) => p === ".agent/global-shared-skills" || p.startsWith(".agent/global-shared-skills/")),
          `update plan must not include .agent/global-shared-skills/ files, got: ${planPaths.filter((p) => p.includes("global-shared-skills")).join(", ")}`,
        );
        const changePaths = [
          ...((report.changes && report.changes.added) || []),
          ...((report.changes && report.changes.updated) || []),
        ].map((p) => (typeof p === "string" ? p : p && p.path)).filter(Boolean);
        assert.ok(
          !changePaths.some((p) => p === ".agent/global-shared-skills" || p.startsWith(".agent/global-shared-skills/")),
          `update changes must not write .agent/global-shared-skills/ files, got: ${changePaths.filter((p) => p.includes("global-shared-skills")).join(", ")}`,
        );
      }
    } finally {
      rmrf(dir);
    }
  },
);

test("init --mode general: when ~/.agents/skills is missing, no entity directory is left behind", () => {
  // Use a HOME without `.agents/skills/` to prove the negative path: init
  // must not synthesise a regular .agent/global-shared-skills/ directory
  // when the symlink target is unavailable. We point HOME at a fresh tmp
  // directory so the real ~/.agents/skills (if any) is shadowed for this
  // subprocess only.
  const dir = mkTmp("cortex-gss-noagents-");
  const fakeHome = mkTmp("cortex-gss-fakehome-");
  try {
    const init = runCli(dir, ["init", "--mode", "general"], { HOME: fakeHome });
    assert.equal(init.status, 0, `init exit=${init.status}\nstderr=${init.stderr}`);
    const linkPath = path.join(dir, ".agent", "global-shared-skills");
    assert.equal(
      fs.existsSync(linkPath),
      false,
      ".agent/global-shared-skills must not exist when ~/.agents/skills is missing",
    );
  } finally {
    rmrf(dir);
    rmrf(fakeHome);
  }
});

test("legacy project with existing .agent/global-shared-skills/ entity dir keeps its content under init", () => {
  // Backwards-compat: projects upgraded from older cortex-agent releases may
  // already have a regular `.agent/global-shared-skills/` directory with
  // user-local vendor skills. init must not clobber it; linkGlobalConfig's
  // `existing_non_symlink` skip preserves the directory and prints the
  // documented "preserving local content" warning.
  const dir = mkTmp("cortex-gss-legacy-");
  try {
    fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
    const existingDir = path.join(dir, ".agent", "global-shared-skills");
    fs.mkdirSync(existingDir, { recursive: true });
    const sentinel = path.join(existingDir, "local-skill.md");
    fs.writeFileSync(sentinel, "keep this\n", "utf8");

    const init = runCli(dir, ["init", "--mode", "general"]);
    assert.equal(init.status, 0, `init exit=${init.status}\nstderr=${init.stderr}`);
    assert.equal(
      fs.lstatSync(existingDir).isSymbolicLink(),
      false,
      "legacy entity directory must NOT be promoted to a symlink",
    );
    assert.equal(
      fs.readFileSync(sentinel, "utf8"),
      "keep this\n",
      "legacy entity directory content must be preserved",
    );
    assert.match(
      init.stdout + init.stderr,
      /preserving local content/,
      "init must surface the 'preserving local content' warning for legacy projects",
    );
  } finally {
    rmrf(dir);
  }
});
