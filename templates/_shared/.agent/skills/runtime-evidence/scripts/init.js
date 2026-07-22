const fs = require('fs');
const path = require('path');

const root = process.cwd();
const metricsDir = path.join(root, '.agent', 'metrics');

const NOW = new Date().toISOString();

const DEFAULTS = {
  'verification-summary.json': {
    generated_at: NOW,
    triggered_by: 'init',
    overall_status: 'not_run',
    coverage: {
      ui: 'skipped',
      api: 'skipped',
      trace: 'skipped',
    },
    results: {
      ui: {
        status: 'not_run',
        paths_checked: 0,
        screenshot_paths: [],
      },
      api: {
        status: 'not_run',
        endpoints_checked: 0,
        error_rate_delta: null,
      },
      trace: {
        status: 'skipped',
        reason: 'not yet initialized',
      },
    },
    blockers: [],
    warnings: [],
  },
  'runtime-health.json': {
    generated_at: NOW,
    triggered_by: 'init',
    status: 'not_run',
    endpoints: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      error_rate: null,
    },
    logs: {
      error_count: 0,
      warn_count: 0,
      new_patterns: [],
    },
  },
  'browser-verification.json': {
    generated_at: NOW,
    triggered_by: 'init',
    status: 'not_run',
    environment: null,
    tool: null,
    paths: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
    },
    screenshot_paths: [],
    console_errors: [],
  },
};

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function run() {
  ensureDir(metricsDir);

  console.log('--- Runtime Evidence Init ---');

  for (const [filename, defaultPayload] of Object.entries(DEFAULTS)) {
    const filePath = path.join(metricsDir, filename);

    if (fs.existsSync(filePath)) {
      console.log(`[skip]   ${filename} (already exists)`);
    } else {
      writeJson(filePath, defaultPayload);
      console.log(`[created] ${filename}`);
    }
  }

  console.log(`\nOutput dir: ${path.relative(root, metricsDir)}`);
}

run();
