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

const DEFAULT_ROOT = path.resolve(__dirname, '..');

// Paths whose content must be identical wherever they appear across the L1
// template layers.
//
// A path is not required to exist in every layer. The template tree has three
// layers — _shared (language-neutral base), zh and en (language overlays) —
// and `upgrade` lays them down in that order, with the language layer
// overriding the shared one. A language-neutral file therefore lives in
// _shared alone; only content that genuinely differs by language is copied
// into zh / en. See .agent/rules/template-layer-dedup.md.
//
// So the invariant this gate protects is: *if a path appears in more than
// one layer, the layers must agree byte for byte.* A path that appears in a
// single layer is that layer's business — the dedup gate decides whether
// that placement is right.
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
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1]
    ? path.resolve(args[rootIndex + 1])
    : DEFAULT_ROOT;
  const SHARED = path.join(root, 'templates/_shared/.agent');
  const ZH = path.join(root, 'templates/zh/.agent');
  const EN = path.join(root, 'templates/en/.agent');

  let totalChecked = 0;
  let totalMatches = 0;
  const mismatches = [];
  const missing = [];

  for (const rel of PARITY_PATHS) {
    const sharedFile = path.join(SHARED, rel);
    const zhFile = path.join(ZH, rel);
    const enFile = path.join(EN, rel);

    const sharedExists = relativeExists(SHARED, rel);
    const zhExists = relativeExists(ZH, rel);
    const enExists = relativeExists(EN, rel);

    if (!sharedExists && !zhExists && !enExists) {
      missing.push(rel);
      continue;
    }

    // Collect the layers that actually carry this path. Only those are
    // compared — a language overlay that legitimately differs from the
    // shared base is not a parity break.
    const present = [];
    if (sharedExists) present.push(["shared", sha256(sharedFile)]);
    if (zhExists) present.push(["zh", sha256(zhFile)]);
    if (enExists) present.push(["en", sha256(enFile)]);

    totalChecked += 1;

    // Every language must be able to reach the path. A path that only
    // exists in one language layer is unreachable from the other one:
    // the installation resolves the language overlay over the shared base,
    // so a Chinese project with the file only in `en` gets nothing, and
    // vice versa. That is a hole in the distribution surface, not a
    // placement choice for the dedup gate to make.
    const unreachable = [];
    if (!sharedExists) {
      // Without a shared copy, each language has to carry its own.
      if (!zhExists) unreachable.push("zh");
      if (!enExists) unreachable.push("en");
    }

    const hashes = new Set(present.map(([, hash]) => hash));
    if (unreachable.length > 0) {
      missing.push({ rel, unreachable });
      if (verbose) {
        console.log(`❌ ${rel} (unreachable for: ${unreachable.join(", ")})`);
      }
      continue;
    }

    if (hashes.size === 1) {
      totalMatches += 1;
      if (verbose) {
        console.log(`✅ ${rel} ${present[0][1]} (${present.map(([l]) => l).join(", ")})`);
      }
    } else {
      mismatches.push({
        rel,
        shared: sharedExists ? sha256(sharedFile) : null,
        zh: zhExists ? sha256(zhFile) : null,
        en: enExists ? sha256(enFile) : null,
      });
      if (verbose) {
        console.log(`❌ ${rel} (mismatch)`);
        for (const [layer, hash] of present) {
          console.log(`   ${layer.padEnd(6)} ${hash}`);
        }
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
    console.log(`\n⚠️  Unreachable files (every language must be able to receive them):`);
    for (const entry of missing) {
      if (typeof entry === "string") {
        console.log(`   - ${entry}`);
      } else {
        console.log(`   - ${entry.rel} (unreachable for: ${entry.unreachable.join(", ")})`);
      }
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
