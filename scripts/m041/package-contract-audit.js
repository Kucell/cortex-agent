"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

const PACKAGE_DECISIONS = Object.freeze({
  "@cortex-agent/protocol": "public-candidate",
  "@cortex-agent/sdk": "public-candidate",
  "@cortex-agent/runtime-port": "public-candidate",
  "@cortex-agent/project-sdk": "public-candidate",
  "@cortex-agent/extension-sdk": "public-candidate",
  "@cortex-agent/runtime-paseo": "deferred-public-candidate",
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function auditPackage(pkgDir) {
  const file = path.join(pkgDir, "package.json");
  const pkg = readJson(file);
  const issues = [];

  if (!pkg.name || !PACKAGE_DECISIONS[pkg.name]) {
    issues.push("package is missing an M-041 publication decision");
  }
  if (!pkg.exports || !Object.prototype.hasOwnProperty.call(pkg.exports, ".")) {
    issues.push("root export is missing");
  }
  if (!pkg.engines || typeof pkg.engines.node !== "string") {
    issues.push("Node engine contract is missing");
  }

  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] || {})) {
      if (name.startsWith("@cortex-agent/") && !PACKAGE_DECISIONS[name]) {
        issues.push(`dependency ${name} is not an approved public/deferred package boundary`);
      }
    }
  }

  return {
    name: pkg.name,
    version: pkg.version,
    private: pkg.private === true,
    decision: PACKAGE_DECISIONS[pkg.name] || null,
    root_export: pkg.exports && pkg.exports["."] || null,
    node_engine: pkg.engines && pkg.engines.node || null,
    issues,
  };
}

function auditRootPackage() {
  const pkg = readJson(path.join(ROOT, "package.json"));
  const issues = [];
  const files = Array.isArray(pkg.files) ? pkg.files : [];

  if (files.some((entry) => entry === ".agent" || entry.startsWith(".agent/"))) {
    issues.push("root package must not publish the independent .agent governance repository");
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg[field] && pkg[field]["@getpaseo/client"]) {
      issues.push("root package must not require Paseo client");
    }
  }

  return {
    name: pkg.name,
    version: pkg.version,
    issues,
  };
}

function runPackageContractAudit() {
  const packagesRoot = path.join(ROOT, "packages");
  const packages = fs.readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => auditPackage(path.join(packagesRoot, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const expected = Object.keys(PACKAGE_DECISIONS).sort();
  const actual = packages.map((item) => item.name).sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const unknown = actual.filter((name) => !expected.includes(name));

  const root = auditRootPackage();
  const issues = [
    ...missing.map((name) => `missing package: ${name}`),
    ...unknown.map((name) => `unclassified package: ${name}`),
    ...root.issues.map((issue) => `root: ${issue}`),
    ...packages.flatMap((item) =>
      item.issues.map((issue) => `${item.name}: ${issue}`)),
  ];

  return {
    ok: issues.length === 0,
    policy: {
      publication_during_ms001: false,
      initial_version: "0.0.0",
      root_export_only: true,
      semver_after_publication: true,
      protocol_major_requires_migration: true,
    },
    root,
    packages,
    issues,
  };
}

if (require.main === module) {
  const result = runPackageContractAudit();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}

module.exports = {
  PACKAGE_DECISIONS,
  runPackageContractAudit,
};
