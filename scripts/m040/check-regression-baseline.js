"use strict";

const fs = require("node:fs");

const BASELINE_SHA = "d9251d953a8b663b86b7712624baaac649924e46";
const BASELINE_FAILURES = Object.freeze([
  "agent/agent-cli.test.js",
  "agent/agent-m003-cli.test.js",
  "claude-hook/claude-hook-cli.test.js",
  "cli/cli-contract.test.js",
  "commands/doctor.test.js",
  "communication/communication-template-parity.test.js",
  "cursor/cursor-runtime-adapter.test.js",
  "governed/governed-launcher.test.js",
  "management/transcript-link.test.js",
  "missions/opt-in-runtime-feedback-pilot.test.js",
  "runtime-adapters/index.test.js",
  "runtime-layout/runtime-layout.test.js",
  "scripts/token-savings-demo.test.js",
  "setup/init-shared-skills-link.test.js",
]);

function parseFailures(text) {
  const found = [];
  const seen = new Set();
  const pattern = /✗ FAIL\s+([^\s]+\.test\.js)\b/g;
  let match;
  while ((match = pattern.exec(text))) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      found.push(match[1]);
    }
  }
  return found.sort();
}

function compareFailures(actual) {
  const baseline = new Set(BASELINE_FAILURES);
  const current = new Set(actual);
  const unexpected = actual.filter((item) => !baseline.has(item));
  const healed = BASELINE_FAILURES.filter((item) => !current.has(item));
  const remainingBaseline = BASELINE_FAILURES.filter((item) => current.has(item));

  return {
    baseline_sha: BASELINE_SHA,
    baseline_failure_count: BASELINE_FAILURES.length,
    current_failure_count: actual.length,
    unexpected_failures: unexpected,
    healed_baseline_failures: healed,
    remaining_baseline_failures: remainingBaseline,
    regression_free: unexpected.length === 0,
  };
}

if (require.main === module) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("Usage: node check-regression-baseline.js <test-log>\n");
    process.exit(2);
  }
  const result = compareFailures(parseFailures(fs.readFileSync(path, "utf8")));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.regression_free) process.exitCode = 1;
}

module.exports = {
  BASELINE_SHA,
  BASELINE_FAILURES,
  parseFailures,
  compareFailures,
};
