"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  parsePnpmScript,
  validateConnectedProject,
} = require(path.join(ROOT, "scripts", "m040", "validate-connected-project.js"));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m040-project-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "architecture.md"), "# architecture\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: { check: "echo ok" },
  }));
  fs.writeFileSync(path.join(root, "cortex.project.json"), JSON.stringify({
    project_id: "demo",
    repository: { slug: "Kucell/demo", default_branch: "main" },
    integration_mode: "connected",
    capabilities: {
      provided: ["project.discover", "project.validation.list", "project.artifact.list"],
      required: [],
    },
    validation: {
      profiles: [{
        id: "check",
        command: "pnpm check",
        purpose: "check",
        blocking: true,
      }],
    },
    artifacts: [{
      id: "architecture",
      path: "docs/architecture.md",
      kind: "architecture",
    }],
    events: { mode: "none" },
    boundaries: {
      authoritative_domain: "demo",
      authoritative_runtime: "demo",
      cortex_role: "governance-orchestration",
      protected_components: ["Runtime"],
    },
  }));
  return root;
}

test("connected project validator checks declared pnpm scripts and artifacts without executing them", () => {
  const root = fixture();
  try {
    const result = validateConnectedProject(root, {
      expectProject: "demo",
      expectRepository: "Kucell/demo",
    });
    assert.equal(result.ok, true);
    assert.equal(result.validation_profiles[0].script, "check");
    assert.equal(result.artifacts[0].path, "docs/architecture.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("connected project validator rejects missing declared scripts", () => {
  const root = fixture();
  try {
    const descriptorPath = path.join(root, "cortex.project.json");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    descriptor.validation.profiles[0].command = "pnpm missing";
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
    assert.throws(
      () => validateConnectedProject(root),
      (error) => error.code === "ERR_CONNECTED_PROJECT_VALIDATION",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validator accepts only simple pnpm script declarations", () => {
  assert.equal(parsePnpmScript("pnpm check"), "check");
  assert.equal(parsePnpmScript("pnpm release:dry-run"), "release:dry-run");
  assert.equal(parsePnpmScript("pnpm check && rm -rf /"), null);
});
