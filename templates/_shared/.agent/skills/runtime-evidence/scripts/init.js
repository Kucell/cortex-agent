/**
 * init.js
 *
 * 建立 runtime-evidence 的三件套空壳，并导出统一的空壳结构。
 *
 * 三件套（均写在 .agent/metrics/ 下）：
 *   - verification-summary.json   验证结果汇总（overall_status 的唯一所有者）
 *   - runtime-health.json         端点健康度
 *   - browser-verification.json   浏览器层验证（CLI 项目为合理占位）
 *
 * 契约分工（为什么空壳要由本文件统一提供）：
 *   verification-summary.json 有两个生产方——本文件建空壳，
 *   runtime-evidence runner 写真实结论，generate-summary.js 补仓库健康度。
 *   三者写同一个文件，所以空壳结构只能有一份定义，否则迟早出现
 *   「某一方写出的字段被另一方悄悄丢掉」。本文件导出 buildDefaults()，
 *   generate-summary.js 直接复用，避免第二份定义。
 *
 * 零外部依赖，仅使用 Node.js built-in。
 */

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const metricsDir = path.join(root, '.agent', 'metrics');

/**
 * 构造三件套的空壳。now 由调用方传入，保证同一批产物的时间戳一致。
 * @param {string} now ISO 时间戳
 * @returns {Record<string, object>}
 */
function buildDefaults(now) {
  return {
    'verification-summary.json': {
      generated_at: now,
      triggered_by: 'init',
      // 空壳永远是 not_run：没有跑过验证就没有验证结论。
      // 「仓库健康」不能被读成「应用已验证」——那是两件事。
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
          cases_checked: 0,
          passed_assertions: 0,
          total_assertions: 0,
          error_rate_delta: null,
        },
        trace: {
          status: 'skipped',
          reason: 'runtime-evidence 数据集不覆盖 trace 层',
        },
      },
      blockers: [],
      warnings: [],
    },
    'runtime-health.json': {
      generated_at: now,
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
      generated_at: now,
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
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function run() {
  ensureDir(metricsDir);

  console.log('--- Runtime Evidence Init ---');

  const defaults = buildDefaults(new Date().toISOString());
  for (const [filename, defaultPayload] of Object.entries(defaults)) {
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

if (require.main === module) {
  run();
}

module.exports = { buildDefaults, run };
