"use strict";

// ---------------------------------------------------------------------------
// Portable path gate — reverse verification.
//
// cortex-agent ships to every managed project, so a path pinned to the
// author's machine is a defect. The gate is only worth having if it actually
// fires on that defect, and only useful if it stays quiet on the portable
// spellings that are the recommended alternative.
//
// So each case injects one defect and asserts the check fires, plus the
// negative cases that keep the gate from crying wolf on every legitimate
// `os.homedir()` / `__dirname` / placeholder path.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CHECK = path.join(ROOT, "scripts", "check-portable-paths.js");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

// A fixture tree with one distributed skill. `files` maps a relative path
// inside the skill directory to its content.
function buildFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-portable-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, "templates", "_shared", ".agent", "skills", "demo-skill");
  for (const [rel, content] of Object.entries(files || {})) {
    write(path.join(skillDir, rel), content);
  }
  return root;
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK, "--root", root], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

// ─── The defects the gate must catch ─────────────────────────────────────────

test("a home directory with a real user name fails", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const pkgDir = "/Users/someone/packages/cortex-agent";',
      "module.exports = pkgDir;",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-home-path/);
});

test("a version-manager install root spelled out fails", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const pkg = "/Users/someone/.volta/tools/image/packages/cortex-agent";',
      "module.exports = pkg;",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-(home-path|manager-root)/);
});

test("a linux home directory literal fails", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const base = "/home/builduser/workspace";',
      "module.exports = base;",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-home-path/);
});

test("a windows path pinned to one machine fails", (t) => {
  const root = buildFixture(t, {
    "scripts/index.ps1": [
      '$base = "C:\\Users\\builduser\\work"',
      "Write-Output $base",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-windows-path/);
});

// ─── The portable spellings the gate must not touch ──────────────────────────

test("a runtime-derived path passes", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const dir = path.join(os.homedir(), ".agent");',
      'const env = path.join(process.env.HOME, "work");',
      'const own = path.resolve(__dirname, "..", "..");',
      'const pkg = require.resolve("cortex-agent/package.json");',
      "module.exports = { dir, env, own, pkg };",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /No path is pinned to one machine/);
});

test("a placeholder path in documentation passes", (t) => {
  const root = buildFixture(t, {
    "SKILL.md": [
      "# Demo",
      "",
      "The project lives at `/Users/<you>/myproject/.agent/`.",
      "",
      "For example, run:",
      "",
      "```bash",
      "cd /Users/someuser/real-looking/path",
      "```",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a path mentioned in a comment passes", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      "// the binary was inspected at /Users/someone/.local/bin/claude",
      'const dir = path.join(os.homedir(), ".agent");',
      "module.exports = dir;",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("the rule file that names a machine path as a counter-example passes", (t) => {
  // The rule has to be able to show what a violation looks like.
  const root = buildFixture(t, {
    "SKILL.md": [
      "# Demo",
      "",
      "For example, `\"/Users/someone/.agent\"` is wrong — use `os.homedir()`.",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

// ---------------------------------------------------------------------------
// The exemptions have to be narrow.
//
// A whole-line exemption was too coarse: it let a hardcoded path through
// whenever the line also mentioned a portable spelling, a placeholder word,
// or sat inside a fenced block. And the placeholder list held words that are
// ordinary account names, so `/Users/test/work` passed as if "test" were a
// template.
// ---------------------------------------------------------------------------

test("an ordinary account name is not a placeholder", (t) => {
  for (const user of ["user", "test", "name"]) {
    const root = buildFixture(t, {
      "scripts/index.js": `const dir = "/Users/${user}/work";\n`,
    });
    const result = runCheck(root);
    assert.equal(result.status, 1, `/Users/${user}/work must be reported`);
    assert.match(result.stdout, /machine-specific-home-path/);
  }
});

test("an absolute second argument to path.resolve is reported", (t) => {
  // path.resolve(__dirname, "/abs/path") returns "/abs/path": the absolute
  // segment replaces the accumulated path, so __dirname contributes
  // nothing and the path is still pinned to one machine.
  const root = buildFixture(t, {
    "scripts/index.js": 'const dir = path.resolve(__dirname, "/Users/alice/work");\n',
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-home-path/);
});

test("a portable word on the same line does not excuse a pinned path", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": 'const dir = "/Users/alice/work"; // os.homedir()\n',
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-home-path/);
});

test("a fenced block in a document is not exempt by itself", (t) => {
  // The fenced block may hold the command the reader is told to run.
  const root = buildFixture(t, {
    "SKILL.md": [
      "# Demo",
      "",
      "Run this:",
      "",
      "```sh",
      "node /Users/alice/verify.js",
      "```",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-home-path/);
});

test("a Windows path with either separator spelling is reported", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": 'const dir = "C:\\\\Users\\\\alice\\\\work";\n',
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-windows-path/);
});

test("a relative path that mentions a home directory is not reported", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": 'const fixture = "fixtures/home/alice/data.json";\n',
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a path joined onto a portable variable is not reported", (t) => {
  // The verdict must not depend on whether os.homedir() happens to sit on
  // the same line as the path it is used to build.
  const root = buildFixture(t, {
    "scripts/index.js": [
      "const homeDir = os.homedir();",
      'const pkg = path.join(homeDir, ".volta/tools/image/packages/pkg");',
      "module.exports = pkg;",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a version-manager directory reached through a portable root is not reported", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      "const home = os.homedir();",
      'const pkg = path.join(home, ".volta/tools/image/packages/pkg");',
      "module.exports = pkg;",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a literal version-manager install root is reported", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": 'const pkg = "/Users/alice/.volta/tools/image/packages/pkg";\n',
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine-specific-manager-root/);
});

// ─── The gate against the real repository ────────────────────────────────────

test("the real repository has no machine-specific paths", () => {
  const result = runCheck(ROOT);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /No path is pinned to one machine/);
});

test("the real repository scans the runtime-evidence tree where scripts live", () => {
  // A reusable verification script belongs under .agent/runtime-evidence/.
  // If that tree stopped being scanned, a hardcoded path there would go
  // unnoticed — and that is exactly where one showed up in practice.
  const result = runCheck(ROOT);
  assert.match(result.stdout, /Files scanned: \d+/);
  const scanned = Number((result.stdout.match(/Files scanned: (\d+)/) || [])[1]);
  assert.ok(scanned > 0, "the gate must scan something");
});

// ─── Tracked symlinks ───────────────────────────────────────────────────────
//
// A symlink is a defect once it is committed: the link travels with the
// repository and lands on every other machine, where it either dangles or
// resolves to something that is not what the author meant. The unit of
// judgement is the Git index, so every fixture here is a repository whose
// symlinks are staged.

// A fixture that is a Git repository, so that the tracked-symlink scan has
// an index to read. `git add` is enough — a commit is not needed, and not
// wanted, because a commit would require a configured identity.
function buildRepoFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

// A tracked symlink: created on disk and staged in the index.
function trackedSymlink(root, relativePath, target) {
  const link = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
  const add = spawnSync("git", ["add", "--", relativePath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
  return link;
}

// The skills directory of a template layer, with a layer to point at.
const SKILLS = "templates/_shared/.agent/skills";

test("a tracked symlink with an absolute target fails", (t) => {
  const root = buildRepoFixture(t);
  trackedSymlink(root, `${SKILLS}/demo/absolute-link`, "/Users/alice/tools/cortex-agent");
  const result = runCheck(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /non-portable-symlink/);
});

test("a tracked symlink with a home-directory target fails", (t) => {
  const root = buildRepoFixture(t);
  trackedSymlink(root, `${SKILLS}/demo/home-link`, "~/tools/cortex-agent");
  const result = runCheck(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /non-portable-symlink/);
});

test("a tracked symlink with a windows absolute target fails", (t) => {
  const root = buildRepoFixture(t);
  trackedSymlink(root, `${SKILLS}/demo/windows-link`, "C:\\Users\\alice\\tools");
  const result = runCheck(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /non-portable-symlink/);
});

test("a tracked symlink that escapes the repository root fails", (t) => {
  const root = buildRepoFixture(t);
  // Six levels up from the link directory leaves the repository.
  trackedSymlink(root, `${SKILLS}/demo/escape-link`, "../../../../../../outside");
  const result = runCheck(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /non-portable-symlink/);
});

test("a tracked symlink into a template layer is reported as a layer dependency", (t) => {
  const root = buildRepoFixture(t);
  fs.mkdirSync(path.join(root, "templates", "general", ".agent", "rules"), {
    recursive: true,
  });
  // Four levels up from the link directory is the template root, and `general`
  // is one of the layers that sits under it.
  trackedSymlink(
    root,
    `${SKILLS}/demo/layer-link`,
    "../../../../general/.agent/rules",
  );
  const result = runCheck(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /template-layer-symlink/);
  assert.doesNotMatch(result.stdout, /non-portable-symlink/);
});

test("a tracked symlink inside the repository is not reported", (t) => {
  const root = buildRepoFixture(t);
  fs.mkdirSync(path.join(root, SKILLS, "real-skill"), { recursive: true });
  trackedSymlink(root, `${SKILLS}/demo/alias-link`, "../real-skill");
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a symlink that is not tracked is not reported", (t) => {
  const root = buildRepoFixture(t);
  const link = path.join(root, SKILLS, "demo", "local-link");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync("/Users/alice/tools/cortex-agent", link);
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("the governance repository root is scanned in full", (t) => {
  const root = buildRepoFixture(t);
  const governance = path.join(root, ".agent");
  fs.mkdirSync(governance, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: governance, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  // A path outside the scan trees of the framework repository: the
  // governance tree is a distribution unit in its own right.
  const link = path.join(governance, "notes", "absolute-link");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync("/Users/alice/tools/cortex-agent", link);
  const add = spawnSync("git", ["add", "--", "notes/absolute-link"], {
    cwd: governance,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
  const result = runCheck(governance);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /non-portable-symlink/);
});

test("the convenience symlinks at the repository root are not reported", (t) => {
  const root = buildRepoFixture(t);
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });
  trackedSymlink(root, "agents", "templates");
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("the report states how many tracked symlinks were checked", () => {
  const result = runCheck(ROOT);
  assert.match(result.stdout, /Symlinks checked: \d+/);
});
