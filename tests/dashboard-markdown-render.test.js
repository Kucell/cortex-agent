"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const VENDOR = path.join(ROOT, "templates", "_shared", ".agent", "skills", "agent-dashboard", "vendor", "markdown-it.min.js");

function parser() {
  const context = { window: {} };
  context.self = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(VENDOR, "utf8"), context);
  const markdownit = context.window.markdownit || context.markdownit;
  assert.equal(typeof markdownit, "function");
  return markdownit({ html: false, linkify: true, breaks: false });
}

test("vendored markdown-it renders common project document blocks", () => {
  const html = parser().render([
    "# Mission",
    "",
    "> Source proposal",
    "",
    "- first",
    "- **second**",
    "",
    "| State | Owner |",
    "| --- | --- |",
    "| active | agent |",
    "",
    "```js",
    "const ready = true;",
    "```",
  ].join("\n"));

  for (const marker of ["<h1>Mission</h1>", "<blockquote>", "<ul>", "<strong>second</strong>", "<table>", "language-js", "const ready = true;"]) {
    assert.ok(html.includes(marker), `missing rendered marker: ${marker}`);
  }
});

test("dashboard Markdown configuration escapes HTML and rejects unsafe links", () => {
  const html = parser().render([
    "<script>globalThis.compromised = true</script>",
    "",
    "[unsafe](javascript:alert(1))",
  ].join("\n"));

  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href=["']javascript:/i);
});
