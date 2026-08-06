#!/usr/bin/env node
'use strict';
/**
 * build-references-index.js
 * 自动生成 .agent/references/INDEX.md 知识图谱入口
 * 包含:status 分布 + stable / draft / deprecated 分组 + Mermaid 关系图
 *
 * 配合 cortex-agent OKF 知识层提案 + M-018 mission (MS-003 F-008)。
 *
 * 用法:
 *   node .agent/scripts/build-references-index.js          # 实际写入
 *   node .agent/scripts/build-references-index.js --dry-run # 仅打印
 *   node .agent/scripts/build-references-index.js --help
 *
 * Exit codes:
 *   0 — 成功
 *   1 — 错误
 */

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const referencesDir = path.join(root, '.agent', 'references');
const outputPath = path.join(referencesDir, 'INDEX.md');
const dryRun = process.argv.includes('--dry-run');
const help = process.argv.includes('--help') || process.argv.includes('-h');

if (help) {
  console.log(`build-references-index.js

自动生成 .agent/references/INDEX.md (知识图谱入口)。

USAGE:
  node .agent/scripts/build-references-index.js [OPTIONS]

OPTIONS:
  --dry-run   仅打印 INDEX.md 到 stdout, 不写入文件
  --help, -h  显示此帮助

CONTENT:
  - 总览 (status 分布表)
  - Stable References 主列表
  - Draft References
  - Archived (Deprecated) 分区
  - Mermaid 知识关系图 (基于 linked_decisions)

SKIP 规则:
  - README.md (入口, 不在 INDEX 中)
  - INDEX.md (本脚本生成的文件)
  - 无 module 字段的文件 (production-readiness 报告等)
`);
  process.exit(0);
}

// ===== 复用 parseFrontmatter (与 validate-frontmatter.js 同款) =====

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

// ===== Collect references =====

if (!fs.existsSync(referencesDir)) {
  console.error(`❌ ${referencesDir} 不存在`);
  process.exit(1);
}

const allMd = fs.readdirSync(referencesDir).filter((f) => f.endsWith('.md'));
const refs = [];
const skipped = [];

for (const file of allMd) {
  if (file === 'README.md' || file === 'INDEX.md') continue;
  const filepath = path.join(referencesDir, file);
  const content = fs.readFileSync(filepath, 'utf8');
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    skipped.push({ file, reason: 'no frontmatter' });
    continue;
  }
  if (!parsed.frontmatter.module) {
    skipped.push({ file, reason: 'no module field (production-readiness report)' });
    continue;
  }
  refs.push({
    file,
    module: parsed.frontmatter.module || '',
    module_path: parsed.frontmatter.module_path || '',
    module_type: parsed.frontmatter.module_type || '',
    summary: parsed.frontmatter.summary || '',
    status: parsed.frontmatter.status || 'unknown',
    owner: parsed.frontmatter.owner || '',
    last_verified: parsed.frontmatter.last_verified || '',
    sources: parsed.frontmatter.sources || [],
    linked_decisions: parsed.frontmatter.linked_decisions || [],
    deprecation_reason: parsed.frontmatter.deprecation_reason || '',
  });
}

// ===== Group by status =====

const groups = { stable: [], draft: [], deprecated: [], other: [] };
for (const r of refs) {
  if (r.status === 'stable') groups.stable.push(r);
  else if (r.status === 'draft') groups.draft.push(r);
  else if (r.status === 'deprecated') groups.deprecated.push(r);
  else groups.other.push(r);
}

// ===== Generate INDEX.md =====

const generatedAt = new Date().toISOString();
let md = '';
md += '---\n';
md += 'title: "References Index (知识图谱入口)"\n';
md += 'description: "自动生成。所有 references 的 status 分布 + Mermaid 关系图。Agent 必读。"\n';
md += 'type: index\n';
md += 'generated_at: "' + generatedAt + '"\n';
md += 'generated_by: "build-references-index.js"\n';
md += 'do_not_edit: true\n';
md += 'module: references-index\n';
md += 'module_path: ".agent/references/INDEX.md"\n';
md += 'module_type: "知识图谱入口 (auto-generated)"\n';
md += 'keywords: [index, knowledge-graph, mermaid, auto-generated]\n';
md += 'status: stable\n';
md += 'owner: build-references-index\n';
md += 'last_verified: "' + generatedAt.slice(0, 10) + '"\n';
md += 'sources: []\n';
md += 'linked_decisions: []\n';
md += '---\n';
md += '\n';
md += '# References Index (知识图谱入口)\n';
md += '\n';
md += '> **自动生成**: ' + generatedAt + ' by `node .agent/scripts/build-references-index.js`\n';
md += '> **不要手改**: 每次跑 build-references-index.js 会重写整个文件\n';
md += '> **生成依据**: 扫描 `.agent/references/*.md` 的 frontmatter (OKF V0.2 模板)\n';
md += '\n';

md += '## 总览 (Status Distribution)\n\n';
md += '| Status | 数量 |\n';
md += '|---|---|\n';
md += '| `stable` | ' + groups.stable.length + ' |\n';
md += '| `draft` | ' + groups.draft.length + ' |\n';
md += '| `deprecated` | ' + groups.deprecated.length + ' |\n';
if (groups.other.length > 0) {
  md += '| `other` (status 字段缺失/非法) | ' + groups.other.length + ' |\n';
}
md += '| **Total** | **' + refs.length + '** |\n';
md += '\n';
if (skipped.length > 0) {
  md += '**Skipped**: ' + skipped.length + ' 个文件 (无 frontmatter 或无 `module` 字段):\n\n';
  for (const s of skipped) {
    md += '- `' + s.file + '` (' + s.reason + ')\n';
  }
  md += '\n';
}

md += '## Stable References (主列表)\n\n';
if (groups.stable.length === 0) {
  md += '_No stable references yet._\n\n';
} else {
  // 按 module 名字母排序
  groups.stable.sort((a, b) => a.module.localeCompare(b.module));
  md += '| Module | Type | Path | Summary | Last Verified |\n';
  md += '|---|---|---|---|---|\n';
  for (const r of groups.stable) {
    md += '| `[' + r.module + '](' + r.file + ')` | ' + r.module_type + ' | `' + r.module_path + '` | ' + (r.summary.length > 60 ? r.summary.slice(0, 60) + '...' : r.summary) + ' | ' + r.last_verified + ' |\n';
  }
  md += '\n';
}

md += '## Draft References\n\n';
if (groups.draft.length === 0) {
  md += '_No draft references._\n\n';
} else {
  groups.draft.sort((a, b) => a.module.localeCompare(b.module));
  md += '> ⚠️ Draft 状态的 reference 不应被 Agent 直接采信。\n\n';
  md += '| Module | Type | Summary | Last Verified |\n';
  md += '|---|---|---|---|\n';
  for (const r of groups.draft) {
    md += '| `' + r.module + '` | ' + r.module_type + ' | ' + (r.summary.length > 60 ? r.summary.slice(0, 60) + '...' : r.summary) + ' | ' + r.last_verified + ' |\n';
  }
  md += '\n';
}

md += '## Archived (Deprecated)\n\n';
if (groups.deprecated.length === 0) {
  md += '_No deprecated references._\n\n';
} else {
  groups.deprecated.sort((a, b) => a.module.localeCompare(b.module));
  md += '> ⚠️ Deprecated 状态的 reference 已过期/不再维护,但保留供历史回溯。**永不物理删除**(走 git history)。\n\n';
  md += '| Module | Deprecation Reason | Last Verified |\n';
  md += '|---|---|---|\n';
  for (const r of groups.deprecated) {
    md += '| `' + r.module + '` | ' + (r.deprecation_reason || '_no reason given_') + ' | ' + r.last_verified + ' |\n';
  }
  md += '\n';
}

// ===== Mermaid graph =====

md += '## Mermaid Knowledge Graph\n\n';
md += '基于 `linked_decisions` 字段,展示 reference ↔ ADR 关系。\n\n';

const allLinks = [];
for (const r of refs) {
  for (const d of r.linked_decisions) {
    allLinks.push({ from: r.module, to: d });
  }
}

if (allLinks.length === 0) {
  md += '_No linked_decisions yet. 每个 reference 应该在 `linked_decisions` 字段关联一个或多个 ADR (D-xxx) 以建立知识图谱。_\n\n';
} else {
  md += '```mermaid\n';
  md += 'graph LR\n';
  // 节点样式
  for (const r of refs) {
    const safeId = r.module.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeLabel = r.module.replace(/"/g, "'");
    md += '  ' + safeId + '["' + safeLabel + '"]\n';
  }
  for (const l of allLinks) {
    const fromId = l.from.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeTo = l.to.replace(/[^a-zA-Z0-9_]/g, '_');
    md += '  ' + fromId + ' --> ' + safeTo + '\n';
  }
  // 加图例
  md += '  classDef ref fill:#e1f5ff,stroke:#01579b,color:#000\n';
  md += '  classDef adr fill:#fff9c4,stroke:#f57f17,color:#000\n';
  for (const r of refs) {
    const safeId = r.module.replace(/[^a-zA-Z0-9_]/g, '_');
    md += '  class ' + safeId + ' ref\n';
  }
  const adrIds = new Set();
  for (const l of allLinks) adrIds.add(l.to.replace(/[^a-zA-Z0-9_]/g, '_'));
  for (const a of adrIds) md += '  class ' + a + ' adr\n';
  md += '```\n\n';
}

md += '---\n\n';
md += '**Last Generated**: ' + generatedAt + '\n';
md += '**Total References**: ' + refs.length + ' (stable: ' + groups.stable.length + ', draft: ' + groups.draft.length + ', deprecated: ' + groups.deprecated.length + ')\n';
md += '**Skip Reason for non-indexed files**: 无 frontmatter (V-FM-001) 或 无 `module` 字段 (production-readiness 报告)\n';
md += '\n';

// ===== Output =====

if (dryRun) {
  console.log(md);
  process.exit(0);
}

fs.writeFileSync(outputPath, md, 'utf8');
console.log('✅ INDEX.md 已生成: ' + path.relative(root, outputPath));
console.log('   Total: ' + refs.length + ' (' + groups.stable.length + ' stable, ' + groups.draft.length + ' draft, ' + groups.deprecated.length + ' deprecated)');
if (skipped.length > 0) {
  console.log('   Skipped: ' + skipped.length);
}
console.log('   Mermaid edges: ' + allLinks.length);
