"use strict";

// ─── Template copy hygiene ────────────────────────────────────────────────────
//
// A distributable template tree must not carry OS junk or symlinks.
//
// `.DS_Store` is macOS litter: it appears in any folder a developer visits in
// Finder, and a source checkout carries it into every project it installs.
//
// Symlinks do not survive packaging — `npm pack` drops them — so a template
// that ships one behaves differently depending on how it was installed. A
// symlink pointing outside the tree (a developer's own `~/.agent/skills`) is
// machine-specific: copying it puts that machine's content into the project.
//
// The two installs must therefore produce the same project: "installed from
// npm" and "copied from a checkout" must not differ by a junk file or by a
// directory that only exists on the developer's machine.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const { copyRecursive } = require(path.join(ROOT, "lib", "setup", "index.js"));

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-copy-hygiene-"));
  fs.mkdirSync(path.join(root, "skill", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "skill", "SKILL.md"), "# skill\n", "utf8");
  fs.writeFileSync(path.join(root, "skill", "scripts", "index.js"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(path.join(root, "skill", ".DS_Store"), "junk\n", "utf8");
  fs.writeFileSync(path.join(root, ".DS_Store"), "junk\n", "utf8");
  fs.writeFileSync(path.join(root, "skill", "scripts", ".DS_Store"), "junk\n", "utf8");
  // A machine-specific link: it resolves to a path that exists only on the
  // machine that created it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-outside-"));
  fs.writeFileSync(path.join(outside, "secret-local-file.txt"), "local\n", "utf8");
  fs.symlinkSync(outside, path.join(root, "skill", "linked-outside"), "dir");
  fs.symlinkSync(path.join(root, "skill", "SKILL.md"), path.join(root, "skill", "linked-inside"), "file");
  return { root, outside };
}

test("the copy path skips OS junk", (t) => {
  const { root, outside } = tree();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-copy-dest-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  copyRecursive(root, dest);

  assert.equal(fs.existsSync(path.join(dest, ".DS_Store")), false);
  assert.equal(fs.existsSync(path.join(dest, "skill", ".DS_Store")), false);
  assert.equal(fs.existsSync(path.join(dest, "skill", "scripts", ".DS_Store")), false);
  // The real content still lands.
  assert.equal(fs.readFileSync(path.join(dest, "skill", "SKILL.md"), "utf8"), "# skill\n");
  assert.equal(
    fs.readFileSync(path.join(dest, "skill", "scripts", "index.js"), "utf8"),
    "module.exports = {};\n",
  );
});

test("the copy path does not follow symlinks out of the tree", (t) => {
  const { root, outside } = tree();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-copy-dest-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  copyRecursive(root, dest);

  // The machine-specific link must not become a directory in the project.
  assert.equal(fs.existsSync(path.join(dest, "skill", "linked-outside")), false);
  assert.equal(
    fs.existsSync(path.join(dest, "skill", "linked-outside", "secret-local-file.txt")),
    false,
  );
  // No symlink is copied at all: `npm pack` drops them, so copying one would
  // make the two install paths disagree.
  assert.equal(fs.existsSync(path.join(dest, "skill", "linked-inside")), false);
});

test("the distribution tree itself carries no symlink", () => {
  // A tracked symlink in the L1 templates points at a path on the machine
  // that created it. `npm pack` drops it, so it would ship to nobody — but
  // the source checkout still copies it into projects, and it breaks the
  // "both install paths agree" contract.
  const templatesRoot = path.join(ROOT, "templates");
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { found.push(path.relative(templatesRoot, full)); continue; }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(templatesRoot);
  assert.deepEqual(found, [], `L1 templates must not carry symlinks: ${found.join(", ")}`);
});
