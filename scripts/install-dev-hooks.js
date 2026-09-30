#!/usr/bin/env node
"use strict";

// ─── install-dev-hooks ───────────────────────────────────────────────────────
// Installs the tracked git pre-commit hook (hooks/git/pre-commit) into
// .git/hooks/pre-commit.
//
// Why this exists: `.git/` is not version-controlled, so a hook edited in place
// only ever applies to the machine that wrote it. Keeping the hook body in
// `hooks/git/pre-commit` and installing it makes the gate survive a fresh clone.
//
// Run:
//   node scripts/install-dev-hooks.js           # install / refresh
//   node scripts/install-dev-hooks.js --check   # report drift, write nothing
//   node scripts/install-dev-hooks.js --uninstall
//   node scripts/install-dev-hooks.js --root <dir>   # target another checkout
//
// `--root` exists so the installer can be exercised in a scratch directory by
// tests without clobbering the developer's real .git/hooks/pre-commit.
//
// Ownership: L3. This is cortex-agent's own development gate and is not part of
// the distributed L1 templates (see .agent/rules/agent-scope.md).

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const SOURCE_REL = path.join("hooks", "git", "pre-commit");
const TARGET_REL = path.join(".git", "hooks", "pre-commit");

// Resolved once at startup so every helper below agrees on the target.
let ROOT = DEFAULT_ROOT;
let SOURCE = "";
let TARGET = "";

function configure(root) {
  ROOT = root;
  SOURCE = path.join(ROOT, SOURCE_REL);
  TARGET = path.join(ROOT, TARGET_REL);
}

function readSource() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`❌ tracked hook source missing: ${path.relative(ROOT, SOURCE)}`);
    process.exit(1);
  }
  return fs.readFileSync(SOURCE);
}

function currentTarget() {
  try {
    return fs.readFileSync(TARGET);
  } catch {
    return null;
  }
}

function isUpToDate() {
  const current = currentTarget();
  if (current === null) return false;
  return current.equals(readSource());
}

function install() {
  const body = readSource();
  const existing = currentTarget();
  if (existing !== null && !existing.equals(body)) {
    const backup = `${TARGET}.bak`;
    fs.writeFileSync(backup, existing);
    console.log(`🔁 existing hook differs — previous version saved to ${path.relative(ROOT, backup)}`);
  }
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, body, { mode: 0o755 });
  fs.chmodSync(TARGET, 0o755);
  console.log(`✅ installed ${path.relative(ROOT, TARGET)}`);
  console.log("   gates: L3 distribution boundary + per-file checks + memory integrity");
}

function check() {
  if (currentTarget() === null) {
    console.log(`❌ no hook installed at ${path.relative(ROOT, TARGET)}`);
    console.log("   run: node scripts/install-dev-hooks.js");
    process.exitCode = 1;
    return;
  }
  if (isUpToDate()) {
    console.log(`✅ ${path.relative(ROOT, TARGET)} is up to date`);
    return;
  }
  console.log(`⚠️  ${path.relative(ROOT, TARGET)} has drifted from the tracked source`);
  console.log("   run: node scripts/install-dev-hooks.js");
  process.exitCode = 1;
}

function uninstall() {
  if (currentTarget() === null) {
    console.log("ℹ️  no hook installed — nothing to do");
    return;
  }
  fs.unlinkSync(TARGET);
  console.log(`🗑️  removed ${path.relative(ROOT, TARGET)}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/install-dev-hooks.js [--check | --uninstall] [--root <dir>]");
    return;
  }
  const rootIdx = args.indexOf("--root");
  configure(rootIdx !== -1 && args[rootIdx + 1] ? path.resolve(args[rootIdx + 1]) : DEFAULT_ROOT);
  if (args.includes("--uninstall")) return uninstall();
  if (args.includes("--check")) return check();
  return install();
}

main();
