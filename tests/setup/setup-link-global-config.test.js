"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const setup = require("../../lib/setup/index.js");

// ---------------------------------------------------------------------------
// Test fixture
//
// `linkGlobalConfig()` reads `os.homedir()` (which falls back to process.env.HOME
// on macOS / Linux) and uses that as the canonical global-config root. We stage
// a fake HOME that contains a populated .agent/ (with rules/ + workflows/
// sub-directories so the function's downstream cursor/claude symlink calls
// also have valid targets) and project .agent/ that is initially empty.
//
// `t.after` restores HOME and tears down the temp tree regardless of pass/fail.
// ---------------------------------------------------------------------------
function withHomeAndProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-link-global-"));
  const fakeHome = path.join(root, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const realHomeAgent = path.join(fakeHome, ".agent");
  fs.mkdirSync(path.join(realHomeAgent, "rules"), { recursive: true });
  fs.mkdirSync(path.join(realHomeAgent, "workflows"), { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".agent"), { recursive: true });
  // Canonicalize both to absorb macOS /tmp → /private/tmp symlink aliasing
  // (linkGlobalConfig calls realpathSync() on both, so the test must compare
  // canonical paths, not the raw tmp paths returned by mkdtempSync).
  return {
    root,
    fakeHome,
    realHomeAgentRaw: realHomeAgent,
    realHomeAgent: fs.realpathSync(realHomeAgent),
    project,
    realProjectAgent: fs.realpathSync(path.join(project, ".agent")),
  };
}

// ---------------------------------------------------------------------------
// 1. Skips when ~/.agent does not exist
// ---------------------------------------------------------------------------
test("linkGlobalConfig: no-op when ~/.agent is missing", (t) => {
  const { project, fakeHome } = withHomeAndProject(t);
  // Remove the fake home .agent to simulate the no-home-agent case.
  fs.rmSync(path.join(fakeHome, ".agent"), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(fakeHome, ".agent")), false);

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  const linkPath = path.join(project, ".agent", "global");
  assert.equal(
    fs.existsSync(linkPath),
    false,
    ".agent/global must NOT be created when ~/.agent is missing"
  );
});

// ---------------------------------------------------------------------------
// 2. Fresh creation: link does not exist → create a *relative* symlink
// ---------------------------------------------------------------------------
test("linkGlobalConfig: creates a relative symlink when none exists", (t) => {
  const { project, realHomeAgent } = withHomeAndProject(t);
  const linkPath = path.join(project, ".agent", "global");
  assert.equal(fs.existsSync(linkPath), false, "precondition: no existing link");

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  assert.equal(fs.existsSync(linkPath), true, ".agent/global should be created");
  // Target must be relative (not absolute) — M-SETUP-PORT-001 core requirement.
  const target = fs.readlinkSync(linkPath);
  assert.ok(
    !path.isAbsolute(target),
    `symlink target must be relative, got absolute: ${target}`
  );
  // And it must resolve to the real home agent.
  const resolved = fs.realpathSync(linkPath);
  assert.equal(resolved, realHomeAgent, "symlink must resolve to current ~/.agent");
});

// ---------------------------------------------------------------------------
// 3. Existing link with correct target → no rebuild (preserves marker file)
// ---------------------------------------------------------------------------
test("linkGlobalConfig: no-op when existing symlink already points to current ~/.agent", (t) => {
  const { project, realHomeAgent, realProjectAgent } = withHomeAndProject(t);
  const linkPath = path.join(project, ".agent", "global");
  // Pre-create the *correct* relative link. Use canonical paths so the
  // relative target matches what linkGlobalConfig() will compare against.
  const expectedRel = path.relative(realProjectAgent, realHomeAgent);
  fs.symlinkSync(expectedRel, linkPath);
  // Drop a sentinel file *through* the symlink so we can prove we did not
  // delete and re-create the link (which would wipe the sentinel).
  const sentinel = path.join(linkPath, "sentinel.txt");
  fs.writeFileSync(sentinel, "must-survive", "utf8");
  const beforeStat = fs.lstatSync(linkPath);

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  // The link node should be the same inode (no unlink+symlink dance).
  const afterStat = fs.lstatSync(linkPath);
  assert.equal(afterStat.ino, beforeStat.ino, "must not re-create a correct link");
  assert.equal(
    fs.readFileSync(sentinel, "utf8"),
    "must-survive",
    "sentinel file under symlink must survive the no-op call"
  );
  // Target is unchanged.
  assert.equal(fs.readlinkSync(linkPath), expectedRel);
  // And still resolves to the real home agent.
  assert.equal(fs.realpathSync(linkPath), realHomeAgent);
});

// ---------------------------------------------------------------------------
// 4. Existing link with wrong target → rebuild
// ---------------------------------------------------------------------------
test("linkGlobalConfig: rebuilds when existing symlink points to wrong target", (t) => {
  const { project, realHomeAgent } = withHomeAndProject(t);
  const linkPath = path.join(project, ".agent", "global");

  // Point the link at a totally different, real directory.
  const wrongTarget = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-wrong-"));
  t.after(() => fs.rmSync(wrongTarget, { recursive: true, force: true }));
  const wrongTargetCanonical = fs.realpathSync(wrongTarget);
  fs.symlinkSync(wrongTarget, linkPath);
  assert.equal(fs.realpathSync(linkPath), wrongTargetCanonical, "precondition: link → wrong");

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  // The link must now resolve to the current real home agent, not the wrong target.
  const resolved = fs.realpathSync(linkPath);
  assert.equal(
    resolved,
    realHomeAgent,
    "wrong-target symlink should be rebuilt to current ~/.agent"
  );
  // And the new target should be a *relative* path (the M-SETUP-PORT-001 contract).
  const newTarget = fs.readlinkSync(linkPath);
  assert.ok(
    !path.isAbsolute(newTarget),
    `rebuilt target must be relative, got absolute: ${newTarget}`
  );
});

// ---------------------------------------------------------------------------
// 5. Existing link is broken (target removed) → rebuild
// ---------------------------------------------------------------------------
test("linkGlobalConfig: rebuilds a broken symlink (target deleted)", (t) => {
  const { project, realHomeAgent } = withHomeAndProject(t);
  const linkPath = path.join(project, ".agent", "global");

  // Create a symlink whose target never existed on this machine.
  const ghost = path.join(
    os.tmpdir(),
    `cortex-ghost-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.symlinkSync(ghost, linkPath);
  // Precondition: the symlink exists as a node but cannot be resolved.
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.throws(() => fs.realpathSync(linkPath), /ENOENT/);

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  // After the call, the symlink must resolve to the real home agent.
  const resolved = fs.realpathSync(linkPath);
  assert.equal(
    resolved,
    realHomeAgent,
    "broken symlink should be rebuilt to current ~/.agent"
  );
});

// ---------------------------------------------------------------------------
// 6. After creation, realpath must succeed immediately (the verify step)
// ---------------------------------------------------------------------------
test("linkGlobalConfig: post-condition — created symlink resolves immediately", (t) => {
  const { project, realHomeAgent } = withHomeAndProject(t);
  const linkPath = path.join(project, ".agent", "global");

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  // The function calls realpathSync() internally as a verify step. This
  // test re-runs it from the outside to assert the post-condition holds for
  // any subsequent caller too.
  let resolved;
  try {
    resolved = fs.realpathSync(linkPath);
  } catch (err) {
    assert.fail(`realpathSync(link) failed after linkGlobalConfig: ${err.message}`);
  }
  assert.equal(resolved, realHomeAgent);

  // Sanity: the symlink target, when read raw, is still a relative path.
  const raw = fs.readlinkSync(linkPath);
  assert.ok(!path.isAbsolute(raw), `target must remain relative, got ${raw}`);
});

// ---------------------------------------------------------------------------
// T-ISSUE-3 follow-up: linkGlobalConfig now also creates 4 additional
// relative-path symlinks under .cursor/ and .claude/ AND auto-appends the
// entries to .gitignore (or .git/info/exclude when useLocalExclude is true).
// ---------------------------------------------------------------------------

// 7. .cursor/global-rules, .cursor/global-commands, .claude/global-commands
//    are created with *relative* targets.
test("linkGlobalConfig: creates cursor + claude global links as relative symlinks", (t) => {
  const { project, realHomeAgent } = withHomeAndProject(t);

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  const expected = [
    { rel: ".cursor/global-rules", targetName: "rules" },
    { rel: ".cursor/global-commands", targetName: "workflows" },
    { rel: ".claude/global-commands", targetName: "workflows" },
  ];
  for (const { rel, targetName } of expected) {
    const linkPath = path.join(project, rel);
    assert.ok(fs.existsSync(linkPath), `${rel} must exist after linkGlobalConfig`);
    const raw = fs.readlinkSync(linkPath);
    assert.ok(
      !path.isAbsolute(raw),
      `${rel} must use a relative target (got ${raw})`
    );
    const resolved = fs.realpathSync(linkPath);
    assert.equal(
      resolved,
      path.join(realHomeAgent, targetName),
      `${rel} must resolve to ~/.agent/${targetName}`
    );
  }
});

// 8. Auto-appends created symlink entries to .gitignore.
test("linkGlobalConfig: appends created symlinks to .gitignore by default", (t) => {
  const { project, root } = withHomeAndProject(t);

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  const gitignorePath = path.join(project, ".gitignore");
  assert.ok(
    fs.existsSync(gitignorePath),
    ".gitignore must be created when symlinks are written"
  );
  const content = fs.readFileSync(gitignorePath, "utf8");
  assert.match(content, /\.agent\/global/);
  assert.match(content, /\.cursor\/global-rules/);
  assert.match(content, /\.cursor\/global-commands/);
  assert.match(content, /\.claude\/global-commands/);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// 9. Idempotent: re-running linkGlobalConfig does not duplicate entries.
test("linkGlobalConfig: re-running is idempotent on .gitignore", (t) => {
  const { project, root } = withHomeAndProject(t);

  setup.linkGlobalConfig({ cwd: project, lang: "en" });
  const beforeContent = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
  const beforeCount = (beforeContent.match(/\.agent\/global\b/g) || []).length;

  setup.linkGlobalConfig({ cwd: project, lang: "en" });
  const afterContent = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
  const afterCount = (afterContent.match(/\.agent\/global\b/g) || []).length;

  assert.equal(
    afterCount,
    beforeCount,
    ".agent/global must appear exactly the same number of times after re-run"
  );

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// 10. useLocalExclude: writes to .git/info/exclude instead of .gitignore.
test("linkGlobalConfig: useLocalExclude routes entries to .git/info/exclude", (t) => {
  const { project, root } = withHomeAndProject(t);
  // We need an existing .git/ for .git/info/exclude to make sense.
  fs.mkdirSync(path.join(project, ".git", "info"), { recursive: true });

  setup.linkGlobalConfig({ cwd: project, lang: "en", useLocalExclude: true });

  const excludePath = path.join(project, ".git", "info", "exclude");
  const excludeContent = fs.readFileSync(excludePath, "utf8");
  assert.match(excludeContent, /\.agent\/global/);
  assert.match(excludeContent, /\.cursor\/global-rules/);

  // .gitignore must NOT have been auto-written when useLocalExclude is set.
  const gitignorePath = path.join(project, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    assert.ok(
      !/\.agent\/global\b/.test(gitignoreContent),
      ".gitignore must not receive entries when useLocalExclude is true"
    );
  }

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// 11. updateGitignore:false skips the .gitignore update entirely.
test("linkGlobalConfig: updateGitignore=false skips .gitignore entirely", (t) => {
  const { project, root } = withHomeAndProject(t);

  setup.linkGlobalConfig({
    cwd: project,
    lang: "en",
    updateGitignore: false,
  });

  const gitignorePath = path.join(project, ".gitignore");
  assert.equal(
    fs.existsSync(gitignorePath),
    false,
    ".gitignore must not be created when updateGitignore is false"
  );

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// 12. Target outside os.homedir() → skip + warning (no symlink created).
test("linkGlobalConfig: skips when ~/.agent is missing (no-op)", (t) => {
  const { project, fakeHome } = withHomeAndProject(t);
  fs.rmSync(path.join(fakeHome, ".agent"), { recursive: true, force: true });

  setup.linkGlobalConfig({ cwd: project, lang: "en" });

  for (const rel of [
    ".agent/global",
    ".agent/global-shared-skills",
    ".cursor/global-rules",
    ".cursor/global-commands",
    ".claude/global-commands",
  ]) {
    assert.equal(
      fs.existsSync(path.join(project, rel)),
      false,
      `${rel} must not be created when ~/.agent is missing`
    );
  }
});
