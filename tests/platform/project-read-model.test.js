"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProjectPlatformReadModel,
} = require("../../lib/platform/project-read-model.js");

function fixture() {
  return createProjectPlatformReadModel({
    client: {
      project: {
        connected: {
          list() {
            return [{
              project_id: "axrail",
              project_ref: "project:axrail",
              repository_slug: "Kucell/axrail",
              host_root: "/work/axrail",
              primary_branch: "main",
              topology_ref: "axrail@main",
              capabilities: ["project.discover"],
              integration_mode: "connected",
              descriptor_path: "cortex.project.json",
            }];
          },
          get() {
            return {
              project_id: "axrail",
              project_ref: "project:axrail",
              repository_slug: "Kucell/axrail",
              host_root: "/work/axrail",
              primary_branch: "main",
              topology_ref: "axrail@main",
              capabilities: ["project.discover"],
              integration_mode: "connected",
              descriptor_path: "cortex.project.json",
              drift: {
                detected: false,
                descriptor_digest_changed: false,
                repository_identity_changed: false,
              },
              descriptor: {
                boundaries: {
                  authoritative_domain: "axrail",
                  authoritative_runtime: "axrail",
                  cortex_role: "governance-orchestration",
                  protected_components: ["ToolRuntime"],
                },
                validation: {
                  profiles: [{
                    id: "check",
                    command: "pnpm check",
                    purpose: "check",
                    blocking: true,
                  }],
                },
                events: { mode: "observational", source: "@axrail/events" },
              },
            };
          },
        },
      },
    },
    healthProvider: {
      async produce() {
        return [{
          id: "project:axrail",
          kind: "project",
          status: "healthy",
          observed_at: "2026-09-30T03:00:00.000Z",
          producer: {
            id: "test",
            kind: "fixture",
            version: "1",
          },
          checks: [],
          evidence_refs: [],
          redacted: true,
        }];
      },
    },
  });
}

test("project platform read model exposes bounded list/inspect/health shapes", async () => {
  const model = fixture();
  const list = await model.list({ now: "2026-09-30T03:00:00.000Z" });
  const inspect = await model.inspect("project:axrail", { now: "2026-09-30T03:00:00.000Z" });
  const health = await model.health({ now: "2026-09-30T03:00:00.000Z" });

  assert.equal(list.projects[0].project_ref, "project:axrail");
  assert.equal(inspect.project.authority.authoritative_domain, "axrail");
  assert.deepEqual(inspect.project.validation_profiles, [{
    id: "check",
    purpose: "check",
    blocking: true,
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(inspect.project.validation_profiles[0], "command"), false);
  assert.equal(health.overall, "healthy");
});

test("project platform inspect returns null for unknown project", async () => {
  const model = createProjectPlatformReadModel({
    client: {
      project: {
        connected: {
          list: () => [],
          get: () => null,
        },
      },
    },
    healthProvider: { produce: async () => [] },
  });
  assert.equal(await model.inspect("missing"), null);
});
