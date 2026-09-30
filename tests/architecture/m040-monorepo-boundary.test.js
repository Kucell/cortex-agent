"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");

test("M-040 workspace declares packages/* only", () => {
  const workspace = fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /packages:\s*\n\s*-\s*["']packages\/\*["']/);
});

test("@cortex-agent/protocol remains portable and implementation-free", () => {
  const dir = path.join(ROOT, "packages", "protocol", "src");
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const forbidden of [
      "node:fs",
      "node:child_process",
      "../../lib",
      "paseo",
      "axrail",
    ]) {
      assert.equal(text.includes(forbidden), false, `${name} must not depend on ${forbidden}`);
    }
  }
});

test("@cortex-agent/sdk depends on protocol but owns no persistence implementation", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "sdk", "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@cortex-agent/protocol"], "workspace:*");
  const text = fs.readFileSync(path.join(ROOT, "packages", "sdk", "src", "index.js"), "utf8");
  assert.equal(text.includes("node:fs"), false);
  assert.equal(text.includes(".agent/"), false);
  assert.equal(text.includes("../../lib"), false);
});

test("canonical refs are typed opaque strings", () => {
  const refs = require(path.join(ROOT, "packages", "protocol", "src", "refs.js"));
  const ref = refs.createRef("project", "axrail");
  assert.equal(ref, "project:axrail");
  assert.deepEqual(refs.parseRef(ref), { kind: "project", value: "axrail", ref });
  assert.equal(refs.isRef("runtime:paseo-local", "runtime"), true);
  assert.equal(refs.isRef("paseo:raw", "runtime"), false);
});

test("root cortex-agent package ships workspace contract sources for CLI compatibility", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("packages"));
});

test("management query surface consumes the SDK facade rather than Management client directly", () => {
  const text = fs.readFileSync(
    path.join(ROOT, "lib", "commands", "management", "query.js"),
    "utf8",
  );
  assert.match(text, /createLocalCortexClient/);
  assert.equal(text.includes("queryManagementProject"), false);
});

test("ProjectRef identity is derived from topology before directory basename fallback", () => {
  const text = fs.readFileSync(
    path.join(ROOT, "lib", "sdk", "local-transport.js"),
    "utf8",
  );
  assert.match(text, /current\.self\.project_id/);
  assert.match(text, /path\.basename\(project\.root\)/);
  assert.ok(text.indexOf("current.self.project_id") < text.indexOf("path.basename(project.root)"));
});

test("@cortex-agent/runtime-port depends only on portable protocol contracts", () => {
  const pkg = JSON.parse(fs.readFileSync(
    path.join(ROOT, "packages", "runtime-port", "package.json"),
    "utf8",
  ));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), ["@cortex-agent/protocol"]);
  const text = fs.readFileSync(
    path.join(ROOT, "packages", "runtime-port", "src", "index.js"),
    "utf8",
  );
  assert.equal(text.includes("../../lib"), false);
  assert.equal(text.includes("node:fs"), false);
  assert.equal(text.includes("child_process"), false);
});
