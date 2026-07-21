const fs = require('fs');
const path = require('path');

const MIN_RELEVANCE = 0.3;
const MAX_RESULTS = 5;
const WEIGHTS = { tags: 0.5, keywords: 0.3, files: 0.2 };

// Path helpers (parameterized on root so the aggregator can call this in any dir).
function paths(root) {
  const experiencesDir = path.join(root, '.agent', 'experiences');
  return {
    experiencesDir,
    indexPath: path.join(experiencesDir, 'index.json'),
    metricsDir: path.join(root, '.agent', 'metrics'),
    outputPath: path.join(root, '.agent', 'metrics', 'experience-recall-result.json'),
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { tags: [], files: [], query: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tags' && args[i + 1]) result.tags = args[++i].split(',').map(t => t.trim());
    else if (args[i] === '--files' && args[i + 1]) result.files = args[++i].split(',').map(f => f.trim());
    else if (args[i] === '--query' && args[i + 1]) result.query = args[++i];
  }
  return result;
}

function jaccardSimilarity(setA, setB) {
  if (!setA.length || !setB.length) return 0;
  const a = new Set(setA.map(s => s.toLowerCase()));
  const b = new Set(setB.map(s => s.toLowerCase()));
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function keywordScore(query, text) {
  if (!query || !text) return 0;
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return 0;
  const lowerText = text.toLowerCase();
  const matched = words.filter(w => lowerText.includes(w)).length;
  return matched / words.length;
}

function filePathScore(taskFiles, expFiles) {
  if (!taskFiles.length || !expFiles.length) return 0;
  const expSet = new Set(expFiles.map(f => f.toLowerCase()));
  const matched = taskFiles.filter(f => {
    const lf = f.toLowerCase();
    return expSet.has(lf) || [...expSet].some(ef => lf.includes(ef) || ef.includes(lf));
  }).length;
  // 用 taskFiles 作分母：任务文件全部命中则 1.0
  return matched / taskFiles.length;
}

function computeRelevance(input, exp) {
  const tagScore = jaccardSimilarity(input.tags, exp.tags || []);
  const kwText = `${exp.title} ${exp.key_lesson}`;
  const kwScore = keywordScore(input.query, kwText);
  const fScore = filePathScore(input.files, exp.related_files || []);
  return WEIGHTS.tags * tagScore + WEIGHTS.keywords * kwScore + WEIGHTS.files * fScore;
}

function matchedOn(input, exp) {
  const on = [];
  if (input.tags.length && jaccardSimilarity(input.tags, exp.tags || []) > 0) on.push('tags');
  if (input.query && keywordScore(input.query, `${exp.title} ${exp.key_lesson}`) > 0) on.push('keywords');
  if (input.files.length && filePathScore(input.files, exp.related_files || []) > 0) on.push('files');
  return on;
}

// Pure function: score experiences for the given input. Returns { scored, warnings, total }.
// No I/O side effects except reading the index; callable by the unified aggregator.
function recallExperiences(root, input) {
  const { indexPath } = paths(root);
  if (!fs.existsSync(indexPath)) {
    return { scored: [], warnings: [], total: 0, missing: true };
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const experiences = index.experiences || [];

  const scored = experiences
    .map(exp => ({
      ...exp,
      relevance: computeRelevance(input, exp),
      matched_on: matchedOn(input, exp),
    }))
    .filter(exp => exp.relevance >= MIN_RELEVANCE)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_RESULTS);

  const warnings = scored
    .filter(exp => exp.severity === 'high')
    .map(exp => `⚠️  此任务涉及 ${(exp.tags || []).slice(0, 3).join('/')}, 请检查 ${exp.id}: ${exp.title.slice(0, 40)}`);

  return { scored, warnings, total: experiences.length };
}

function main() {
  const input = parseArgs();
  const { indexPath, metricsDir, outputPath } = paths(process.cwd());

  if (!fs.existsSync(indexPath)) {
    console.log('No experience index found at', indexPath);
    console.log('Run: mkdir -p .agent/experiences && create index.json');
    process.exit(0);
  }

  const { scored, warnings, total } = recallExperiences(process.cwd(), input);

  const result = {
    query: input,
    matched_experiences: scored.map(({ id, title, relevance, matched_on, key_lesson, path: expPath, severity }) => ({
      id, title, relevance: Math.round(relevance * 100) / 100, matched_on, key_lesson, severity,
      path: expPath,
    })),
    warnings,
    total_experiences_scanned: total,
    generated_at: new Date().toISOString(),
  };

  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  if (scored.length === 0) {
    console.log('✅ 未找到相关历史经验，可安全推进。');
  } else {
    console.log(`\n🔍 找到 ${scored.length} 条相关经验（共扫描 ${total} 条）：\n`);
    for (const exp of scored) {
      console.log(`  [${exp.id}] ${exp.title}`);
      console.log(`  相关度: ${(exp.relevance * 100).toFixed(0)}%  命中维度: ${exp.matched_on.join(', ')}`);
      console.log(`  教训: ${exp.key_lesson.slice(0, 80)}...`);
      console.log();
    }
    if (warnings.length) {
      console.log('⚠️  警告:');
      warnings.forEach(w => console.log(' ', w));
    }
  }

  console.log(`📄 完整结果已写入: ${outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { recallExperiences, computeRelevance, paths };
