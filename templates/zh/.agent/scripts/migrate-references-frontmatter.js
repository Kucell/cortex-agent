#!/usr/bin/env node
'use strict';
/**
 * migrate-references-frontmatter.js
 * 把 .agent/references/*.md 的 frontmatter 升级到 OKF V0.2 模板
 * (status / sources / last_verified / verified_by / owner / linked_decisions / deprecation_reason)
 *
 * 配合 cortex-agent OKF 知识层提案 (.agent/plans/proposals/okf-knowledge-layer/)
 * 和 M-018 mission (MS-001 F-001)。
 *
 * 用法:
 *   node .agent/scripts/migrate-references-frontmatter.js          # dry-run (默认)
 *   node .agent/scripts/migrate-references-frontmatter.js --apply  # 实际写入
 *   node .agent/scripts/migrate-references-frontmatter.js --help   # 帮助
 *
 * Exit codes:
 *   0 — 成功(dry-run 无修改 / apply 全部成功,或有 warning 但完成)
 *   1 — 错误(parse 失败 / 阻断性 violation)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = process.cwd();
const referencesDir = path.join(root, '.agent', 'references');
const apply = process.argv.includes('--apply');
const help = process.argv.includes('--help') || process.argv.includes('-h');
// --recursive 默认 true,扫 external/; --no-recursive 关闭
const recursive = !process.argv.includes('--no-recursive');
// --include-experimental 默认 false,允许 apply 报告/research 类非 OKF 文件
const includeExperimental = process.argv.includes('--include-experimental');

if (help) {
  console.log(`migrate-references-frontmatter.js

升级 .agent/references/*.md frontmatter 到 OKF V0.2 模板。

USAGE:
  node .agent/scripts/migrate-references-frontmatter.js [OPTIONS]

OPTIONS:
  --apply                实际写入文件 (默认 dry-run)
  --no-recursive         不递归 external/ 子目录 (默认递归)
  --include-experimental 也升级无 frontmatter / 非 OKF 风格的报告文件 (默认跳过)
  --help, -h             显示此帮助

FRONTMATTER 必填字段(OKF V0.2 模板):
  module         现有,模块名
  module_path    现有,模块路径
  module_type    现有,模块类型
  keywords       现有,关键词
  status         新增,stable | draft | deprecated
  owner          新增,知识责任人
  last_verified  新增,最后一次人工/自动校验时间
  sources        新增,至少一条(URL / ADR 引用 / 内部 cross-reference)
  linked_decisions  新增,允许 [],knowledge-lint 会警告

缺省值(用于现有 6 个 module references 的 migration):
  status         → 'stable'
  owner          → 主仓 git log -1 --format=%an (允许显式覆盖)
  last_verified  → last_updated(若存在)或今天
  sources        → [] (warning: 提示用户后续补)
  linked_decisions → [] (允许空,knowledge-lint 警告)

SKIP 规则(默认安全):
  - 顶层 README.md (入口,不动)
  - 报告/research 类文件 (frontmatter 无 module 字段,如 agent-runtime-*-production-readiness.md)
  - external/ 目录下文件 (用 blockquote 元数据,无 frontmatter 风险高)

IDEMPOTENT:
  重复跑产出稳定。已升级的 reference 再跑一次,frontmatter 值不变。

DRY-RUN 默认开启:
  不加 --apply 不会写任何文件,只打印 diff 摘要。
`);
  process.exit(0);
}

// ===== Frontmatter parse & serialize =====

/**
 * 简单 frontmatter 解析 (key-value / inline-list / block-list / quoted string)
 * 不依赖 yaml 包 (零依赖),对 .agent/references/ 现有格式够用。
 */
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const yaml = m[1];
  const body = m[2];
  const raw = m[0];
  const fm = {};
  const lines = yaml.split(/\r?\n/);
  let currentKey = null;

  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(
        line.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '').trim()
      );
    } else {
      const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (km) {
        currentKey = km[1];
        const v = km[2].trim();
        if (v === '' || v === undefined) {
          fm[currentKey] = []; // start of block list
        } else if (v === '[]' || v === '[ ]') {
          fm[currentKey] = [];
        } else if (v.startsWith('[') && v.endsWith(']')) {
          fm[currentKey] = v
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter((s) => s !== '');
        } else {
          fm[currentKey] = v.replace(/^["']|["']$/g, '');
        }
      }
    }
  }
  return { frontmatter: fm, body, raw };
}

function serializeFrontmatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) {
          // 如果 item 含空格或特殊字符,加引号
          const needsQuote = /[\s:#&*?|<>=!%@`]/.test(item) || item === '';
          lines.push(`  - ${needsQuote ? `"${item.replace(/"/g, '\\"')}"` : item}`);
        }
      }
    } else if (v === '' || v === undefined || v === null) {
      lines.push(`${k}: ""`);
    } else {
      const needsQuote = /[\s:#&*?|<>=!%@`]/.test(String(v)) && !/^\d{4}-\d{2}-\d{2}$/.test(String(v));
      lines.push(`${k}: ${needsQuote ? `"${String(v).replace(/"/g, '\\"')}"` : v}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function getGitAuthor() {
  try {
    return execSync('git log -1 --format=%an', { cwd: root, encoding: 'utf8' }).trim() || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * 升级 frontmatter:补齐 OKF V0.2 必填字段
 * 返回 { result, warnings, changes }
 */
function upgradeFrontmatter(fm) {
  const result = { ...fm };
  const warnings = [];
  const changes = [];

  // M-018 MS-002 F-004 反馈:补"已存在 schema 必填但 missing"的字段
  if (!result.module_path) {
    result.module_path = 'unknown';
    changes.push('+ module_path: unknown');
    warnings.push('module_path 缺失,默认 unknown (建议人工补具体路径)');
  }
  if (!result.module_type) {
    result.module_type = 'unknown';
    changes.push('+ module_type: unknown');
    warnings.push('module_type 缺失,默认 unknown (建议人工补具体类型)');
  }

  if (!result.status) {
    result.status = 'stable';
    changes.push('+ status: stable');
    warnings.push('status 默认 stable (建议人工 review)');
  }
  if (!result.owner) {
    result.owner = getGitAuthor();
    changes.push(`+ owner: ${result.owner}`);
    warnings.push(`owner 默认 = git author (${result.owner})`);
  }
  if (!result.last_verified) {
    const today = new Date().toISOString().slice(0, 10);
    result.last_verified = result.last_updated || today;
    changes.push(`+ last_verified: ${result.last_verified}`);
    if (result.last_updated) {
      warnings.push(`last_verified 默认 = last_updated (${result.last_verified})`);
    } else {
      warnings.push(`last_verified 默认 = 今天 (${result.last_verified})`);
    }
  }
  if (!result.sources) {
    result.sources = [];
    changes.push('+ sources: []');
    warnings.push('sources 为空 (建议后续补至少一条)');
  }
  if (!result.linked_decisions) {
    result.linked_decisions = [];
    changes.push('+ linked_decisions: []');
    // 不警告,因为允许空(knowledge-lint 警告)
  }
  if (result.status === 'deprecated' && !result.deprecation_reason) {
    warnings.push('⚠️  status=deprecated 但 deprecation_reason 为空');
  }
  if (result.status === 'stable' && result.deprecation_reason) {
    warnings.push('⚠️  status=stable 但 deprecation_reason 非空,可能标错');
  }

  return { result, warnings, changes };
}

// ===== Main =====

if (!fs.existsSync(referencesDir)) {
  console.error(`❌ ${referencesDir} 不存在`);
  console.error(`   请在 cortex-agent 仓库根目录运行 (cwd = ${root})`);
  process.exit(1);
}

// 收集 .md 文件
function collectMdFiles(dir, recursive) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...collectMdFiles(full, true));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const allMdFiles = collectMdFiles(referencesDir, recursive);

let files = allMdFiles;
let skipped = [];

// 1) 排除 README.md
files = files.filter((f) => path.basename(f) !== 'README.md');
// 2) 排除 external/ (默认; --include-experimental 包含)
if (!includeExperimental) {
  files = files.filter((f) => !f.includes(`${path.sep}external${path.sep}`));
}

if (files.length === 0 && skipped.length === 0) {
  console.log('✅ 没有需要升级的 reference 文件。');
  process.exit(0);
}

console.log(
  `${apply ? '🚚 正在升级' : '🔍 预览升级'} ${files.length} 个 references frontmatter` +
  ` (扫描 ${allMdFiles.length} 个 .md,排除 ${allMdFiles.length - files.length} 个):\n`
);

let modified = 0;
let totalWarnings = 0;
let parseErrors = 0;
let nonOkfSkipped = 0;
const allPlannedChanges = [];

for (const filepath of files) {
  const relPath = path.relative(referencesDir, filepath);
  const content = fs.readFileSync(filepath, 'utf8');
  const parsed = parseFrontmatter(content);

  if (!parsed) {
    console.log(`⏭️  ${relPath}: 无 frontmatter (--- 包裹),跳过 [报告/research 类,非 OKF 模板]`);
    nonOkfSkipped++;
    continue;
  }

  // Schema detection: OKF 模块 reference 必须有 `module` 字段
  if (!parsed.frontmatter.module) {
    console.log(
      `⏭️  ${relPath}: frontmatter 无 \`module\` 字段,跳过 [production-readiness 报告或研究类,schema 不同]`
    );
    nonOkfSkipped++;
    continue;
  }

  const { result: newFm, warnings, changes } = upgradeFrontmatter(parsed.frontmatter);
  const newContent = serializeFrontmatter(newFm) + parsed.body;

  if (newContent !== content) {
    modified++;
    allPlannedChanges.push({ file: relPath });
    console.log(`📝 ${relPath} (${changes.length} 个字段新增/变更):`);
    for (const c of changes) {
      console.log(`     ${c}`);
    }
  } else {
    console.log(`✓  ${relPath}: 已是 OKF V0.2 模板,无变更`);
  }

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.log(`     ⚠️  ${w}`);
    }
    totalWarnings += warnings.length;
  }
}

// 报告跳过的文件(external/ + README)
const externalFiles = allMdFiles.filter(
  (f) => f.includes(`${path.sep}external${path.sep}`) && !files.includes(f)
);
if (externalFiles.length > 0) {
  console.log(`\n⏭️  external/ 子目录跳过 ${externalFiles.length} 个文件 (无 frontmatter 风险高):`);
  for (const f of externalFiles) {
    console.log(`     - ${path.relative(referencesDir, f)}`);
  }
}

console.log('');
if (!apply) {
  console.log(`🔍 DRY-RUN 完成:`);
  console.log(`   ${modified} 个文件会有变更, ${totalWarnings} 个 warning, ${parseErrors} 个 parse error`);
  console.log(`   实际写入请加 --apply 参数`);
  if (modified > 0) {
    process.exit(0);  // dry-run 成功
  } else {
    process.exit(0);
  }
}

// apply mode
if (allPlannedChanges.length === 0) {
  console.log('✅ 没有需要写入的变更 (idempotent)');
  process.exit(0);
}

for (const { file } of allPlannedChanges) {
  const filepath = path.join(referencesDir, file);
  const content = fs.readFileSync(filepath, 'utf8');
  const parsed = parseFrontmatter(content);
  const { result: newFm } = upgradeFrontmatter(parsed.frontmatter);
  const newContent = serializeFrontmatter(newFm) + parsed.body;
  fs.writeFileSync(filepath, newContent, 'utf8');
  console.log(`✅ ${file} 已写入`);
}

console.log(`\n✅ APPLY 完成: ${allPlannedChanges.length} 个文件已升级`);
if (totalWarnings > 0) {
  console.log(`⚠️  ${totalWarnings} 个 warning 待 review (sources 为空 / 缺省值等)`);
}
