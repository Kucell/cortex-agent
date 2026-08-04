#!/usr/bin/env node
"use strict";

// ─── M-011 Safe Probe (ARI P-005) ─────────────────────────────────────────
// ARI P-005 frozen proposal:
//   .agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-005-minimax-cli-governed-tool-adapter-proposal.md
// Frozen SHA-256:
//   f377943b6eb73d44308a86d965229730ba2552613ae611e3e511457c13f4587d
//
// Usage:
//   node scripts/m011-safe-probe.js [--out-dir <evidence/path>] [--binary <path>]
//
// Behaviour:
//   - Invokes ONLY the three allow-listed mmx command families:
//       mmx --version
//       mmx --help
//       mmx <resource> --help
//   - Forces auth_state="unknown" via capability-contract.
//   - Persists:
//       host-probe.json          — binary presence + trimmed version line
//       capability-snapshot.json — validated MiniMaxCliCapabilitySnapshot
//   - Refuses to invoke any other mmx subcommand and refuses to read
//     /Users/xueyq/.mmx/* or env MINIMAX_API_KEY / MINIMAX_TOKEN.

const fs = require("node:fs");
const path = require("node:path");

const probeMod = require("../lib/runtime-adapters/minimax-cli-probe");
const capabilityContract = require("../lib/runtime-adapters/minimax-cli-capability-contract");

const DEFAULT_OUT_DIR = path.join(__dirname, "..", ".agent", "missions", "M-011", "evidence");

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT_DIR, binary: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out-dir") {
      args.outDir = path.resolve(argv[++i]);
    } else if (a === "--binary") {
      args.binary = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    "M-011 Safe Probe (ARI P-005)",
    "",
    "Usage:",
    "  node scripts/m011-safe-probe.js [--out-dir <evidence/path>] [--binary <path>]",
    "",
    "Allow-listed mmx command families (exactly three):",
    "  1. mmx --version",
    "  2. mmx --help",
    "  3. mmx <resource> --help",
    "",
    "Output:",
    "  <outDir>/host-probe.json",
    "  <outDir>/capability-snapshot.json",
    "",
  ].join("\n"));
}

function ensureOutDir(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Taint scan: refuse to write any file containing a taint pattern. This is a
// belt-and-suspenders guard around evidence persistence.
const TAINT_PATTERNS = capabilityContract.TAINT_PATTERNS;
function assertNoTaint(text, where) {
  for (const rule of TAINT_PATTERNS) {
    if (rule.regex.test(text)) {
      throw new Error(`refusing to write ${where}: taint pattern ${rule.id}`);
    }
  }
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  const json = JSON.stringify(value, null, 2);
  assertNoTaint(json, filePath);
  fs.writeFileSync(tmp, json, "utf8");
  fs.renameSync(tmp, filePath);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  ensureOutDir(args.outDir);

  const probeOptions = {};
  if (args.binary) probeOptions.binary = args.binary;

  const snapshot = probeMod.runSafeProbe(probeOptions);

  // probe_command_log entries are produced by safeExec -> buildArgs, which
  // already enforces the 3-family allow-list (any non-allow-listed family
  // raises MiniMaxCliProbeError before exec). No additional re-check needed.

  // host-probe.json: binary metadata + trimmed version. No help text.
  const hostProbe = {
    schema_version: "1.0",
    probed_at: snapshot.probe_at,
    binary: {
      available: snapshot.binary.available,
      version: snapshot.binary.version,
      source: snapshot.binary.source,
    },
    binary_summary: probeMod.summarizeBinaryAvailability(snapshot),
    auth_state: snapshot.auth_state,
    auth_state_reason: snapshot.auth_state_reason,
    probe_families: snapshot.probe_families.slice(),
    probe_command_log: snapshot.probe_command_log.slice(),
    no_credential: true,
    note: "M-011 safe-probe allow-list: mmx --version / mmx --help / mmx <resource> --help. Help stdout is NOT persisted.",
  };

  const hostProbePath = path.join(args.outDir, "host-probe.json");
  const snapshotPath = path.join(args.outDir, "capability-snapshot.json");

  writeJsonAtomic(hostProbePath, hostProbe);
  writeJsonAtomic(snapshotPath, snapshot);

  process.stdout.write(JSON.stringify({
    ok: true,
    host_probe: path.relative(process.cwd(), hostProbePath),
    capability_snapshot: path.relative(process.cwd(), snapshotPath),
    binary: hostProbe.binary,
    auth_state: hostProbe.auth_state,
    probe_families: hostProbe.probe_families,
  }, null, 2) + "\n");
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`m011-safe-probe failed: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

module.exports = {
  parseArgs,
  ensureOutDir,
  assertNoTaint,
  writeJsonAtomic,
  main,
};