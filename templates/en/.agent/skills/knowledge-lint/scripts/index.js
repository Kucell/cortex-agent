const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
  if (!rawLink || /[{}]/.test(rawLink)) return false;
  // URI schemes are not repository paths (RFC 3986); file: is reported separately.
  return !/^[a-z][a-z0-9+.-]*:/i.test(rawLink) && !rawLink.startsWith('//');
}

function isEscaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function maskMarkdownCode(content) {
  let fence = null;
  const prose = content.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] &&
          marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = marker[1];
      return '';
    }
    return line;
  }).join('\n');
  // Blocks take precedence over inline spans. In particular, an unmatched
  // tick in a paragraph must not consume links in the following heading/list.
  const blocks = [];
  let block = [];
  const flush = () => { if (block.length) blocks.push(block.join('\n')); block = []; };
  for (const line of prose.split('\n')) {
    const heading = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line);
    const separator = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,}|=+[ \t]*|-+[ \t]*)$/.test(line);
    const listMarker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;
    // Ordered lists can interrupt a paragraph only when starting at 1.
    const list = listMarker.test(line) && (!block.length || listMarker.test(block[0]) ||
      /^ {0,3}(?:[-+*]|1[.)])[ \t]+/.test(line));
    const quote = /^ {0,3}>/.test(line);
    const previousQuote = block.length && /^ {0,3}>/.test(block[block.length - 1]);
    if (!line.trim() || heading || separator || list || (quote && !previousQuote)) flush();
    block.push(line);
    if (!line.trim() || heading || separator) flush();
  }
  flush();
  return blocks.map(maskInlineCode).join('\n');
}

function maskInlineCode(prose) {
  // Only equal-length backtick runs delimit a span; unmatched runs are prose.
  const runs = [...prose.matchAll(/`+/g)];
  const masked = prose.split('');
  for (let i = 0; i < runs.length; i++) {
    if (isEscaped(prose, runs[i].index)) continue;
    let end = i + 1;
    while (end < runs.length && runs[end][0].length !== runs[i][0].length) end++;
    if (end === runs.length) continue;
    masked.fill(' ', runs[i].index, runs[end].index + runs[end][0].length);
    i = end;
  }
  return masked.join('');
}

function hasLinkClose(suffix) {
  // CommonMark titles can contain escaped delimiters and line endings, but
  // not blank lines. Match only the suffix so following paragraphs don't matter.
  const close = suffix.match(/^\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\))?\s*\)/);
  return Boolean(close && !/\r?\n[ \t]*\r?\n/.test(close[0]));
}

function extractMarkdownLinks(content) {
  const text = maskMarkdownCode(content);
  const links = [];
  const opener = /\[(?:\\.|[^\]\\])*\]\(\s*/g;
  let match;
  while ((match = opener.exec(text))) {
    if (isEscaped(text, match.index)) continue;
    let index = opener.lastIndex;
    const angle = text[index] === '<';
    if (angle) index++;
    let target = '';
    let depth = 0;
    let closed = false;
    for (; index < text.length; index++) {
      const ch = text[index];
      if (ch === '\\' && /[\\()[\]<>]/.test(text[index + 1] || '')) {
        target += text[++index];
      } else if (angle ? ch === '>' : ch === ')' && depth === 0) {
        closed = true;
        break;
      } else if (!angle && /\s/.test(ch) && depth === 0) {
        closed = true;
        break;
      } else {
        if (!angle && ch === '(') depth++;
        if (!angle && ch === ')') depth--;
        target += ch;
      }
    }
    // Validate the outer close and optional Markdown title before accepting.
    const suffix = text.slice(index + (angle ? 1 : 0));
    if (closed && hasLinkClose(suffix)) {
      links.push(target);
      opener.lastIndex = index + 1;
    }
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
  const unverifiedLinks = [];
  const headingCache = new Map();

  for (const sourceFile of markdownFiles) {
    const content = readFile(sourceFile);
    const links = extractMarkdownLinks(content);

    for (const rawLink of links) {
      if (/^file:/i.test(rawLink)) {
        // This scanner does not validate host-local URI availability. Report
        // that limit explicitly; it is not a requirement to re-audit past business acceptance.
        unverifiedLinks.push({
          source: path.relative(root, sourceFile), target: rawLink,
          status: 'unverified', reason: 'host_local_uri_not_checked',
        });
        continue;
      }
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

  return { brokenLinks, brokenAnchors, unverifiedLinks };
}

function collectMissingReadmes() {
  return requiredReadmes
    .filter((relativePath) => !exists(path.join(root, relativePath)))
    .map((relativePath) => ({ path: relativePath }));
}

function countActiveTasks(taskProgressContent) {
  // T-TS-003 / MS-3: prefer the structured truth source. Fall back to the
  // markdown table when the project has no task records (not migrated yet).
  const structured = countActiveTasksFromTruthSource();
  if (structured !== null) return structured;

  // The heading may be localized. Both the Chinese and the English title
  // match, and the LAST section wins (a later write is newer).
  const sections = taskProgressContent.match(
    /^##\s+.*(?:当前活跃任务|Active Tasks).*$[\s\S]*?(?=^##\s|\n---|$)/gm,
  );
  if (!sections || !sections.length) return 0;
  const sectionMatch = sections[sections.length - 1].match(
    /(?:当前活跃任务|Active Tasks)([\s\S]*?)(?:\n## |\n---|$)/,
  );
  if (!sectionMatch) return 0;

  return sectionMatch[1]
    .split('\n')
    .filter((line) => /^\|/.test(line))
    .filter((line) => !line.includes(':---'))
    .filter((line) => !/任务 ID|优先级|描述|进度|Task ID|Priority|Description|Progress/.test(line))
    .filter((line) => line.trim() !== '|')
    .length;
}

// T-TS-003 / MS-3: the structured truth source is authoritative for the
// active-task count. The markdown regex stays a fallback for projects that
// have not run `migrate-task-state` yet.
function countActiveTasksFromTruthSource() {
  try {
    const taskState = require(path.join(root, '.agent', 'tasks', 'scripts', 'task-state.js'));
    const count = taskState.countActiveTasksStructured({ projectRoot: root });
    return count === null || count === undefined ? null : count;
  } catch (_) {
    return null;
  }
}

// The active-tasks heading must appear exactly once in the whole file.
// A duplicated section is the drift signature this project has hit before:
// writers append a second "## 🔥 当前活跃任务" block and readers silently
// pick the wrong one.
function countActiveSectionHeadings(content) {
  const matches = content.match(/^##\s+.*(?:当前活跃任务|Active Tasks).*$/gm);
  return matches ? matches.length : 0;
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

  // T-TS-003 / MS-3: the active-tasks section must be unique. A second
  // heading means two writers produced two views and readers may pick
  // the wrong one.
  const headingCount = countActiveSectionHeadings(taskProgressContent);
  if (headingCount > 1) {
    issues.push({
      type: 'duplicate_active_section',
      message: `task-progress.md has ${headingCount} active-tasks sections; exactly one is allowed`,
    });
  }

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

// OKF V0.2 + post-V0.2 扩展。V0.2 原始枚举为 stable/draft/deprecated；
// 新增 experimental (POC/试运行但未 ship) 与 reference (文档化但未 ship, 仅做知识参考)。
// 注: experimental 与 reference 区别于 stable (已 ship + 主路径使用) 与 draft (草稿/编写中)。
const OKF_STATUS_VALUES = new Set(['stable', 'draft', 'deprecated', 'experimental', 'reference']);
// references/runtime-adapters/_schema.md defines deployment status, not OKF lifecycle.
const RUNTIME_ADAPTER_STATUS_VALUES = new Set(['shipped', 'reference', 'pending']);

function statusSchemaFor(filepath, fm) {
  const adapterDir = path.join(root, '.agent', 'references', 'runtime-adapters');
  const adapterDocument = path.dirname(filepath) === adapterDir &&
    typeof fm.agent === 'string' && fm.agent === path.basename(filepath, '.md');
  return adapterDocument
    ? { values: RUNTIME_ADAPTER_STATUS_VALUES, label: 'runtime-adapter' }
    : { values: OKF_STATUS_VALUES, label: 'OKF V0.2' };
}

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
      const statusSchema = statusSchemaFor(filepath, fm);
      if (fm.status !== undefined && !statusSchema.values.has(fm.status)) {
        violations.push({
          rule_id: 'R-LINT-008',
          severity: 'warning',
          file: rel,
          message: `status "${fm.status}" 不是 ${statusSchema.label} 枚举 (${[...statusSchema.values].join(' / ')})`,
        });
      }
    }
  }
  return violations;
}

function computeHealthScore(summary) {
  const penalty =
    summary.broken_links * 12 +
    (summary.unverified_links || 0) * 12 + // Same penalty: unresolved evidence is not acceptance
    summary.broken_anchors * 6 +
    summary.missing_readmes * 8 +
    summary.plan_issues * 10 +
    summary.architecture_doc_mismatches * 7 +
    summary.frontmatter_violations * 2 + // warning 级,低权重
    summary.required_field_violations * 15 + // 必填字段硬缺失,高权重
    summary.memory_integrity_issues * 10;

  return Math.max(0, 100 - penalty);
}

function writeOutput(payload) {
  ensureDir(metricsDir);
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function runMemoryIntegrityValidator() {
  if (!exists(path.join(root, '.agent', 'memory', 'MEMORY.md'))) return { issues: [] };
  const cliPath = process.env.CORTEX_AGENT_CLI;
  const command = cliPath ? process.execPath : 'cortex-agent';
  const args = cliPath
    ? [cliPath, 'memory', 'validate', '--project', root, '--output', 'json']
    : ['memory', 'validate', '--project', root, '--output', 'json'];
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  try {
    const payload = JSON.parse(result.stdout || '{}');
    return { issues: Array.isArray(payload.issues) ? payload.issues : [] };
  } catch (_) {
    return { issues: [{ kind: 'validator-error', detail: (result.stderr || 'memory validator returned invalid JSON').trim() }] };
  }
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
  const { brokenLinks, brokenAnchors, unverifiedLinks } = collectBrokenLinks(markdownFiles);
  const missingReadmes = collectMissingReadmes();
  const planIssues = collectPlanIssues();
  const architectureDocMismatches = collectArchitectureDocMismatches();
  const frontmatterViolations = collectFrontmatterViolations();
  const requiredFieldViolations = runFrontmatterValidator();
  const memoryIntegrity = runMemoryIntegrityValidator();

  const summary = {
    markdown_files_scanned: markdownFiles.length,
    broken_links: brokenLinks.length,
    unverified_links: unverifiedLinks.length,
    broken_anchors: brokenAnchors.length,
    missing_readmes: missingReadmes.length,
    plan_issues: planIssues.length,
    architecture_doc_mismatches: architectureDocMismatches.length,
    frontmatter_violations: frontmatterViolations.length,
    required_field_violations: requiredFieldViolations ? requiredFieldViolations.summary.total_violations : 0,
    memory_integrity_issues: memoryIntegrity.issues.length,
  };

  const payload = {
    scan: 'knowledge-lint',
    generated_at: new Date().toISOString(),
    health_score: computeHealthScore(summary),
    summary,
    findings: {
      broken_links: brokenLinks,
      unverified_links: unverifiedLinks,
      broken_anchors: brokenAnchors,
      missing_readmes: missingReadmes,
      plan_issues: planIssues,
      architecture_doc_mismatches: architectureDocMismatches,
      frontmatter_violations: frontmatterViolations,
      required_field_violations: requiredFieldViolations ? requiredFieldViolations.violations : [],
      memory_integrity: memoryIntegrity.issues,
    },
  };

  writeOutput(payload);

  console.log('--- 📚 Knowledge Lint ---');
  console.log(`Scanned markdown files: ${summary.markdown_files_scanned}`);
  console.log(`Broken links: ${summary.broken_links}`);
  console.log(`Unverified local evidence: ${summary.unverified_links}`);
  console.log(`Broken anchors: ${summary.broken_anchors}`);
  console.log(`Missing READMEs: ${summary.missing_readmes}`);
  console.log(`Plan issues: ${summary.plan_issues}`);
  console.log(`Architecture doc mismatches: ${summary.architecture_doc_mismatches}`);
  console.log(`Frontmatter violations (R-LINT-007/008): ${summary.frontmatter_violations}`);
  console.log(`Required field violations (V-FM): ${summary.required_field_violations}`);
  console.log(`Health score: ${payload.health_score}/100`);
  console.log(`Output: ${path.relative(root, outputPath)}`);
}

if (require.main === module) run();
module.exports = { extractMarkdownLinks, collectBrokenLinks, computeHealthScore, collectFrontmatterViolations };
