const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const metricsDir = path.join(root, '.agent', 'metrics');
const outputPath = path.join(metricsDir, 'knowledge-health.json');

const requiredReadmes = [
  'docs/quality/README.md',
  'docs/reliability/README.md',
  'docs/security/README.md',
  'docs/exec-plans/README.md',
  'docs/exec-plans/active/README.md',
  'docs/exec-plans/completed/README.md',
];

const internalDocRoots = [
  path.join(root, '.agent'),
  path.join(root, 'docs'),
];

function exists(targetPath) {
  return fs.existsSync(targetPath);
}

function readFile(targetPath) {
  return fs.readFileSync(targetPath, 'utf8');
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function listMarkdownFiles(dir, files = []) {
  if (!exists(dir)) return files;

  for (const entry of fs.readdirSync(dir)) {
    const target = path.join(dir, entry);
    const stat = fs.lstatSync(target);

    if (stat.isSymbolicLink()) continue;

    if (stat.isDirectory()) {
      if (entry === '.git' || entry === 'node_modules') continue;
      listMarkdownFiles(target, files);
      continue;
    }

    if (target.endsWith('.md')) files.push(target);
  }

  return files;
}

function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function extractHeadings(content) {
  const headings = new Set();
  const pattern = /^#{1,6}\s+(.+)$/gm;
  let match;

  while ((match = pattern.exec(content))) {
    headings.add(slugifyHeading(match[1]));
  }

  return headings;
}

function shouldCheckLink(rawLink) {
  if (!rawLink) return false;
  if (rawLink.includes('{') || rawLink.includes('}')) return false;
  if (rawLink.startsWith('http://')) return false;
  if (rawLink.startsWith('https://')) return false;
  if (rawLink.startsWith('mailto:')) return false;
  if (rawLink.startsWith('app://')) return false;
  if (rawLink.startsWith('plugin://')) return false;
  return true;
}

function extractMarkdownLinks(content) {
  const links = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;

  while ((match = pattern.exec(content))) {
    links.push(match[1].trim());
  }

  return links;
}

function splitLink(link) {
  const hashIndex = link.indexOf('#');
  if (hashIndex === -1) return { filePart: link, anchor: '' };
  return {
    filePart: link.slice(0, hashIndex),
    anchor: link.slice(hashIndex + 1),
  };
}

function resolveTargetFile(sourceFile, filePart) {
  if (!filePart) return sourceFile;
  if (path.isAbsolute(filePart)) return path.normalize(filePart);
  return path.normalize(path.resolve(path.dirname(sourceFile), filePart));
}

function collectBrokenLinks(markdownFiles) {
  const brokenLinks = [];
  const brokenAnchors = [];
  const headingCache = new Map();

  for (const sourceFile of markdownFiles) {
    const content = readFile(sourceFile);
    const links = extractMarkdownLinks(content);

    for (const rawLink of links) {
      if (!shouldCheckLink(rawLink)) continue;

      const { filePart, anchor } = splitLink(rawLink);
      const targetFile = resolveTargetFile(sourceFile, filePart);

      if (!exists(targetFile)) {
        brokenLinks.push({
          source: path.relative(root, sourceFile),
          target: rawLink,
          resolved: path.relative(root, targetFile),
        });
        continue;
      }

      if (anchor && targetFile.endsWith('.md')) {
        if (!headingCache.has(targetFile)) {
          headingCache.set(targetFile, extractHeadings(readFile(targetFile)));
        }

        const headings = headingCache.get(targetFile);
        const normalizedAnchor = slugifyHeading(anchor);

        if (!headings.has(normalizedAnchor)) {
          brokenAnchors.push({
            source: path.relative(root, sourceFile),
            target: rawLink,
            resolved: path.relative(root, targetFile),
            anchor,
          });
        }
      }
    }
  }

  return { brokenLinks, brokenAnchors };
}

function collectMissingReadmes() {
  return requiredReadmes
    .filter((relativePath) => !exists(path.join(root, relativePath)))
    .map((relativePath) => ({ path: relativePath }));
}

function countActiveTasks(taskProgressContent) {
  const sectionMatch = taskProgressContent.match(/## 🔥 当前活跃任务([\s\S]*?)(?:\n## |\n---|$)/);
  if (!sectionMatch) return 0;

  return sectionMatch[1]
    .split('\n')
    .filter((line) => /^\|/.test(line))
    .filter((line) => !line.includes(':---'))
    .filter((line) => !/任务 ID|优先级|描述|进度/.test(line))
    .filter((line) => line.trim() !== '|')
    .length;
}

function collectPlanIssues() {
  const issues = [];
  const taskProgressPath = path.join(root, '.agent', 'plans', 'task-progress.md');

  if (!exists(taskProgressPath)) {
    issues.push({
      type: 'missing_task_progress',
      message: '.agent/plans/task-progress.md does not exist',
    });
    return issues;
  }

  const taskProgressContent = readFile(taskProgressPath);
  const activeTasks = countActiveTasks(taskProgressContent);
  const activePlanDir = path.join(root, 'docs', 'exec-plans', 'active');
  const completedPlanDir = path.join(root, 'docs', 'exec-plans', 'completed');

  const activePlanFiles = exists(activePlanDir)
    ? fs.readdirSync(activePlanDir).filter((file) => file.endsWith('.md') && file !== 'README.md')
    : [];
  const completedPlanFiles = exists(completedPlanDir)
    ? fs.readdirSync(completedPlanDir).filter((file) => file.endsWith('.md') && file !== 'README.md')
    : [];

  if (activeTasks > 0 && activePlanFiles.length === 0) {
    issues.push({
      type: 'missing_active_plan',
      message: 'Active tasks exist, but docs/exec-plans/active/ has no matching plan files',
    });
  }

  if (completedPlanFiles.length > 0 && !exists(path.join(completedPlanDir, 'README.md'))) {
    issues.push({
      type: 'missing_completed_plan_readme',
      message: 'Completed plan files exist, but completed/ is missing README guidance',
    });
  }

  return issues;
}

function getTrackedNames(dir, extension, nestedSkill = false) {
  if (!exists(dir)) return new Set();
  const entries = fs.readdirSync(dir);
  const names = new Set();

  for (const entry of entries) {
    const target = path.join(dir, entry);
    const stat = fs.statSync(target);

    if (nestedSkill && stat.isDirectory() && exists(path.join(target, 'SKILL.md'))) {
      names.add(entry);
      continue;
    }

    if (!stat.isDirectory() && entry.endsWith(extension)) {
      names.add(entry.slice(0, -extension.length));
    }
  }

  return names;
}

function collectArchitectureDocMismatches() {
  const issues = [];
  const architecturePath = path.join(root, 'docs', 'architecture.md');

  if (!exists(architecturePath)) {
    issues.push({
      type: 'missing_architecture_doc',
      name: 'docs/architecture.md',
    });
    return issues;
  }

  const content = readFile(architecturePath);
  const subAgentNames = getTrackedNames(path.join(root, '.agent', 'sub-agents'), '.md');
  const workflowNames = getTrackedNames(path.join(root, '.agent', 'workflows'), '.md');
  const skillNames = getTrackedNames(path.join(root, '.agent', 'skills'), '', true);

  const subAgentRefs = new Set();
  const workflowRefs = new Set();
  const skillRefs = new Set();

  let match;
  const subAgentPattern = /\|\s*`([^`]+)`\s*\|\s*(?:sonnet|haiku)\s*\|/g;
  while ((match = subAgentPattern.exec(content))) subAgentRefs.add(match[1]);

  const workflowPattern = /`\/([a-z-]+)`/g;
  while ((match = workflowPattern.exec(content))) workflowRefs.add(match[1]);

  const skillSectionMatch = content.match(/### 挂载逻辑说明([\s\S]*?)(?:\n---|$)/);
  if (skillSectionMatch) {
    const rows = skillSectionMatch[1].split('\n').filter((line) => /^\|/.test(line));
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const skillCell = cells[1];
      const skillMatches = skillCell.match(/`([^`]+)`/g) || [];
      for (const skillMatch of skillMatches) {
        skillRefs.add(skillMatch.slice(1, -1));
      }
    }
  }

  for (const name of subAgentRefs) {
    if (!subAgentNames.has(name)) {
      issues.push({ type: 'missing_sub_agent_ref', name });
    }
  }

  for (const name of workflowRefs) {
    if (!workflowNames.has(name)) {
      issues.push({ type: 'missing_workflow_ref', name });
    }
  }

  for (const name of skillRefs) {
    if (!skillNames.has(name)) {
      issues.push({ type: 'missing_skill_ref', name });
    }
  }

  return issues;
}

// ===== Frontmatter OKF V0.2 checks (M-018 MS-001 F-003) =====

const OKF_STATUS_VALUES = new Set(['stable', 'draft', 'deprecated']);

// 简单 frontmatter 解析:仅识别 key-value / inline-list / block-list
// 不依赖 yaml 包(零依赖)
function parseFrontmatterLite(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
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
  return fm;
}

const FRONTMATTER_SCAN_DIRS = [
  path.join(root, '.agent', 'references'),
  path.join(root, '.agent', 'workflows'),
  path.join(root, '.agent', 'rules'),
];

function collectFrontmatterViolations() {
  const violations = [];
  for (const dir of FRONTMATTER_SCAN_DIRS) {
    if (!exists(dir)) continue;
    const mdFiles = listMarkdownFiles(dir);
    for (const filepath of mdFiles) {
      const rel = path.relative(root, filepath);
      const content = readFile(filepath);
      const fm = parseFrontmatterLite(content);
      if (!fm) continue; // 无 frontmatter 不强制要求

      // R-LINT-007: linked_decisions 为空 (warning, 非阻塞)
      if (Array.isArray(fm.linked_decisions) && fm.linked_decisions.length === 0) {
        violations.push({
          rule_id: 'R-LINT-007',
          severity: 'warning',
          file: rel,
          message: 'linked_decisions is empty (建议关联一个或多个 ADR)',
        });
      }

      // R-LINT-008: status 非法值 (warning)
      if (fm.status !== undefined && !OKF_STATUS_VALUES.has(fm.status)) {
        violations.push({
          rule_id: 'R-LINT-008',
          severity: 'warning',
          file: rel,
          message: `status "${fm.status}" 不是 OKF V0.2 枚举 (stable / draft / deprecated)`,
        });
      }
    }
  }
  return violations;
}

function computeHealthScore(summary) {
  const penalty =
    summary.broken_links * 12 +
    summary.broken_anchors * 6 +
    summary.missing_readmes * 8 +
    summary.plan_issues * 10 +
    summary.architecture_doc_mismatches * 7 +
    summary.frontmatter_violations * 2 + // warning 级,低权重
    summary.required_field_violations * 15; // 必填字段硬缺失,高权重

  return Math.max(0, 100 - penalty);
}

function writeOutput(payload) {
  ensureDir(metricsDir);
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

// 集成 validate-frontmatter.js: 调用其 --json 模式, 把必填字段硬校验结果并入报告
function runFrontmatterValidator() {
  const scriptPath = path.join(root, '.agent', 'scripts', 'validate-frontmatter.js');
  if (!exists(scriptPath)) return null;

  try {
    execFileSync(process.execPath, [scriptPath, '--json'], { cwd: root, stdio: 'ignore' });
    return { summary: { total_violations: 0 }, violations: [] };
  } catch (err) {
    try {
      const outPath = path.join(root, '.agent', 'metrics', 'frontmatter-validation.json');
      if (exists(outPath)) return JSON.parse(readFile(outPath));
    } catch (_) {
      /* 忽略解析错误 */
    }
    return { summary: { total_violations: 0 }, violations: [] };
  }
}

function run() {
  const markdownFiles = internalDocRoots.flatMap((dir) => listMarkdownFiles(dir));
  const { brokenLinks, brokenAnchors } = collectBrokenLinks(markdownFiles);
  const missingReadmes = collectMissingReadmes();
  const planIssues = collectPlanIssues();
  const architectureDocMismatches = collectArchitectureDocMismatches();
  const frontmatterViolations = collectFrontmatterViolations();
  const requiredFieldViolations = runFrontmatterValidator();

  const summary = {
    markdown_files_scanned: markdownFiles.length,
    broken_links: brokenLinks.length,
    broken_anchors: brokenAnchors.length,
    missing_readmes: missingReadmes.length,
    plan_issues: planIssues.length,
    architecture_doc_mismatches: architectureDocMismatches.length,
    frontmatter_violations: frontmatterViolations.length,
    required_field_violations: requiredFieldViolations ? requiredFieldViolations.summary.total_violations : 0,
  };

  const payload = {
    scan: 'knowledge-lint',
    generated_at: new Date().toISOString(),
    health_score: computeHealthScore(summary),
    summary,
    findings: {
      broken_links: brokenLinks,
      broken_anchors: brokenAnchors,
      missing_readmes: missingReadmes,
      plan_issues: planIssues,
      architecture_doc_mismatches: architectureDocMismatches,
      frontmatter_violations: frontmatterViolations,
      required_field_violations: requiredFieldViolations ? requiredFieldViolations.violations : [],
    },
  };

  writeOutput(payload);

  console.log('--- 📚 Knowledge Lint ---');
  console.log(`Scanned markdown files: ${summary.markdown_files_scanned}`);
  console.log(`Broken links: ${summary.broken_links}`);
  console.log(`Broken anchors: ${summary.broken_anchors}`);
  console.log(`Missing READMEs: ${summary.missing_readmes}`);
  console.log(`Plan issues: ${summary.plan_issues}`);
  console.log(`Architecture doc mismatches: ${summary.architecture_doc_mismatches}`);
  console.log(`Frontmatter violations (R-LINT-007/008): ${summary.frontmatter_violations}`);
  console.log(`Required field violations (V-FM): ${summary.required_field_violations}`);
  console.log(`Health score: ${payload.health_score}/100`);
  console.log(`Output: ${path.relative(root, outputPath)}`);
}

run();
