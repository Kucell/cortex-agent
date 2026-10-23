"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const sources = ["_shared", "zh", "en"].map((variant) => [variant,
  path.join(root, "templates", variant, ".agent/skills/knowledge-lint/scripts/index.js")]);
if (process.env.CORTEX_GOVERNANCE_KNOWLEDGE_LINT_PATH) {
  sources.push(["governance", process.env.CORTEX_GOVERNANCE_KNOWLEDGE_LINT_PATH]);
}

// CommonMark 0.31.2 sections 4.6/4.7: HTML blocks contain literal text;
// reference definitions cannot interrupt an existing paragraph.
// https://spec.commonmark.org/0.31.2/#html-blocks
// https://spec.commonmark.org/0.31.2/#link-reference-definitions
const spanCases = [
  ["list fence followed by real link", "- ```\n  [example](example.md)\n  ```\n\n[real](missing.md)", true],
  ["nested list fence", "- outer\n  - ```\n    [example](example.md)\n    ```\n\n[real](missing.md)", true],
  ["quoted list fence", "> - ```\n>   [example](example.md)\n>   ```\n\n[real](missing.md)", true],
  ["quote lazy continuation", "> `code\n[example](missing.md)\nend`", false],
  ["list fence only", "- ```\n  [example](missing.md)\n  ```", false],
  ["real link after HTML block", "<div>\n[example](example.md)\n</div>\n\n[real](missing.md)", true],
  ["real link after reference definition", "[ref]: other.md\n\n[real](missing.md)", true],
  ["reference link resolved", "[real][ref]\n\n[ref]: missing.md", true],
  ["image target checked", "![real](missing.md)", true],
  ["heading in indented list continuation", "- `unclosed\n    # [real](missing.md)\n    `tail", true],
  ["separator in indented list continuation", "1. `unclosed\n     ***\n     [real](missing.md)\n     `tail", true],
  ["quote in indented list continuation", "- `unclosed\n    > [real](missing.md)\n    `tail", true],
  ["fenced quote markers stay literal", "````markdown\n> heading\n```\n[example](missing.md)\n````", false],
  ["quoted fenced code stays exempt", "> ~~~\n> [example](missing.md)\n> ~~~", false],
  ["leaving quoted fence restores prose", "> ~~~\n> code\n[real](missing.md)", true],
  ["ATX heading interrupts paragraph", "`unclosed\n# [real](missing.md)\n`tail", true],
  ["indented ATX heading", "`unclosed\n   ### [real](missing.md)\n`tail", true],
  ["thematic break interrupts paragraph", "`unclosed\n***\n[real](missing.md)\n`tail", true],
  ["spaced thematic break", "`unclosed\n _ _ _ \n[real](missing.md)\n`tail", true],
  ["setext heading ends block", "`unclosed\n===\n[real](missing.md)\n`tail", true],
  ["dash setext heading", "`unclosed\n--\n[real](missing.md)\n`tail", true],
  ["bullet item interrupts paragraph", "`unclosed\n- [real](missing.md)\n`tail", true],
  ["ordered first item interrupts", "`unclosed\n1. [real](missing.md)\n`tail", true],
  ["ordered sibling items are separate", "1. `unclosed\n2. [real](missing.md)\n`tail", true],
  ["bullet siblings are separate", "- `unclosed\n- [real](missing.md)\n`tail", true],
  ["nested list starts new block", "- `unclosed\n    - [real](missing.md)\n`tail", true],
  ["list heading is separate", "- # `unclosed\n[real](missing.md)\n`tail", true],
  ["blockquote interrupts paragraph", "`unclosed\n> [real](missing.md)\n`tail", true],
  ["heading inside blockquote", "> `unclosed\n> # [real](missing.md)\n> `tail", true],
  ["HTML block content is literal", "`unclosed\n<div>\n[real](missing.md)\n</div>\n`tail", false],
  ["HTML comment interrupts paragraph", "`unclosed\n<!-- block -->\n[real](missing.md)\n`tail", true],
  ["reference definition cannot interrupt paragraph", "`unclosed\n[ref]: other.md\n[real](missing.md)\n`tail", false],
  ["table delimiter separates blocks", "`unclosed | value\n--- | ---\n[real](missing.md) | `tail", true],
  ["fence separates paragraphs", "`unclosed\n~~~\nexample\n~~~\n[real](missing.md)\n`tail", true],
  ["seven hashes do not start heading", "`code\n####### [example](missing.md)\nend`", false],
  ["hash without whitespace is prose", "`code\n#hashtag [example](missing.md)\nend`", false],
  ["escaped heading marker is prose", "`code\n\\# [example](missing.md)\nend`", false],
  ["short star run is prose", "`code\n** [example](missing.md)\nend`", false],
  ["non-first ordered marker does not interrupt prose", "`code\n2. [example](missing.md)\nend`", false],
  ["list item soft continuation", "- `code\n  [example](missing.md)\n  end`", false],
  ["blockquote soft continuation", "> `code\n> [example](missing.md)\n> end`", false],
  ["heading inline code remains exempt", "# `[example](missing.md)`", false],
  ["unequal single/double", "`unmatched [real](missing.md)``\n", true],
  ["unequal double/single", "``unmatched [real](missing.md)`\n", true],
  ["escaped delimiters", "\\` [real](missing.md) \\`\n", true],
  ["blank paragraph boundary", "`unclosed\n\n[real](missing.md)\n\n`tail\n", true],
  ["whitespace paragraph boundary", "`unclosed\r\n \t\r\n[real](missing.md)\r\n\r\n`tail", true],
  ["whole unequal runs inside valid code", "``code ` [example](missing.md) ``` end``", false],
  ["soft line break inside valid code", "`code\n[example](missing.md)\nend`", false],
  ["even backslashes do not escape opener", "\\\\`[example](missing.md)`", false],
];

function assertLintChildSucceeded(result) {
  const diagnostic = JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error && {
      code: result.error.code, errno: result.error.errno,
      syscall: result.error.syscall, message: result.error.message,
    },
    timeoutMs: 10000,
    stdoutBytes: Buffer.byteLength(result.stdout || ""),
    stderrBytes: Buffer.byteLength(result.stderr || ""),
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.status, 0, diagnostic);
}

function lintMarkdown(t, source, markdown) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-span-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "docs"));
  fs.writeFileSync(path.join(fixture, "docs/probe.md"), markdown);
  const standalone = path.join(fixture, "standalone.cjs");
  fs.copyFileSync(source, standalone);
  const result = spawnSync(process.execPath, [standalone], {
    cwd: fixture, encoding: "utf8", timeout: 10000,
    env: { ...process.env, CORTEX_AGENT_CLI: path.join(root, "bin/cli.js") },
  });
  assertLintChildSucceeded(result);
  return JSON.parse(fs.readFileSync(path.join(fixture, ".agent/metrics/knowledge-health.json"), "utf8"));
}

for (const [variant, source] of sources) {
  for (const [name, markdown, broken] of spanCases) {
    test(`knowledge-lint ${variant}: ${name}`, (t) => {
      const report = lintMarkdown(t, source, markdown);
      assert.deepEqual(report.findings.broken_links.map((item) => item.target), broken ? ["missing.md"] : []);
    });
  }
  test(`knowledge-lint ${variant}: code examples are not links; real invalid links remain findings`, (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-links-"));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const docs = path.join(fixture, "docs");
    fs.mkdirSync(docs);
    const target = path.join(docs, "existing file.md");
    fs.writeFileSync(target, "# Existing anchor\n");
    const present = pathToFileURL(target).href;
    const absent = pathToFileURL(path.join(docs, "missing file.md")).href;
    const invalid = "file:///bad%ZZ.md";
    const markdown = [
      '# Fixture',
      '`grep -rE \'require\\(["](commander|yargs|minimist)\'`',
      '``code with ` [ignored](inline-missing.md)``',
      '```markdown', '[ignored](fenced-missing.md)', '```',
      '~~~~markdown', '[ignored](tilde-missing.md)', '~~~',
      '[still ignored](short-close-missing.md)', '~~~~',
      '[missing after fence](missing-after-fence.md)',
      '[relative missing](missing-relative.md)',
      '[present](<existing file.md#existing-anchor>)',
      `[file present](${present}#existing-anchor)`,
      `[file missing](${absent})`, `[invalid URL](${invalid})`,
      '[bad anchor](<existing file.md#absent-anchor>)',
      '[external](https://example.invalid/unavailable)',
    ].join('\n');
    fs.writeFileSync(path.join(docs, "fixture.md"), markdown);
    const result = spawnSync(process.execPath, [source], {
      cwd: fixture, encoding: "utf8", timeout: 10000,
      env: { ...process.env, CORTEX_AGENT_CLI: path.join(root, "bin/cli.js") },
    });
    assertLintChildSucceeded(result);
    const report = JSON.parse(fs.readFileSync(path.join(fixture, ".agent/metrics/knowledge-health.json"), "utf8"));
    assert.deepEqual(report.findings.broken_links.map((item) => item.target).sort(),
      ["missing-after-fence.md", "missing-relative.md", absent, invalid].sort());
    assert.equal(report.findings.broken_anchors.length, 1);
    assert.equal(report.findings.broken_anchors[0].target, "existing file.md#absent-anchor");
  });
}

test("link parsing changes stay identical in all template variants", () => {
  const sections = sources.map(([, source]) => {
    const text = fs.readFileSync(source, "utf8");
    return text.slice(text.indexOf("function shouldCheckLink("), text.indexOf("function collectMissingReadmes("));
  });
  for (const section of sections.slice(1)) assert.equal(section, sections[0]);
});

 test("embedded markdown-it bundle and MIT license match the tracked vendor", () => {
  const vendorRoot = path.join(root, "templates/_shared/.agent/skills/agent-dashboard/vendor");
  const vendor = fs.readFileSync(path.join(vendorRoot, "markdown-it.min.js"), "utf8");
  const license = fs.readFileSync(path.join(vendorRoot, "LICENSE.markdown-it"), "utf8");
  assert.match(vendor, /markdown-it 14\.3\.0/);
  assert.equal(require("node:crypto").createHash("sha256").update(vendor).digest("hex"),
    "70fe17bd06c7fa819f03a1ed10957904318103624198845dc893b309bf495e28");
  for (const [, source] of sources) {
    const text = fs.readFileSync(source, "utf8");
    assert.equal(text.split("// BEGIN MARKDOWN-IT BUNDLE\n")[1].split("// END MARKDOWN-IT BUNDLE")[0], vendor);
    assert.equal(text.split("/* BEGIN MARKDOWN-IT LICENSE\n")[1].split("END MARKDOWN-IT LICENSE */")[0], license);
  }
});
