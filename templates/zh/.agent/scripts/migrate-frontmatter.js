#!/usr/bin/env node
'use strict';
/**
 * migrate-frontmatter.js
 * 通用 frontmatter 升级工具,支持 workflows / rules 两类(references 由 migrate-references-frontmatter.js 独立处理)
 *
 * 配合 cortex-agent OKF 知识层提案 (.agent/plans/proposals/okf-knowledge-layer/)
 * 和 M-018 mission (MS-002 F-005 + F-006)。
 *
 * 用法:
 *   node .agent/scripts/migrate-frontmatter.js --type workflows            # dry-run workflows
 *   node .agent/scripts/migrate-frontmatter.js --type rules               # dry-run rules
 *   node .agent/scripts/migrate-frontmatter.js --type workflows --apply    # 实际写入
 *   node .agent/scripts/migrate-frontmatter.js --type rules --apply
 *   node .agent/scripts/migrate-frontmatter.js --type all --dry-run       # 同时跑两类
 *   node .agent/scripts/migrate-frontmatter.js --help
 *
 * Exit codes:
 *   0 — 成功 (dry-run 无修改 / apply 全部成功)
 *   1 — 错误 (parse 失败 / 阻断)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = process.cwd();
const apply = process.argv.includes('--apply');
const help = process.argv.includes('--help') || process.argv.includes('-h');

// --type 必填: workflows | rules | all
const typeArgIdx = process.argv.indexOf('--type');
let type = null;
if (typeArgIdx !== -1 && process.argv[typeArgIdx + 1]) {
  type = process.argv[typeArgIdx + 1];
}

if (help || !type) {
  console.log(`migrate-frontmatter.js

通用 frontmatter 升级工具(workflows / rules)。references 走独立脚本 migrate-references-frontmatter.js。

USAGE:
  node .agent/scripts/migrate-frontmatter.js --type <workflows|rules|all> [OPTIONS]

OPTIONS:
  --type workflows        升级 .agent/workflows/*.md frontmatter
  --type rules            升级 .agent/rules/*.md frontmatter
  --type all              同时跑 workflows + rules
  --apply                 实际写入 (默认 dry-run)
  --help, -h              显示此帮助

WORKFLOW 必填字段(OKF V0.2 模板):
  type         procedure
  applicable_to [all]  适用范围
  inputs        []     工作流需要什么
  outputs       []     工作流产出什么
  linked_skills []     依赖哪些 skill
  linked_rules  []     依赖哪些 rule
  linked_workflows []  上游/下游 workflow
  owner        mavis   知识责任人
  last_verified YYYY-MM-DD
  status       stable

RULE 必填字段(OKF V0.2 模板):
  title        ""      规则标题(从 H1 自动提取)
  description  ""      一句话描述(从前 2 行非空内容生成)
  type         rule
  scope        L1      L1 | L2 | L3
  applicable_to [all]
  linked_workflows []
  linked_skills []
  owner        mavis
  last_verified YYYY-MM-DD
  status       stable

IDEMPOTENT:
  重复跑产出稳定。
`);
  process.exit(help ? 0 : 1);
}

if (!['workflows', 'rules', 'all'].includes(type)) {
  console.error(`❌ --type 必须是 workflows | rules | all,收到: ${type}`);
  process.exit(1);
}

// ===== 复用 F-001 的 parse/serialize (内联简化版) =====

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
  return { frontmatter: fm, body: m[2], raw: m[0] };
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

// ===== Schema 定义 =====

const SCHEMAS = {
  workflows: {
    dir: path.join(root, '.agent', 'workflows'),
    label: 'workflows',
    required: ['type', 'applicable_to', 'inputs', 'outputs', 'owner', 'last_verified', 'status'],
    upgrade: (fm, body) => {
      const r = { ...fm };
      const w = [];
      const ch = [];
      // M-018 MS-002 F-004 反馈:补 description (从 H1 提取)
      if (!r.description) {
        const h1 = body.match(/^#\s+(.+)$/m);
        if (h1) {
          r.description = h1[1].trim();
          ch.push(`+ description: "${r.description}" (from H1)`);
          w.push('description 从 H1 提取,建议人工 review');
        } else {
          r.description = '';
          ch.push('+ description: ""');
          w.push('description 缺失且无 H1 可提取');
        }
      }
      if (!r.type) { r.type = 'procedure'; ch.push('+ type: procedure'); w.push('type 默认 procedure'); }
      if (!r.applicable_to) { r.applicable_to = ['all']; ch.push('+ applicable_to: [all]'); w.push('applicable_to 默认 [all]'); }
      if (!r.inputs) { r.inputs = []; ch.push('+ inputs: []'); }
      if (!r.outputs) { r.outputs = []; ch.push('+ outputs: []'); }
      if (!r.linked_skills) { r.linked_skills = []; ch.push('+ linked_skills: []'); }
      if (!r.linked_rules) { r.linked_rules = []; ch.push('+ linked_rules: []'); }
      if (!r.linked_workflows) { r.linked_workflows = []; ch.push('+ linked_workflows: []'); }
      if (!r.owner) { r.owner = getGitAuthor(); ch.push(`+ owner: ${r.owner}`); w.push(`owner 默认 = git author (${r.owner})`); }
      if (!r.last_verified) {
        r.last_verified = new Date().toISOString().slice(0, 10);
        ch.push(`+ last_verified: ${r.last_verified}`);
        w.push('last_verified 默认 = 今天');
      }
      if (!r.status) { r.status = 'stable'; ch.push('+ status: stable'); w.push('status 默认 stable'); }
      return { result: r, warnings: w, changes: ch };
    },
  },
  rules: {
    dir: path.join(root, '.agent', 'rules'),
    label: 'rules',
    required: ['title', 'description', 'type', 'scope', 'applicable_to', 'owner', 'last_verified', 'status'],
    upgrade: (fm, body) => {
      const r = { ...fm };
      const w = [];
      const ch = [];
      // title 从 H1 提取(无 frontmatter 时)
      if (!r.title) {
        const h1 = body.match(/^#\s+(.+)$/m);
        if (h1) { r.title = h1[1].trim(); ch.push(`+ title: "${r.title}" (from H1)`); }
        else { r.title = ''; ch.push('+ title: ""'); w.push('title 未填 (无 H1)'); }
      }
      // description 从正文前 2 行非空内容生成
      if (!r.description) {
        const lines = body.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
        const desc = lines.slice(0, 2).join(' ').replace(/^#+\s*/, '').trim().slice(0, 100);
        r.description = desc;
        ch.push(`+ description: "${r.description.slice(0, 60)}..." (from body)`);
        w.push('description 从正文自动生成,建议人工 review');
      }
      if (!r.type) { r.type = 'rule'; ch.push('+ type: rule'); }
      if (!r.scope) { r.scope = 'L1'; ch.push('+ scope: L1'); w.push('scope 默认 L1 (按 agent-scope 需人工 review)'); }
      if (!r.applicable_to) { r.applicable_to = ['all']; ch.push('+ applicable_to: [all]'); }
      if (!r.linked_workflows) { r.linked_workflows = []; ch.push('+ linked_workflows: []'); }
      if (!r.linked_skills) { r.linked_skills = []; ch.push('+ linked_skills: []'); }
      if (!r.owner) { r.owner = getGitAuthor(); ch.push(`+ owner: ${r.owner}`); w.push(`owner 默认 = git author (${r.owner})`); }
      if (!r.last_verified) {
        r.last_verified = new Date().toISOString().slice(0, 10);
        ch.push(`+ last_verified: ${r.last_verified}`);
      }
      if (!r.status) { r.status = 'stable'; ch.push('+ status: stable'); }
      return { result: r, warnings: w, changes: ch };
    },
  },
};

// ===== Main =====

const typesToRun = type === 'all' ? ['workflows', 'rules'] : [type];

let totalModified = 0;
let totalWarnings = 0;
let totalParseErrors = 0;
let totalSkipped = 0;
const allPlannedChanges = [];

for (const t of typesToRun) {
  const schema = SCHEMAS[t];
  if (!fs.existsSync(schema.dir)) {
    console.error(`❌ ${schema.dir} 不存在`);
    process.exit(1);
  }

  const files = fs.readdirSync(schema.dir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.log(`✅ ${schema.label}: 没有 .md 文件`);
    continue;
  }

  console.log(
    `\n${'='.repeat(60)}\n${apply ? '🚚 正在升级' : '🔍 预览升级'} ${t} (${files.length} 个文件)\n${'='.repeat(60)}\n`
  );

  for (const file of files) {
    const filepath = path.join(schema.dir, file);
    const content = fs.readFileSync(filepath, 'utf8');
    const parsed = parseFrontmatter(content);

    let fm, body;
    if (parsed) {
      fm = parsed.frontmatter;
      body = parsed.body;
    } else {
      // 无 frontmatter: 用空对象 + 全部 body
      fm = {};
      body = content;
    }

    const { result: newFm, warnings, changes } = schema.upgrade(fm, body);
    const newFmSerialized = serializeFrontmatter(newFm);
    const newContent = parsed ? newFmSerialized + body : newFmSerialized + content;

    if (newContent !== content) {
      totalModified++;
      allPlannedChanges.push({ type: t, file });
      console.log(`📝 ${file} (${changes.length} 个字段新增/变更):`);
      for (const c of changes) console.log(`     ${c}`);
    } else {
      console.log(`✓  ${file}: 已是 OKF V0.2 模板,无变更`);
    }

    if (warnings.length > 0) {
      for (const w of warnings) {
        console.log(`     ⚠️  ${w}`);
        totalWarnings++;
      }
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
if (!apply) {
  console.log(`🔍 DRY-RUN 汇总:`);
  console.log(`   ${totalModified} 个文件会有变更, ${totalWarnings} 个 warning`);
  console.log(`   实际写入请加 --apply 参数`);
  process.exit(0);
}

if (allPlannedChanges.length === 0) {
  console.log(`✅ 没有需要写入的变更 (idempotent)`);
  process.exit(0);
}

for (const { type: t, file } of allPlannedChanges) {
  const schema = SCHEMAS[t];
  const filepath = path.join(schema.dir, file);
  const content = fs.readFileSync(filepath, 'utf8');
  const parsed = parseFrontmatter(content);
  const fm = parsed ? parsed.frontmatter : {};
  const body = parsed ? parsed.body : content;
  const { result: newFm } = schema.upgrade(fm, body);
  const newContent = serializeFrontmatter(newFm) + body;
  fs.writeFileSync(filepath, newContent, 'utf8');
  console.log(`✅ [${t}] ${file} 已写入`);
}

console.log(`\n✅ APPLY 完成: ${allPlannedChanges.length} 个文件已升级`);
if (totalWarnings > 0) {
  console.log(`⚠️  ${totalWarnings} 个 warning 待 review (scope 默认 L1 / description 自动生成等)`);
}
