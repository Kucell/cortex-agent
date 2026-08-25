#!/usr/bin/env node
"use strict";

// ─── archive-token-attempts ─────────────────────────────────────────────────
// Zero-dependency helper that packs the project-local `token-attempts`
// receipts/ directory into a dated tar.gz archive under
// `token-attempts/archives/<YYYY-MM>/<YYYY-MM-DD>.tar.gz`.
//
// Git policy this enforces (see .agent/.gitignore):
//   - Raw runtime evidence (`receipts/`, `ledger-index.json`,
//     `recovery-events.jsonl`) is HIGH-FREQUENCY append-only state — local
//     only, never committed (thousands of tiny files churn the repo).
//   - `archives/` IS committed: one small compressed file per day carries the
//     full audit trail into git without the file-count problem.
//
// Usage:
//   node scripts/archive-token-attempts.js [--project-root DIR]
//       [--ledger-dir DIR] [--archive-name YYYY-MM-DD] [--delete-after]
//       [--dry-run]
//
// Behavior:
//   - Packs ALL files currently in `receipts/` into the dated archive
//     (same-day archives are (re)created, so repeated runs accumulate new
//     receipts under the same day).
//   - Default keeps the originals — online detail queries keep working.
//     `--delete-after` removes the packed originals to reclaim local space
//     (aggregations keep working: query reads ledger-index.json, which is
//     independent of the receipt bodies).
//   - Never touches git itself: stage and commit `archives/` yourself.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LEDGER_DIR = path.join(DEFAULT_PROJECT_ROOT, ".agent", "token-attempts");

// ─── CLI parsing (lightweight, no deps) ─────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    projectRoot: DEFAULT_PROJECT_ROOT,
    ledgerDir: null,
    archiveName: localDateString(),
    deleteAfter: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--project-root":
        opts.projectRoot = next();
        break;
      case "--ledger-dir":
        opts.ledgerDir = next();
        break;
      case "--archive-name":
        opts.archiveName = next();
        break;
      case "--delete-after":
        opts.deleteAfter = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`unknown option: ${arg}`);
        printHelp();
        process.exit(2);
    }
  }
  opts.ledgerDir = opts.ledgerDir || path.join(opts.projectRoot, ".agent", "token-attempts");
  return opts;
}

function printHelp() {
  console.log(`Usage: node archive-token-attempts.js [options]

Options:
  --project-root DIR   Project root (default: repo root).
  --ledger-dir DIR     Ledger dir (default: <projectRoot>/.agent/token-attempts).
  --archive-name DATE  Archive name YYYY-MM-DD (default: today, local time).
  --delete-after       Remove packed originals from receipts/ after a
                       successful archive (default: keep originals).
  --dry-run            Report what would be archived without writing anything.
  --help               Show this help.`);
}

function localDateString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── Core ───────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const receiptsDir = path.join(opts.ledgerDir, "receipts");
  const archivesDir = path.join(opts.ledgerDir, "archives");
  const monthDir = path.join(archivesDir, opts.archiveName.slice(0, 7));
  const archivePath = path.join(monthDir, `${opts.archiveName}.tar.gz`);

  if (!fs.existsSync(receiptsDir)) {
    console.log(`no ledger receipts dir at ${receiptsDir} — nothing to archive`);
    return;
  }
  const files = fs.readdirSync(receiptsDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("receipts/ is empty — nothing to archive");
    return;
  }

  const totalBytes = files.reduce((sum, f) => {
    try {
      return sum + fs.statSync(path.join(receiptsDir, f)).size;
    } catch {
      return sum;
    }
  }, 0);

  console.log(
    `archiving ${files.length} receipt file(s), ${formatBytes(totalBytes)} → ${archivePath}`,
  );
  if (opts.dryRun) {
    console.log("[dry-run] no archive written, originals untouched");
    return;
  }

  fs.mkdirSync(monthDir, { recursive: true });

  // tar -czf <archive> -C <receiptsDir> .  (system tar; no deps)
  execFileSync("tar", ["-czf", archivePath, "-C", receiptsDir, "."], {
    stdio: "ignore",
  });

  const archiveSize = fs.statSync(archivePath).size;
  console.log(
    `archive written: ${archivePath} (${formatBytes(archiveSize)}, ${Math.round(
      (totalBytes / Math.max(archiveSize, 1)) * 10,
    ) / 10}x smaller)`,
  );

  if (opts.deleteAfter) {
    let removed = 0;
    for (const f of files) {
      const p = path.join(receiptsDir, f);
      try {
        fs.unlinkSync(p);
        removed += 1;
      } catch (err) {
        console.error(`  ! could not remove ${p}: ${err.message}`);
      }
    }
    console.log(`removed ${removed} original(s) from receipts/ (index untouched)`);
  } else {
    console.log("originals kept (add --delete-after to reclaim local space)");
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

main();
