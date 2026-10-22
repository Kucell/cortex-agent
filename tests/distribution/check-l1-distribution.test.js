"use strict";

// ---------------------------------------------------------------------------
// L1 distribution integrity gate — reverse verification.
//
// The gate is only worth having if it actually fails when the distribution
// surface breaks. A check that silently passes is worse than no check: it
// looks like coverage while proving nothing.
//
// This file builds a minimal fixture tree (L1 + L3) and injects one defect at
// a time, asserting that the corresponding check fires:
//
//   1. manifest 缺失    — the skill has no SKILL.md
//   2. 实现缺失          — the skill is shipped but a file it needs is not
//   3. 死链              — the manifest links to a path L1 does not ship
//
// Plus the positive case: a complete tree must pass.
//
// The fixture is deliberately NOT a git repository. The gate enumerates the
// distributed set from each side's own git index when one exists and falls
// back to the filesystem otherwise; exercising the fallback keeps the gate
// usable outside a checkout.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CHECK = path.join(ROOT, "scripts", "check-l1-distribution.js");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function manifest(name, body) {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} fixture skill`,
    "---",
    "",
    `# ${name}`,
    "",
    body || "",
    "",
  ].join("\n");
}

// Builds a fixture with one L3 skill and its L1 counterpart.
// `l1Files` / `l3Files` are relative paths inside the skill directory.
function buildFixture(t, options) {
  const opts = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-l1-dist-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const l1Dir = path.join(root, "templates", "_shared", ".agent", "skills", "demo-skill");
  const l3Dir = path.join(root, ".agent", "skills", "demo-skill");

  const l3Files = opts.l3Files || ["scripts/index.js"];
  for (const rel of l3Files) {
    write(path.join(l3Dir, rel), opts.l3Content || "// l3 implementation\n");
  }
  write(path.join(l3Dir, "SKILL.md"), manifest("demo-skill", opts.l3Body || "l3 body"));

  const l1Files = opts.l1Files || l3Files.concat(["SKILL.md"]);
  for (const rel of l1Files) {
    if (opts.omitL1Manifest && rel === "SKILL.md") continue;
    write(path.join(l1Dir, rel), opts.l1Content || "// l1 implementation\n");
  }
  if (!opts.omitL1Manifest) {
    write(path.join(l1Dir, "SKILL.md"), opts.l1Body || manifest("demo-skill", opts.body || "l1 body"));
  }

  return { root, l1Dir, l3Dir };
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK, "--root", root], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

test("a complete distribution tree passes", (t) => {
  const fixture = buildFixture(t);
  const result = runCheck(fixture.root);
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /L1 分发完整性检查通过/);
});

test("a skill without SKILL.md is reported as a missing manifest", (t) => {
  const fixture = buildFixture(t, { omitL1Manifest: true });
  const result = runCheck(fixture.root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /缺少 SKILL\.md/);
  assert.match(result.stdout, /demo-skill/);
});

test("a skill missing an implementation file is reported as unusable", (t) => {
  const fixture = buildFixture(t, { l1Files: ["SKILL.md"] });
  const result = runCheck(fixture.root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /缺少实现文件/);
  assert.match(result.stdout, /scripts\/index\.js/);
});

test("a manifest linking to an undistributed path is reported as a dead link", (t) => {
  const fixture = buildFixture(t, {
    l1Body: manifest("demo-skill", "见 [模板](../../../docs/reliability/verification-templates.md)"),
  });
  const result = runCheck(fixture.root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /死链/);
  assert.match(result.stdout, /verification-templates\.md/);
});

test("a manifest without frontmatter is reported as invalid", (t) => {
  const fixture = buildFixture(t, { l1Body: "# demo-skill\n\nno frontmatter here\n" });
  const result = runCheck(fixture.root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /frontmatter/);
});

test("L3-only files excluded from the distribution surface are not required in L1", (t) => {
  // `.bak` leftovers, test files, and the repeated-directory path accidents
  // live in L3 only. The gate must not force L1 to replicate them.
  const fixture = buildFixture(t, {
    l3Files: [
      "scripts/index.js",
      "scripts/index.js.bak",
      "scripts/index.js.bak.prev",
      "scripts/thing.test.js",
      "demo-skill/scripts/accident.js",
    ],
  });
  const result = runCheck(fixture.root);
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
});

test("a skill that exists only in L3 carries no distribution duty", (t) => {
  const fixture = buildFixture(t);
  write(path.join(fixture.root, ".agent", "skills", "l3-only", "SKILL.md"), manifest("l3-only"));
  write(path.join(fixture.root, ".agent", "skills", "l3-only", "scripts", "index.js"), "// l3 only\n");
  const result = runCheck(fixture.root);
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /L3-only skills: 1/);
});

test("the real repository distribution surface passes the gate", () => {
  const result = spawnSync(process.execPath, [CHECK], { encoding: "utf8", cwd: ROOT });
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
});
