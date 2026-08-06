#!/usr/bin/env node
'use strict';
/**
 * validate-frontmatter.js
 * 校验 .agent/references/、.agent/workflows/、.agent/rules/ 下的 .md frontmatter
 * 必填字段缺失时 exit 1 并打印 violation list(阻塞)
 *
 * 配合 cortex-agent OKF 知识层提案 + M-018 mission (MS-002 F-004)。
 *
 * 用法:
 *   node .agent/scripts/validate-frontmatter.js                   # 校验三类
 *   node .agent/scripts/validate-frontmatter.js --type references  # 只校验 references
 *   node .agent/scripts/validate-frontmatter.js --type workflows
 *   node .agent/scripts/validate-frontmatter.js --type rules
 *   node .agent/scripts/validate-frontmatter.js --json           # JSON 输出
 *   node .agent/scripts/validate-frontmatter.js --help
 *
 * Exit codes:
 *   0 — 全部必填字段 OK
 *   1 — 至少一个 violation(必填字段缺失)
 */

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const typeArgIdx = process.argv.indexOf('--type');
const type = typeArgIdx !== -1 ? process.argv[typeArgIdx + 1] : 'all';
const fileArgIdx = process.argv.indexOf('--file');
const singleFile = fileArgIdx !== -1 ? process.argv[fileArgIdx + 1] : null;
const json = process.argv.includes('--json');
const help = process.argv.includes('--help') || process.argv.includes('-h');

if (help) {
  console.log(`validate-frontmatter.js

校验 references / workflows / rules 三类 frontmatter 必填字段。

USAGE:
  node .agent/scripts/validate-frontmatter.js [OPTIONS]

OPTIONS:
  --type references    只校验 .agent/references/*.md
  --type workflows     只校验 .agent/workflows/*.md
  --type rules         只校验 .agent/rules/*.md
  --type all           校验三类 (默认)
  --file <path>        校验单文件 (供 pre-commit hook 用), --type 自动从路径推断
  --json               JSON 输出
  --help, -h           显示此帮助

EXIT CODES:
  0  全部必填字段 OK
  1  至少一个 violation

OUTPUT:
  默认人类可读, --json 输出到 .agent/metrics/frontmatter-validation.json
  --file 模式: 输出到 stderr (供 hook 阻断), exit 1 if violation
`);
  process.exit(0);
}

if (!['all', 'references', 'workflows', 'rules'].includes(type)) {
  console.error(`❌ --type 必须是 all | references | workflows | rules, 收到: ${type}`);
  process.exit(1);
}

// ===== Frontmatter 解析(复用 F-001 / migrate-frontmatter.js 同款) =====

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(line.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '').trim());
    } else {
      const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (km) {
        currentKey = km[1];
        const v = km[2].trim();
        if (v === '' || v === undefined) fm[currentKey] = [];
        else if (v === '[]' || v === '[ ]') fm[currentKey] = [];
        else if (v.startsWith('[') && v.endsWith(']')) {
          fm[currentKey] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else fm[currentKey] = v.replace(/^["']|["']$/g, '');
      }
    }
  }
  return { frontmatter: fm, body: m[2] };
}

// ===== Schema 定义(必填字段) =====

const SCHEMAS = {
  references: {
    dir: path.join(root, '.agent', 'references'),
    required: ['module', 'module_path', 'module_type', 'keywords', 'status', 'owner', 'last_verified', 'sources'],
    // references 必须有 module 字段(OKF 模块风格的标志)
    detectSchema: (fm) => fm.module !== undefined,
  },
  workflows: {
    dir: path.join(root, '.agent', 'workflows'),
    required: ['description', 'type', 'applicable_to', 'owner', 'last_verified', 'status'],
    detectSchema: () => true, // workflows 全部参与校验
  },
  rules: {
    dir: path.join(root, '.agent', 'rules'),
    required: ['title', 'description', 'type', 'scope', 'applicable_to', 'owner', 'last_verified', 'status'],
    detectSchema: () => true, // rules 全部参与校验
  },
};

// ===== Main =====

// --file 模式: 单文件快速校验(供 pre-commit hook 用)
if (singleFile) {
  const filepath = path.isAbsolute(singleFile) ? singleFile : path.join(root, singleFile);
  if (!fs.existsSync(filepath)) {
    console.error(`❌ file not found: ${filepath}`);
    process.exit(1);
  }

  // 跳过 README.md (入口文件,不该校验)
  if (path.basename(filepath) === 'README.md') {
    process.exit(0);
  }

  // 推断 type (从路径匹配)
  let inferredType = null;
  if (filepath.includes(`${path.sep}.agent${path.sep}references${path.sep}`) || filepath.includes(`${path.sep}references${path.sep}`)) inferredType = 'references';
  else if (filepath.includes(`${path.sep}.agent${path.sep}workflows${path.sep}`) || filepath.includes(`${path.sep}workflows${path.sep}`)) inferredType = 'workflows';
  else if (filepath.includes(`${path.sep}.agent${path.sep}rules${path.sep}`) || filepath.includes(`${path.sep}rules${path.sep}`)) inferredType = 'rules';

  if (!inferredType) {
    console.error(`❌ cannot infer type from path: ${filepath} (must be under .agent/{references,workflows,rules}/)`);
    process.exit(1);
  }

  const schema = SCHEMAS[inferredType];
  const content = fs.readFileSync(filepath, 'utf8');
  const parsed = parseFrontmatter(content);

  if (!parsed) {
    console.error(`❌ [${inferredType}] ${path.relative(root, filepath)}: V-FM-001 no frontmatter block (--- 缺失)`);
    process.exit(1);
  }

  // schema 检测(references 必须有 module 字段)
  if (!schema.detectSchema(parsed.frontmatter)) {
    // 非 OKF 风格(如 production-readiness 报告)— 跳过
    process.exit(0);
  }

  const missing = schema.required.filter((k) => {
    const v = parsed.frontmatter[k];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    return false;
  });

  if (missing.length === 0) {
    process.exit(0);
  }

  // 输出到 stderr(供 hook 阻断显示)
  console.error(`❌ [${inferredType}] ${path.relative(root, filepath)}: V-FM-002 missing required fields: ${missing.join(', ')}`);
  process.exit(1);
}

const typesToRun = type === 'all' ? ['references', 'workflows', 'rules'] : [type];

const report = {
  scan: 'validate-frontmatter',
  generated_at: new Date().toISOString(),
  types_scanned: typesToRun,
  summary: { total_files: 0, total_violations: 0 },
  violations: [],
};

// 跟踪每个 type 的文件数
const perType = {};

for (const t of typesToRun) {
  const schema = SCHEMAS[t];
  if (!fs.existsSync(schema.dir)) {
    if (!json) console.error(`⚠️  ${schema.dir} 不存在, 跳过`);
    continue;
  }

  const files = fs.readdirSync(schema.dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  perType[t] = { files: files.length, violations: 0, skipped: 0 };

  for (const file of files) {
    const filepath = path.join(schema.dir, file);
    const content = fs.readFileSync(filepath, 'utf8');
    const parsed = parseFrontmatter(content);

    // 无 frontmatter
    if (!parsed) {
      report.violations.push({
        type: t,
        file: path.relative(root, filepath),
        severity: 'error',
        rule_id: 'V-FM-001',
        message: 'no frontmatter block (--- 缺失)',
      });
      report.summary.total_violations++;
      perType[t].violations++;
      report.summary.total_files++;
      continue;
    }

    // schema 检测(references 必须是 OKF 模块风格)
    if (!schema.detectSchema(parsed.frontmatter)) {
      // 非 OKF 风格文件(如 production-readiness 报告)跳过
      perType[t].skipped++;
      continue;
    }

    // 校验必填字段
    const missing = schema.required.filter((k) => {
      const v = parsed.frontmatter[k];
      if (v === undefined || v === null) return true;
      if (typeof v === 'string' && v.trim() === '') return true;
      return false;
    });

    report.summary.total_files++;
    if (missing.length > 0) {
      report.violations.push({
        type: t,
        file: path.relative(root, filepath),
        severity: 'error',
        rule_id: 'V-FM-002',
        missing_fields: missing,
        message: `missing required fields: ${missing.join(', ')}`,
      });
      report.summary.total_violations++;
      perType[t].violations++;
    }
  }
}

// 输出
if (json) {
  const outDir = path.join(root, '.agent', 'metrics');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'frontmatter-validation.json');
  report.per_type = perType;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`JSON output: ${path.relative(root, outPath)}`);
  console.log(`Files: ${report.summary.total_files}, Violations: ${report.summary.total_violations}`);
  process.exit(report.summary.total_violations > 0 ? 1 : 0);
}

// 人类可读输出
console.log('--- ✅ Frontmatter Validation ---');
for (const t of typesToRun) {
  if (!perType[t]) continue;
  const p = perType[t];
  console.log(`[${t}] ${p.files} files, ${p.violations} violations, ${p.skipped} skipped`);
}
console.log(`\nTotal: ${report.summary.total_files} files, ${report.summary.total_violations} violations`);

if (report.violations.length === 0) {
  console.log('✅ All required fields present');
  process.exit(0);
}

console.log(`\n❌ ${report.violations.length} violation(s):`);
for (const v of report.violations) {
  console.log(`  [${v.type}] ${v.file}`);
  console.log(`    ${v.rule_id}: ${v.message}`);
}

process.exit(1);
