#!/usr/bin/env node
'use strict';
/**
 * migrate-proposals.js
 * 将 .agent/plans/proposals/ 根目录下的平铺提案文件
 * 按文件名推断主题，移动到对应子文件夹。
 *
 * 用法：
 *   node .agent/scripts/migrate-proposals.js          # 预览（dry-run）
 *   node .agent/scripts/migrate-proposals.js --apply  # 实际移动
 */

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const proposalsDir = path.join(root, '.agent', 'plans', 'proposals');
const apply = process.argv.includes('--apply');

if (!fs.existsSync(proposalsDir)) {
  console.log('未找到 .agent/plans/proposals/，退出。');
  process.exit(0);
}

// 从文件名推断 topic（取第一个有意义的词组，去掉 -proposal 后缀）
function inferTopic(filename) {
  const base = filename.replace(/-proposal\.md$/, '').replace(/\.md$/, '');
  const parts = base.split('-');
  // 取前 1~2 个词作为 topic（过滤掉纯动词/通用词）
  const stopWords = new Set(['add', 'fix', 'update', 'new', 'old', 'the', 'a', 'an', 'for', 'of', 'to']);
  const topic = parts.filter(p => !stopWords.has(p)).slice(0, 2).join('-') || parts[0];
  return topic;
}

const entries = fs.readdirSync(proposalsDir, { withFileTypes: true });
const flatFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md'));

if (flatFiles.length === 0) {
  console.log('✅ 没有需要迁移的平铺提案文件。');
  process.exit(0);
}

console.log(`${apply ? '🚚 正在迁移' : '🔍 预览迁移'}（共 ${flatFiles.length} 个文件）：\n`);

const moves = flatFiles.map(e => {
  const topic = inferTopic(e.name);
  return { from: path.join(proposalsDir, e.name), to: path.join(proposalsDir, topic, e.name), topic };
});

// 按 topic 分组展示
const byTopic = {};
moves.forEach(m => { (byTopic[m.topic] = byTopic[m.topic] || []).push(m.from); });
Object.entries(byTopic).forEach(([topic, files]) => {
  console.log(`  📁 ${topic}/`);
  files.forEach(f => console.log(`     └─ ${path.basename(f)}`));
});

if (!apply) {
  console.log('\n💡 确认无误后运行 --apply 实际执行移动。');
  console.log('   如需手动调整分类，直接修改上方逻辑或手动移动文件。');
  process.exit(0);
}

// 执行移动
let moved = 0;
moves.forEach(({ from, to, topic }) => {
  const dir = path.dirname(to);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(from, to);
  moved++;
});
console.log(`\n✅ 已移动 ${moved} 个文件。`);
