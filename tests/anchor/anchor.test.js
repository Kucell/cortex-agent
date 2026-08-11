"use strict";

// Coverage for lib/anchor/anchor.js — cross-tool anchor building and rendering.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildAnchor,
  buildContext,
  renderMarkdown,
  renderJson,
  ANCHOR_VERSION,
  ANCHOR_BEGIN,
  ANCHOR_END,
  PKG_VERSION,
} = require("../../lib/anchor/anchor.js");

function makeProject(setup = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-anchor-test-"));
  if (setup.pkgName) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: setup.pkgName }));
  }
  if (setup.agentsMd) fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  if (setup.agentDir) fs.mkdirSync(path.join(root, ".agent"));
  if (setup.publicAnchor) {
    fs.mkdirSync(path.join(root, "docs", "cortex-agent"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "cortex-agent", "anchor.md"), "anchor");
  }
  return root;
}

describe("anchor — buildContext detection", () => {
  test("detects project name from package.json", () => {
    const root = makeProject({ pkgName: "my-app" });
    const ctx = buildContext({ projectDir: root });
    assert.equal(ctx.projectName, "my-app");
  });

  test("falls back to directory basename when no package.json", () => {
    const root = makeProject();
    const ctx = buildContext({ projectDir: root });
    assert.equal(ctx.projectName, path.basename(root));
  });

  test("name override wins over detection", () => {
    const root = makeProject({ pkgName: "pkg-name" });
    const ctx = buildContext({ projectDir: root, name: "override" });
    assert.equal(ctx.projectName, "override");
  });

  test("detects .agent dir, AGENTS.md entry file and public anchor", () => {
    const root = makeProject({ agentDir: true, agentsMd: true, publicAnchor: true });
    const ctx = buildContext({ projectDir: root });
    assert.equal(ctx.agentDir, ".agent/");
    assert.equal(ctx.entryFile, "AGENTS.md");
    assert.equal(ctx.publicAnchor, "docs/cortex-agent/anchor.md");
  });

  test("missing artifacts yield null agentDir/entryFile/publicAnchor", () => {
    const root = makeProject();
    const ctx = buildContext({ projectDir: root });
    assert.equal(ctx.agentDir, null);
    assert.equal(ctx.entryFile, null);
    assert.equal(ctx.publicAnchor, null);
  });
});

describe("anchor — rendering", () => {
  test("markdown output is wrapped with versioned begin/end markers", () => {
    const root = makeProject({ pkgName: "demo" });
    const { body } = buildAnchor({ projectDir: root, format: "markdown" });
    assert.ok(body.startsWith(ANCHOR_BEGIN));
    assert.ok(body.trimEnd().endsWith(ANCHOR_END));
    assert.ok(body.includes(PKG_VERSION));
    assert.ok(!body.includes("{VERSION}"));
  });

  test("json output is parseable and carries project + version", () => {
    const root = makeProject({ pkgName: "demo" });
    const { body } = buildAnchor({ projectDir: root, format: "json" });
    const parsed = JSON.parse(body);
    assert.equal(parsed.schema, "cortex-agent.anchor");
    assert.equal(parsed.version, ANCHOR_VERSION);
    assert.equal(parsed.project, "demo");
    assert.equal(parsed.framework_version, PKG_VERSION);
    assert.ok(Array.isArray(parsed.cli_commands));
  });

  test("json falls back to template defaults for missing detections", () => {
    const root = makeProject({ pkgName: "demo" });
    const parsed = JSON.parse(renderJson(buildContext({ projectDir: root })));
    assert.equal(parsed.entry_file, "AGENTS.md");
    assert.equal(parsed.agent_dir, ".agent/");
  });

  test("renderMarkdown substitutes only the version placeholder", () => {
    const ctx = { version: "9.9.9" };
    const md = renderMarkdown(ctx);
    assert.ok(md.includes("v9.9.9"));
    assert.ok(!md.includes("{VERSION}"));
  });

  test("default format is markdown; unknown formats also fall back", () => {
    const root = makeProject({ pkgName: "demo" });
    assert.equal(buildAnchor({ projectDir: root }).format, "markdown");
    assert.equal(buildAnchor({ projectDir: root, format: "weird" }).format, "weird");
    // unknown format still renders markdown body (render() default branch)
    assert.ok(buildAnchor({ projectDir: root, format: "weird" }).body.includes(ANCHOR_BEGIN));
  });

  test("anchor constants are stable for tool detection", () => {
    assert.equal(ANCHOR_BEGIN, "<!-- cortex-agent:anchor:v1 -->");
    assert.equal(ANCHOR_END, "<!-- cortex-agent:anchor:end -->");
  });
});
