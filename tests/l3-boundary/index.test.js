"use strict";

// Tests for lib/l3-boundary — the gate that keeps cortex-agent's L3
// self-bootstrap content out of the L1 templates shipped to user projects.
//
// Fixtures are built in a tmpdir so the suite never touches the real tree.

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanDistribution } = require("../../lib/l3-boundary");

let tmp;

function write(relPath, content) {
  const full = path.join(tmp, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l3-boundary-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("l3-boundary - scanDistribution", () => {
  // ── Happy path ────────────────────────────────────────────────────────────
  test("should report ok when the distribution tree is clean", () => {
    write("templates/zh/.agent/rules/example.md", "# Example\n\nGeneric L1 content.\n");

    const result = scanDistribution(tmp);

    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  test("should report ok with zero files checked when templates/ is absent", () => {
    const result = scanDistribution(tmp);

    assert.equal(result.ok, true);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.violations, []);
  });

  test("should count scanned text files", () => {
    write("templates/_shared/.agent/rules/a.md", "clean\n");
    write("templates/en/.agent/rules/b.md", "clean\n");
    write("templates/zh/.agent/rules/c.md", "clean\n");

    const result = scanDistribution(tmp);

    assert.equal(result.checked, 3);
  });

  // ── Rule: author-local absolute path ──────────────────────────────────────
  test("should flag an author-local home path in distributed content", () => {
    write(
      "templates/_shared/.agent/skills/demo/SKILL.md",
      "Hint: /Users/alice/.agent/contexts/\n",
    );

    const result = scanDistribution(tmp);

    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, "author-local-path");
    assert.equal(result.violations[0].file, "templates/_shared/.agent/skills/demo/SKILL.md");
    assert.equal(result.violations[0].line, 1);
  });

  test("should flag a /home/ path as well as /Users/", () => {
    write("templates/en/.agent/rules/a.md", "see /home/bob/project for details\n");

    const result = scanDistribution(tmp);

    assert.equal(result.ok, false);
    assert.equal(result.violations[0].rule, "author-local-path");
  });

  test("should report the correct line number for a mid-file hit", () => {
    write(
      "templates/zh/.agent/rules/a.md",
      ["line one", "line two", "line three", "path /Users/carol/x here", "line five"].join("\n"),
    );

    const result = scanDistribution(tmp);

    assert.equal(result.violations[0].line, 4);
  });

  test("should not flag placeholder home paths", () => {
    write(
      "templates/_shared/.agent/design-systems/README.md",
      [
        "Paths like /Users/.../ are conventional here.",
        "Also /Users/<user>/ and /Users/$HOME/ and /Users/USERNAME/.",
        "And /home/.../ for Linux.",
      ].join("\n"),
    );

    const result = scanDistribution(tmp);

    assert.equal(result.ok, true, "placeholders must not be treated as real paths");
  });

  // ── Rule: framework-private repo reference ────────────────────────────────
  test("should flag a reference to the framework-private state repo", () => {
    write(
      "templates/_shared/.agent/rules/a.md",
      "Remote is git@github.com:Kucell/cortex-agent-agent.git\n",
    );

    const result = scanDistribution(tmp);

    assert.equal(result.ok, false);
    assert.equal(result.violations[0].rule, "framework-private-repo");
  });

  test("should flag the Inner mirror cross-reference convention", () => {
    write("templates/zh/.agent/rules/a.md", "body must include `Inner mirror: <sha>`\n");

    const result = scanDistribution(tmp);

    assert.equal(result.ok, false);
    assert.equal(result.violations[0].rule, "framework-private-repo");
  });

  // ── Rule: scope: L3 declared in distributed content ───────────────────────
  test("should flag a distributed rule that declares scope: L3", () => {
    write(
      "templates/_shared/.agent/rules/a.md",
      "---\ntitle: \"Internal\"\ntype: rule\nscope: L3\n---\n\n# Internal\n",
    );

    const result = scanDistribution(tmp);

    assert.equal(result.ok, false);
    assert.equal(result.violations[0].rule, "l3-scope-in-template");
  });

  test("should not flag scope: L1 or L2 declarations", () => {
    write(
      "templates/zh/.agent/rules/a.md",
      "---\nscope: L1\n---\n\ntext\n\n---\nscope: L2\n---\n",
    );

    const result = scanDistribution(tmp);

    assert.equal(result.ok, true);
  });

  // ── Traversal behaviour ───────────────────────────────────────────────────
  test("should skip node_modules and .git directories", () => {
    write("templates/_shared/node_modules/pkg/readme.md", "/Users/dave/leaked\n");
    write("templates/_shared/.git/config", "/Users/dave/leaked\n");

    const result = scanDistribution(tmp);

    assert.equal(result.ok, true);
    assert.equal(result.checked, 0);
  });

  test("should skip non-text file extensions", () => {
    write("templates/_shared/.agent/assets/logo.png", "/Users/erin/leaked");

    const result = scanDistribution(tmp);

    assert.equal(result.ok, true);
    assert.equal(result.checked, 0);
  });

  test("should scan .agent/ directories at any depth", () => {
    write("templates/general/.agent/rules/a.md", "/Users/frank/leaked\n");

    const result = scanDistribution(tmp);

    assert.equal(result.ok, false);
    assert.equal(result.checked, 1);
  });

  // ── Multiple violations ───────────────────────────────────────────────────
  test("should collect violations across multiple files and rules", () => {
    write("templates/_shared/.agent/rules/a.md", "/Users/gina/leaked\n");
    write("templates/en/.agent/rules/b.md", "scope: L3\n");
    write("templates/zh/.agent/rules/c.md", "Inner mirror: abc123\n");

    const result = scanDistribution(tmp);

    assert.equal(result.checked, 3);
    assert.equal(result.violations.length, 3);

    const rules = new Set(result.violations.map((v) => v.rule));
    assert.deepEqual(
      [...rules].sort(),
      ["author-local-path", "framework-private-repo", "l3-scope-in-template"],
    );
  });

  test("should not throw on an unreadable directory", () => {
    // A file where a directory is expected — collectFiles must swallow it.
    write("templates/_shared/.agent/rules", "not a directory\n");

    const result = scanDistribution(tmp);

    assert.equal(typeof result.ok, "boolean");
  });
});
