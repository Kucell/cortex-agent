"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const project = require(path.join(ROOT, "packages", "project-sdk", "src"));

function descriptor(overrides = {}) {
  return {
    project_id: "axrail",
    repository: {
      slug: "Kucell/axrail",
      default_branch: "main",
    },
    integration_mode: "connected",
    capabilities: {
      provided: [
        "project.discover",
        "project.validation.list",
        "project.validation.run",
        "project.artifact.list",
        "project.event.read",
      ],
      required: [],
    },
    validation: {
      profiles: [
        {
          id: "release-dry-run",
          command: "pnpm release:dry-run",
          purpose: "Axrail release gate",
          blocking: true,
        },
      ],
    },
    artifacts: [
      { id: "architecture", path: "docs/architecture/README.md", kind: "architecture" },
    ],
    events: {
      mode: "observational",
      source: "@axrail/events",
    },
    boundaries: {
      authoritative_domain: "axrail",
      authoritative_runtime: "axrail",
      cortex_role: "governance-orchestration",
      protected_components: [
        "HarnessRuntime",
        "ToolRuntime",
        "Policy",
        "Validation",
        "Approval",
        "TransactionRuntime",
        "EventStore",
      ],
    },
    ...overrides,
  };
}

test("connected project descriptor preserves external project authority", () => {
  const value = project.normalizeProjectDescriptor(descriptor());
  assert.equal(value.project_ref, "project:axrail");
  assert.equal(value.integration_mode, "connected");
  assert.equal(value.boundaries.authoritative_domain, "axrail");
  assert.equal(value.boundaries.authoritative_runtime, "axrail");
  assert.ok(value.boundaries.protected_components.includes("TransactionRuntime"));
});

test("project validation profiles are declarative and do not execute by themselves", () => {
  const adapter = project.createDescriptorOnlyProjectAdapter(descriptor({
    capabilities: {
      provided: [
        "project.discover",
        "project.validation.list",
        "project.artifact.list",
      ],
      required: [],
    },
  }));
  assert.equal(adapter.listValidationProfiles()[0].command, "pnpm release:dry-run");
  assert.throws(
    () => adapter.runValidation("release-dry-run"),
    (error) => error.code === "ERR_PROJECT_CAPABILITY_UNSUPPORTED",
  );
});

test("declared executable project capabilities require an explicit operation owner", () => {
  assert.throws(
    () => project.createProjectAdapter({ descriptor: descriptor(), operations: {} }),
    (error) => error.code === "ERR_PROJECT_OPERATION_MISSING"
      && error.details.capability === "project.discover",
  );
});

test("project artifact paths reject traversal", () => {
  assert.throws(
    () => project.normalizeProjectDescriptor(descriptor({
      artifacts: [{ id: "escape", path: "../secret", kind: "evidence" }],
    })),
    (error) => error.code === "ERR_PROJECT_PATH_INVALID",
  );
});

test("unknown or runtime-specific capabilities cannot leak into Project Integration", () => {
  assert.throws(
    () => project.normalizeProjectDescriptor(descriptor({
      capabilities: {
        provided: ["runtime.run.create"],
        required: [],
      },
    })),
    (error) => error.code === "ERR_PROJECT_CAPABILITY_NAMESPACE",
  );
});

test("Project Adapter execution remains behind an explicit operation owner", async () => {
  const calls = [];
  const value = descriptor();
  const adapter = project.createProjectAdapter({
    descriptor: value,
    operations: {
      discoverProject() { return project.normalizeProjectDescriptor(value); },
      listValidationProfiles() {
        return project.normalizeProjectDescriptor(value).validation.profiles;
      },
      async runValidation(profileId, context) {
        calls.push({ profileId, context });
        return { status: "passed", evidence_ref: "ci:axrail:123" };
      },
      listArtifacts() {
        return project.normalizeProjectDescriptor(value).artifacts;
      },
      readEvents() {
        return [];
      },
    },
  });

  const result = await adapter.runValidation("release-dry-run", {
    authorization_ref: "decision:D-AXRAIL",
  });
  assert.equal(result.status, "passed");
  assert.equal(result.evidence_ref, "ci:axrail:123");
  assert.deepEqual(calls, [{
    profileId: "release-dry-run",
    context: { authorization_ref: "decision:D-AXRAIL" },
  }]);
});
