"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.(?:js|cjs|mjs|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function fail(violations, rule, file, detail) {
  violations.push({ rule, file: relative(file), detail });
}

function scanTextFiles(dir, callback) {
  for (const file of walk(path.join(ROOT, dir))) {
    callback(file, fs.readFileSync(file, "utf8"));
  }
}

function runArchitectureGuard() {
  const violations = [];

  scanTextFiles("packages/protocol/src", (file, text) => {
    for (const token of ["@getpaseo/", "paseo", "axrail", "../../lib", "node:fs", "child_process"]) {
      if (text.toLowerCase().includes(token.toLowerCase())) {
        fail(violations, "protocol-portability", file, `forbidden token: ${token}`);
      }
    }
  });

  scanTextFiles("packages/sdk/src", (file, text) => {
    for (const token of ["node:fs", ".agent/", ".agent-runtime/", "../../lib"]) {
      if (text.includes(token)) fail(violations, "sdk-no-persistence", file, `forbidden token: ${token}`);
    }
  });

  scanTextFiles("packages/runtime-port/src", (file, text) => {
    for (const token of ["@getpaseo/", "paseo", "axrail", "../../lib", ".agent/"]) {
      if (text.toLowerCase().includes(token.toLowerCase())) {
        fail(violations, "runtime-port-neutrality", file, `forbidden token: ${token}`);
      }
    }
  });

  scanTextFiles("packages/project-sdk/src", (file, text) => {
    for (const token of ["@getpaseo/", "paseo", "axrail"]) {
      if (text.toLowerCase().includes(token.toLowerCase())) {
        fail(violations, "project-sdk-neutrality", file, `forbidden token: ${token}`);
      }
    }
  });

  const rootPkgFile = path.join(ROOT, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgFile, "utf8"));
  if (Array.isArray(rootPkg.files) && rootPkg.files.some((item) =>
    item === ".agent" || item.startsWith(".agent/"))) {
    fail(
      violations,
      "governance-repo-not-packaged",
      rootPkgFile,
      "root npm package must not ship the independent cortex-agent-agent/.agent governance repository",
    );
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (rootPkg[field] && rootPkg[field]["@getpaseo/client"]) {
      fail(violations, "paseo-optional-root", rootPkgFile, `Paseo declared in root ${field}`);
    }
  }

  const paseoPkgFile = path.join(ROOT, "packages", "runtime-paseo", "package.json");
  const paseoPkg = JSON.parse(fs.readFileSync(paseoPkgFile, "utf8"));
  if (!paseoPkg.peerDependenciesMeta
    || !paseoPkg.peerDependenciesMeta["@getpaseo/client"]
    || paseoPkg.peerDependenciesMeta["@getpaseo/client"].optional !== true) {
    fail(violations, "paseo-optional-peer", paseoPkgFile, "Paseo client peer must be optional");
  }

  const workspaceFile = path.join(ROOT, "pnpm-workspace.yaml");
  const workspace = fs.readFileSync(workspaceFile, "utf8");
  if (!/autoInstallPeers:\s*false/.test(workspace)) {
    fail(violations, "optional-peer-install", workspaceFile, "autoInstallPeers must remain false");
  }

  const controlFile = path.join(ROOT, "lib", "control-service", "service.js");
  const controlText = fs.readFileSync(controlFile, "utf8");
  for (const token of ["node:fs", "child_process", ".agent/", ".agent-runtime/"]) {
    if (controlText.includes(token)) fail(violations, "control-no-state-owner", controlFile, token);
  }

  const queryFile = path.join(ROOT, "lib", "commands", "management", "query.js");
  const queryText = fs.readFileSync(queryFile, "utf8");
  if (!queryText.includes("createLocalCortexClient") || queryText.includes("queryManagementProject")) {
    fail(violations, "sdk-surface-migration", queryFile, "Management query must route through SDK");
  }

  const governanceFile = path.join(ROOT, "packages", "runtime-paseo", "src", "governance-surface.js");
  const governanceText = fs.readFileSync(governanceFile, "utf8");
  for (const token of ["node:fs", "child_process", ".agent/", ".agent-runtime/"]) {
    if (governanceText.includes(token)) {
      fail(violations, "governance-surface-readonly", governanceFile, token);
    }
  }

  return { ok: violations.length === 0, violations };
}

if (require.main === module) {
  const result = runArchitectureGuard();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}

module.exports = { runArchitectureGuard };
