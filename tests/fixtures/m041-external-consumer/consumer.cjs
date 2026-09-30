"use strict";

const assert = require("node:assert/strict");

const protocol = require("@cortex-agent/protocol");
const sdk = require("@cortex-agent/sdk");
const runtime = require("@cortex-agent/runtime-port");
const project = require("@cortex-agent/project-sdk");
const extension = require("@cortex-agent/extension-sdk");

async function main() {
  const health = protocol.normalizePlatformHealth({
    generated_at: "2026-09-30T02:00:00.000Z",
    components: [{
      id: "package:consumer",
      kind: "package",
      status: "healthy",
      observed_at: "2026-09-30T02:00:00.000Z",
      producer: {
        id: "external-consumer",
        kind: "fixture",
        version: "1.0",
      },
      checks: [],
      evidence_refs: [],
      redacted: true,
    }],
  });
  assert.equal(health.overall, "healthy");
  assert.equal(protocol.createRef("project", "consumer"), "project:consumer");

  const calls = [];
  const client = sdk.createCortexClient({
    transport: {
      query(name, filters = {}) {
        calls.push({ name, filters });
        if (name === "runs") return [];
        if (name === "capabilities") return { projections: [] };
        return null;
      },
      resolveProject() {
        return {
          project_ref: "project:consumer",
          project_id: "consumer",
        };
      },
      discoverCapabilities() {
        return {
          protocol: "cortex",
          protocol_version: "1.0",
          implementation: "external-consumer",
          capabilities: ["runs.read"],
        };
      },
    },
  });
  assert.deepEqual(client.runs.list(), []);
  assert.equal(client.project.resolve().project_ref, "project:consumer");
  assert.equal(client.capabilities.discover().implementation, "external-consumer");

  const port = runtime.createRuntimePort({
    descriptor: {
      protocol: "cortex-runtime",
      protocol_version: "1.0",
      implementation: "external-runtime",
      capabilities: ["runtime.health"],
    },
    operations: {
      health() {
        return { status: "ok", ready: true };
      },
    },
  });
  assert.equal(port.health().ready, true);
  assert.throws(
    () => port.createRun({}),
    (error) => error.code === "ERR_RUNTIME_CAPABILITY_UNSUPPORTED",
  );

  const descriptor = project.normalizeProjectDescriptor({
    project_id: "external-demo",
    repository: {
      slug: "Example/external-demo",
      default_branch: "main",
    },
    integration_mode: "connected",
    capabilities: {
      provided: ["project.discover", "project.validation.list"],
      required: [],
    },
    validation: {
      profiles: [{
        id: "check",
        command: "pnpm check",
        purpose: "Validate external demo",
        blocking: true,
      }],
    },
    artifacts: [],
    events: { mode: "none" },
    boundaries: {
      authoritative_domain: "external-demo",
      authoritative_runtime: "external-demo",
      cortex_role: "governance-orchestration",
      protected_components: ["Runtime"],
    },
  });
  assert.equal(descriptor.project_ref, "project:external-demo");
  assert.equal(descriptor.integration_mode, "connected");

  const manifest = extension.normalizeExtensionManifest({
    id: "external-validator",
    version: "0.1.0",
    type: "validator",
    cortex: {
      protocol: "cortex-extension",
      min_version: "1.0",
      max_version_exclusive: "2.0",
    },
    capabilities: {
      provided: [],
      required: ["management.query"],
    },
    permissions: {
      filesystem: { read: ["src/**"], write: [] },
      git: { read: false, commit: false, push: false },
      process: { spawn: false },
      network: { allow: [] },
      secrets: { read: [] },
    },
    entry_points: {
      server: "index.js",
    },
    config_schema: {
      type: "object",
      additionalProperties: false,
    },
  }, extension.normalizePermissions);
  assert.equal(manifest.type, "validator");

  const permission = extension.evaluatePermissions(manifest.permissions, {
    default: "deny",
    rules: [{
      permission: "filesystem.read",
      effect: "allow",
      scopes: ["src/**"],
    }],
  });
  assert.equal(permission.outcome, "allow");

  assert.deepEqual(calls[0], { name: "runs", filters: {} });

  process.stdout.write(JSON.stringify({
    ok: true,
    protocol: protocol.PROTOCOL_VERSION,
    project_ref: descriptor.project_ref,
    runtime: port.descriptor.implementation,
    extension: manifest.id,
    health: health.overall,
  }, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
