"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const ext = require(path.join(ROOT, "packages", "extension-sdk", "src"));

function manifest(overrides = {}) {
  return {
    id: "runtime-paseo",
    version: "0.1.0",
    type: "runtime-adapter",
    cortex: {
      protocol: "cortex-extension",
      min_version: "1.0",
      max_version_exclusive: "2.0",
    },
    capabilities: {
      provided: ["runtime.run.create", "runtime.run.cancel"],
      required: ["management.query"],
    },
    permissions: {
      filesystem: {
        read: ["src/**"],
        write: ["tests/**"],
      },
      git: {
        read: true,
        commit: true,
        push: false,
      },
      process: {
        spawn: true,
      },
      network: {
        allow: ["127.0.0.1"],
      },
      secrets: {
        read: [],
      },
    },
    entry_points: {
      server: "dist/server.js",
    },
    config_schema: {
      type: "object",
    },
    ...overrides,
  };
}

test("extension manifest freezes type, compatibility, capabilities and permissions", () => {
  const value = ext.normalizeExtensionManifest(manifest(), ext.normalizePermissions);
  assert.equal(value.type, "runtime-adapter");
  assert.deepEqual(value.capabilities.provided, [
    "runtime.run.create",
    "runtime.run.cancel",
  ]);
  assert.equal(value.permissions.git.commit, true);
  assert.equal(value.entry_points.server, "dist/server.js");
  assert.equal(Object.isFrozen(value), true);
});

test("unknown extension types and incompatible Cortex versions fail closed", () => {
  assert.throws(
    () => ext.normalizeExtensionManifest(manifest({ type: "magic-plugin" }), ext.normalizePermissions),
    (error) => error.code === "ERR_EXTENSION_TYPE_UNKNOWN",
  );
  assert.throws(
    () => ext.normalizeExtensionManifest(manifest({
      cortex: {
        protocol: "cortex-extension",
        min_version: "2.0",
        max_version_exclusive: "3.0",
      },
    }), ext.normalizePermissions),
    (error) => error.code === "ERR_EXTENSION_CORTEX_INCOMPATIBLE",
  );
});

test("extension entry points reject absolute and traversal paths", () => {
  assert.throws(
    () => ext.normalizeExtensionManifest(manifest({
      entry_points: { server: "../../escape.js" },
    }), ext.normalizePermissions),
    (error) => error.code === "ERR_EXTENSION_ENTRY_POINT_TRAVERSAL",
  );
  assert.throws(
    () => ext.normalizeExtensionManifest(manifest({
      entry_points: { server: "/tmp/escape.js" },
    }), ext.normalizePermissions),
    (error) => error.code === "ERR_EXTENSION_ENTRY_POINT_ABSOLUTE",
  );
});

test("permission policy is default-deny and deny overrides approval/allow", () => {
  const evaluation = ext.evaluatePermissions(manifest().permissions, {
    default: "deny",
    rules: [
      { permission: "filesystem.read", effect: "allow", scopes: ["src/**"] },
      { permission: "filesystem.write", effect: "approval_required", scopes: ["tests/**"] },
      { permission: "git.read", effect: "allow" },
      { permission: "git.commit", effect: "approval_required" },
      { permission: "process.spawn", effect: "deny" },
      { permission: "network.connect", effect: "approval_required", scopes: ["127.0.0.1"] },
    ],
  });

  assert.equal(evaluation.outcome, "deny");
  assert.equal(evaluation.enforcement.claimed, false);
  const write = evaluation.decisions.find((item) => item.permission === "filesystem.write");
  assert.equal(write.outcome, "approval_required");
  const spawn = evaluation.decisions.find((item) => item.permission === "process.spawn");
  assert.equal(spawn.outcome, "deny");
});

test("approval_required is the aggregate outcome when no request is denied", () => {
  const evaluation = ext.evaluatePermissions({
    git: { read: true, commit: true },
  }, {
    default: "deny",
    rules: [
      { permission: "git.read", effect: "allow" },
      { permission: "git.commit", effect: "approval_required" },
    ],
  });
  assert.equal(evaluation.outcome, "approval_required");
});

test("registry is deterministic, idempotent for same version and rejects version collision", () => {
  const registry = ext.createExtensionRegistry();
  const first = registry.register(manifest());
  const second = registry.register(manifest());
  assert.equal(first.registered, true);
  assert.equal(second.idempotent, true);
  assert.equal(registry.list().length, 1);
  assert.throws(
    () => registry.register(manifest({ version: "0.2.0" })),
    (error) => error.code === "ERR_EXTENSION_ID_CONFLICT",
  );
});

test("catalog plugin is not implicitly an executable extension type", () => {
  assert.equal(ext.EXTENSION_TYPES.includes("plugin"), false);
});
