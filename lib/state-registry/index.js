"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BUILTIN_REGISTRY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "templates",
  "_shared",
  ".agent",
  "contracts",
  "state-classes.json",
);

const SYNCABLE_POLICIES = new Set(["tracked", "derived"]);

function normalizeStatePath(value) {
  if (typeof value !== "string") return "";
  let file = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (file.startsWith(".agent/")) file = file.slice(".agent/".length);
  while (file.startsWith("/")) file = file.slice(1);
  return file;
}

function readRegistry(file = BUILTIN_REGISTRY_PATH) {
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  validateRegistry(data);
  return Object.freeze({
    ...data,
    classes: Object.freeze(data.classes.map((entry) => Object.freeze({ ...entry }))),
  });
}

function validateRegistry(data) {
  if (!data || typeof data !== "object") throw new Error("STATE_REGISTRY_INVALID: root must be an object");
  if (data.schema_version !== "1.0") throw new Error("STATE_REGISTRY_INVALID: schema_version must be 1.0");
  if (!Array.isArray(data.classes) || data.classes.length === 0) {
    throw new Error("STATE_REGISTRY_INVALID: classes must be a non-empty array");
  }
  const ids = new Set();
  const paths = new Set();
  const allowedPolicies = new Set(["tracked", "local", "derived", "evidence", "legacy", "ignored"]);
  for (const entry of data.classes) {
    if (!entry || typeof entry !== "object") throw new Error("STATE_REGISTRY_INVALID: class entry must be an object");
    for (const key of ["id", "path", "kind", "authority", "sync_policy", "runtime_scope"]) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        throw new Error(`STATE_REGISTRY_INVALID: ${key} is required`);
      }
    }
    if (typeof entry.rebuildable !== "boolean") {
      throw new Error("STATE_REGISTRY_INVALID: rebuildable must be boolean");
    }
    if (!["file", "directory"].includes(entry.kind)) {
      throw new Error(`STATE_REGISTRY_INVALID: unknown kind ${entry.kind}`);
    }
    if (!allowedPolicies.has(entry.sync_policy)) {
      throw new Error(`STATE_REGISTRY_INVALID: unknown sync_policy ${entry.sync_policy}`);
    }
    if (ids.has(entry.id)) throw new Error(`STATE_REGISTRY_INVALID: duplicate id ${entry.id}`);
    if (paths.has(entry.path)) throw new Error(`STATE_REGISTRY_INVALID: duplicate path ${entry.path}`);
    ids.add(entry.id);
    paths.add(entry.path);
  }
  return true;
}

function matches(entry, file) {
  if (entry.kind === "file") return file === entry.path;
  return file === entry.path || file.startsWith(entry.path + "/");
}

function classifyStatePath(value, registry = readRegistry()) {
  const file = normalizeStatePath(value);
  if (!file || file === ".." || file.startsWith("../") || file.includes("/../")) return null;
  const matchesList = registry.classes
    .filter((entry) => matches(entry, file))
    .sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length;
      if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  return matchesList.length > 0 ? matchesList[0] : null;
}

function isSyncablePolicy(policy) {
  return SYNCABLE_POLICIES.has(policy);
}

function isSyncableStatePath(value, registry = readRegistry()) {
  const entry = classifyStatePath(value, registry);
  return Boolean(entry && isSyncablePolicy(entry.sync_policy));
}

function syncablePathspecs(registry = readRegistry()) {
  const syncable = registry.classes.filter((entry) => isSyncablePolicy(entry.sync_policy));
  const directories = syncable
    .filter((entry) => entry.kind === "directory")
    .map((entry) => entry.path)
    .sort();
  const files = syncable
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path)
    .filter((file) => !directories.some((dir) => file.startsWith(dir + "/")))
    .sort();
  return { directories, files };
}

function registrySummary(registry = readRegistry()) {
  const counts = {};
  for (const entry of registry.classes) {
    counts[entry.sync_policy] = (counts[entry.sync_policy] || 0) + 1;
  }
  return {
    schema_version: registry.schema_version,
    total: registry.classes.length,
    policies: counts,
    syncable: registry.classes.filter((entry) => isSyncablePolicy(entry.sync_policy)).length,
  };
}

module.exports = {
  BUILTIN_REGISTRY_PATH,
  SYNCABLE_POLICIES,
  normalizeStatePath,
  readRegistry,
  validateRegistry,
  classifyStatePath,
  isSyncablePolicy,
  isSyncableStatePath,
  syncablePathspecs,
  registrySummary,
};
