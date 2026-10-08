#!/usr/bin/env node
"use strict";

// ─── Check L3 Distribution Boundary ───────────────────────────────────────────
// Pre-commit / pre-release gate that keeps cortex-agent's own L3 self-bootstrap
// content out of the L1 templates that ship to every managed project.
//
// Complements scripts/check-template-parity.js (which checks byte-parity across
// the three locale templates). This one checks the *scope* boundary between
// `<repo>/.agent/` (L3, never shipped) and `templates/**` (L1, always shipped).
//
// See .agent/rules/agent-scope.md for the ownership model this enforces.
//
// Run:
//   node scripts/check-l3-boundary.js [--verbose]
//
// Exit 0 = clean, exit 1 = violations found.

const path = require("node:path");
const { scanDistribution } = require("../lib/l3-boundary");

const ROOT = path.resolve(__dirname, "..");

function main() {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const { ok, checked, violations } = scanDistribution(ROOT);

  console.log(`\n🔒 L3 Distribution Boundary Report`);
  console.log(`   Files scanned: ${checked}`);
  console.log(`   Violations:    ${violations.length}`);

  if (violations.length === 0) {
    console.log(`\n✅ No L3 content found in the distribution path`);
    process.exit(0);
  }

  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }

  for (const [rule, items] of byRule) {
    console.log(`\n❌ ${rule} — ${items[0].title} (${items.length})`);
    for (const v of items) {
      console.log(`   ${v.file}:${v.line}  ${v.detail}`);
    }
  }

  console.log(
    `\n⚠️  These files are shipped to every managed project by \`cortex-agent init\`.`
  );
  console.log(
    `   L3 content must stay in <repo>/.agent/ and be marked \`scope: L3\`.`
  );
  console.log(`   See .agent/rules/agent-scope.md.`);
  if (verbose) {
    console.log(`\n   Set scope: L3 on the state-repo original, and remove any mirrored copy.`);
  }

  process.exit(1);
}

main();
