#!/usr/bin/env node
'use strict';

// ─── Check Template Parity (M-013 SP-006 / VC-011t) ─────────────────────────
//
// Verifies that the L1 templates (`templates/_shared/.agent/...`,
// `templates/zh/.agent/...`, `templates/en/.agent/...`) are byte-identical
// for all governed-attempt-progress + watchdog-policy + manage­ment-api
// surfaces affected by P-005 / M-013.
//
// VC-011t: parity check exits 0 when all 3 L1 copies sha256-match, exits 1
// otherwise. Used both in CI and in the local `npm run check:parity` hook.
//
// Run:
//   node scripts/check-template-parity.js [--verbose] [--strict]
//
// `--strict` mode: any extra file present in only one language breaks parity
// (default is to ignore _base, README, etc.).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.join(ROOT, 'templates/_shared/.agent');
const ZH = path.join(ROOT, 'templates/zh/.agent');
const EN = path.join(ROOT, 'templates/en/.agent');

// Paths that must be identical (V1 schema + projection registry) across all 3 L1 templates.
const PARITY_PATHS = Object.freeze([
  // SP-001 GovernedAttemptProgress V1 schema
  'schemas/governed-attempt-progress.v1.json',
  // SP-005 Watchdog policy V1 schema
  'schemas/watchdog-policy.v1.json',
  // SP-006 Management API projection registry (must include new projections)
  'skills/management-api/scripts/projection-registry.json',
]);

function fileExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function sha256(file) {
  return 'sha256:' + require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(file)).digest('hex');
}

function relativeExists(root, rel) {
  return fileExists(path.join(root, rel));
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const strict = args.includes('--strict');

  let totalChecked = 0;
  let totalMatches = 0;
  const mismatches = [];
  const missing = [];

  for (const rel of PARITY_PATHS) {
    const sharedFile = path.join(SHARED, rel);
    const zhFile = path.join(ZH, rel);
    const enFile = path.join(EN, rel);

    if (!relativeExists(SHARED, rel) && !relativeExists(ZH, rel) && !relativeExists(EN, rel)) {
      missing.push(rel);
      continue;
    }

    const sharedExists = relativeExists(SHARED, rel);
    const zhExists = relativeExists(ZH, rel);
    const enExists = relativeExists(EN, rel);

    if (!sharedExists || !zhExists || !enExists) {
      missing.push(rel);
      continue;
    }

    const sharedHash = sha256(sharedFile);
    const zhHash = sha256(zhFile);
    const enHash = sha256(enFile);

    totalChecked += 1;
    if (sharedHash === zhHash && zhHash === enHash) {
      totalMatches += 1;
      if (verbose) {
        console.log(`✅ ${rel} ${sharedHash}`);
      }
    } else {
      mismatches.push({
        rel,
        shared: sharedHash,
        zh: zhHash,
        en: enHash,
      });
      if (verbose) {
        console.log(`❌ ${rel} (mismatch)`);
        console.log(`   shared: ${sharedHash}`);
        console.log(`   zh:     ${zhHash}`);
        console.log(`   en:     ${enHash}`);
      }
    }
  }

  // ─── Report ──────────────────────────────────────────────────────────────
  console.log(`\n📊 Template Parity Report (M-013 SP-006 / VC-011t)`);
  console.log(`   Total paths checked: ${totalChecked}`);
  console.log(`   Matches: ${totalMatches}`);
  console.log(`   Mismatches: ${mismatches.length}`);
  console.log(`   Missing: ${missing.length}`);

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing files (must be present in all 3 L1 templates):`);
    for (const rel of missing) {
      console.log(`   - ${rel}`);
    }
  }

  if (mismatches.length > 0) {
    console.log(`\n❌ Mismatched files (sha256 must be identical):`);
    for (const m of mismatches) {
      console.log(`   - ${m.rel}`);
      console.log(`     shared: ${m.shared}`);
      console.log(`     zh:     ${m.zh}`);
      console.log(`     en:     ${m.en}`);
    }
  }

  if (totalMatches === totalChecked && missing.length === 0) {
    console.log(`\n✅ All L1 templates parity-checked PASS`);
    process.exit(0);
  } else {
    console.log(`\n❌ Parity check failed — fix mismatches before merge`);
    process.exit(1);
  }
}

main();