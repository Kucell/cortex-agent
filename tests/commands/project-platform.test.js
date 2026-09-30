"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  projectPlatformCommand,
  parse,
} = require("../../lib/commands/project-platform.js");

function io() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    read() { return { stdout, stderr }; },
  };
}

function readModel() {
  return {
    async list() {
      return {
        schema_version: "1",
        projects: [{
          project_id: "axrail",
          repository_slug: "Kucell/axrail",
          integration_mode: "connected",
        }],
      };
    },
    async inspect(id) {
      if (id !== "axrail" && id !== "project:axrail") return null;
      return {
        schema_version: "1",
        project: {
          project_id: "axrail",
          repository_slug: "Kucell/axrail",
          integration_mode: "connected",
          drift: { detected: false },
          authority: {
            cortex_role: "governance-orchestration",
            authoritative_domain: "axrail",
            authoritative_runtime: "axrail",
          },
        },
      };
    },
    async health() {
      return {
        schema_version: "1",
        overall: "healthy",
        components: [{
          id: "project:axrail",
          status: "healthy",
        }],
      };
    },
  };
}

test("project CLI parser recognizes read-only subcommands", () => {
  assert.deepEqual(parse(["project", "inspect", "axrail", "--json"]), {
    subcommand: "inspect",
    project: "axrail",
    json: true,
    help: false,
  });
});

test("project CLI list emits canonical JSON read model", async () => {
  const output = io();
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    await projectPlatformCommand({
      args: ["project", "list", "--json"],
    }, {
      io: output,
      createReadModel: () => readModel(),
    });
    const parsed = JSON.parse(output.read().stdout);
    assert.equal(parsed.projects[0].project_id, "axrail");
    assert.equal(output.read().stderr, "");
  } finally {
    process.exitCode = oldExit;
  }
});

test("project CLI inspect emits bounded authority data", async () => {
  const output = io();
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    await projectPlatformCommand({
      args: ["project", "inspect", "axrail", "--json"],
    }, {
      io: output,
      createReadModel: () => readModel(),
    });
    const parsed = JSON.parse(output.read().stdout);
    assert.equal(parsed.project.authority.authoritative_domain, "axrail");
    assert.equal(parsed.project.drift.detected, false);
  } finally {
    process.exitCode = oldExit;
  }
});

test("project CLI health uses PlatformHealth representation", async () => {
  const output = io();
  const oldExit = process.exitCode;
  process.exitCode = 0;
  try {
    await projectPlatformCommand({
      args: ["project", "health", "--json"],
    }, {
      io: output,
      createReadModel: () => readModel(),
    });
    const parsed = JSON.parse(output.read().stdout);
    assert.equal(parsed.overall, "healthy");
    assert.equal(parsed.components[0].id, "project:axrail");
  } finally {
    process.exitCode = oldExit;
  }
});
