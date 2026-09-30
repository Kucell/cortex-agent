"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const tarballs = process.argv.slice(2);
if (tarballs.length === 0) {
  throw new Error("tarball paths required");
}

const forbidden = [
  /^package\/\.agent(?:\/|$)/,
  /^package\/lib(?:\/|$)/,
  /^package\/tests(?:\/|$)/,
  /^package\/\.github(?:\/|$)/,
];

const report = [];

for (const tarball of tarballs) {
  const output = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  const entries = output.split(/\r?\n/).filter(Boolean);
  const violations = [];
  for (const entry of entries) {
    for (const pattern of forbidden) {
      if (pattern.test(entry)) violations.push(entry);
    }
  }
  const packageJsonEntry = entries.find((entry) => entry === "package/package.json");
  if (!packageJsonEntry) violations.push("package/package.json missing");
  if (!entries.some((entry) => entry === "package/src/index.js")) {
    violations.push("package/src/index.js missing");
  }

  report.push({
    tarball: path.basename(tarball),
    entries: entries.length,
    violations,
  });
}

const failed = report.flatMap((item) =>
  item.violations.map((violation) => `${item.tarball}: ${violation}`));

process.stdout.write(JSON.stringify({ ok: failed.length === 0, report, failed }, null, 2) + "\n");
if (failed.length) process.exitCode = 1;
