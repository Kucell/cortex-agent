#!/usr/bin/env node
'use strict';

// ─── Check L1 Distribution Integrity (Harness Phase 9 / P-003) ─────────────────
//
// The L1 template tree (`templates/_shared/.agent/skills/`) is what every
// downstream project receives. The L3 governance tree (`.agent/skills/`) is
// where the skills are actually authored. Nothing in the repository enforces
// that the two stay in step, so a skill can be shipped in a state that is
// silently broken downstream.
//
// Three failure classes this check makes visible:
//
//   1. manifest 缺失    — the skill has no SKILL.md, so the agent cannot
//                         discover what it is or when to use it.
//   2. 实现缺失          — the skill is shipped but a file it needs is not.
//                         The worst case: the manifest exists, so the skill
//                         looks healthy, but its entry point was never
//                         distributed and the skill cannot run at all.
//   3. 死链              — the manifest links to a path that L1 does not
//                         ship (L1 does not distribute `docs/`), so the link
//                         404s downstream.
//
// The distributed set is read from git's index rather than the filesystem:
// that is exactly what `npm pack` and `cortex-agent init` distribute, and it
// keeps the check deterministic across machines (an untracked `.DS_Store` on
// one developer's laptop is not a distribution defect).
//
// Run:
//   node scripts/check-l1-distribution.js [--root <dir>] [--verbose]
//
// `--root` points the check at a fixture tree instead of the repository, so
// the test suite can prove each of the three checks actually fails.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

// ─── Distribution exclusions ──────────────────────────────────────────────────
//
// Files that exist in L3 but are not part of the distributed surface.
// Each one is a defect in L3, not in L1 — L1 simply must not carry them.

const EXCLUDED_SUFFIXES = Object.freeze([
  '.bak',
  '.bak.prev',
  '.new',
  '.DS_Store',
]);

const EXCLUDED_PATTERNS = Object.freeze([
  /\.test\.js$/,
]);

// A path that repeats the skill's own directory name is a path accident in
// L3 (e.g. `secrets/secrets/scripts/...`). It is excluded from the parity
// requirement so L1 is not forced to replicate the accident.
function isAccidentPath(skillName, relativePath) {
  return relativePath.startsWith(skillName + '/');
}

function isExcluded(skillName, relativePath) {
  const base = path.basename(relativePath);
  if (EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(relativePath))) return true;
  if (isAccidentPath(skillName, relativePath)) return true;
  return false;
}

// ─── File enumeration ─────────────────────────────────────────────────────────
//
// L1 and L3 live in different git repositories: `templates/` is tracked by
// the main repo, while `.agent/` is a gitlink to the governance repo. So each
// side is enumerated in its own repository's index — which is also exactly
// what each side would ship.
//
// When a directory is not inside a git repository (e.g. a fixture tree used
// by the test suite), the filesystem walk is used instead.

function gitTrackedFiles(repoDir) {
  try {
    // Only trust git when `repoDir` IS the top of its repository. Otherwise a
    // fixture directory that happens to sit inside some outer repository would
    // silently enumerate that repository's files instead of its own.
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (path.resolve(toplevel) !== path.resolve(repoDir)) return null;
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
  } catch (_) {
    return null;
  }
}

function walkFiles(root, base, acc) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, acc);
    else if (entry.isFile()) acc.push(path.relative(base, full));
  }
  return acc;
}

// Lists the files of one skill directory, relative to that skill directory.
// `repoDir` is the git repository that owns the tree, `prefix` is the skill's
// path inside that repository.
function listSkillFiles(repoDir, prefix) {
  const tracked = gitTrackedFiles(repoDir);
  if (tracked) {
    const normalized = prefix.replace(/\/+$/, '') + '/';
    return tracked
      .filter((rel) => rel.startsWith(normalized))
      .map((rel) => rel.slice(normalized.length))
      .filter(Boolean)
      .sort();
  }
  const dir = path.join(repoDir, prefix);
  return walkFiles(dir, dir, []).sort();
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

// ─── Implementation content parity ───────────────────────────────────────────
//
// The file-set check above proves that L1 ships every file L3 ships. It says
// nothing about the *content* of those files: L1 can ship a stale copy of a
// script and still pass, and the downstream project then runs code that is
// months behind the governance repo. That is not theoretical — the secrets
// skill shipped an L1 copy that still honoured a `--account` override the L3
// copy had already removed for being a cross-account read.
//
// So implementation files must be byte-identical. Only implementation files:
// documentation is deliberately localised (the `_shared` layer is language
// neutral, `zh`/`en` carry their own copies), and runtime state (task
// indexes, metrics, context-index) is a template in L1 and a live record in
// L3. Neither can be compared byte-for-byte, and pretending otherwise would
// make the check cry wolf.

const IMPLEMENTATION_SCOPE = Object.freeze([
  /^skills\/[^/]+\/scripts\//,
  /^skills\/[^/]+\/agents\//,
  /^hooks\//,
  /^plugins\/[^/]+\/scripts\//,
  /^handoffs\/scripts\//,
  /^tasks\/scripts\//,
  /^artifacts\/scripts\//,
  /^scripts\//,
]);

const IMPLEMENTATION_EXTENSIONS = Object.freeze([
  '.js', '.cjs', '.mjs', '.sh', '.yaml', '.yml',
]);

// Explicit exemptions. Every entry must carry a reason: an exemption without
// a reason is just a hole in the gate. An exemption that no longer applies
// (the files have converged) is reported as stale, so the list cannot rot
// into a permanent list of unchecked files.
const CONTENT_EXEMPTIONS = Object.freeze([
  {
    path: 'hooks/pre-commit-check.sh',
    reason: 'L1 为英文版、L3 为中文版：_shared 是语言中立层，zh/en 各自带 pre-commit-check.md。脚本逻辑一致，只有注释与提示文案不同。',
  },
]);

function isImplementationFile(relativePath) {
  if (!IMPLEMENTATION_SCOPE.some((pattern) => pattern.test(relativePath))) return false;
  return IMPLEMENTATION_EXTENSIONS.includes(path.extname(relativePath));
}

function exemptionFor(relativePath) {
  return CONTENT_EXEMPTIONS.find((entry) => entry.path === relativePath) || null;
}

// Lists files of a repository subtree, relative to that subtree. Uses git's
// index when the directory is a repository root (that is the shipped surface),
// and the filesystem otherwise (fixture trees).
function listRepoFiles(repoDir, prefix) {
  const tracked = gitTrackedFiles(repoDir);
  const clean = String(prefix || '').replace(/^\/+|\/+$/g, '');
  if (tracked) {
    if (!clean) return tracked.slice().sort();
    const normalized = clean + '/';
    return tracked
      .filter((rel) => rel.startsWith(normalized))
      .map((rel) => rel.slice(normalized.length))
      .filter(Boolean)
      .sort();
  }
  const dir = clean ? path.join(repoDir, clean) : repoDir;
  return walkFiles(dir, dir, []).sort();
}

function sameBytes(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch (_) {
    return false;
  }
}

// ─── Frontmatter ──────────────────────────────────────────────────────────────

function frontmatterOf(text) {
  if (!text) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

// ─── Markdown links ───────────────────────────────────────────────────────────

const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isExternalLink(target) {
  return /^(https?:|mailto:|tel:|#)/i.test(target);
}

function checkLinks(root, l1SkillDir, skillName, skillFile, violations) {
  const text = readText(skillFile);
  if (text === null) return 0;
  let examined = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const target = match[1];
    if (isExternalLink(target)) continue;
    // Only relative links are checkable; absolute repo paths are a separate
    // (manually reviewed) concern.
    if (target.startsWith('/')) continue;
    examined += 1;
    const resolved = path.resolve(path.dirname(skillFile), target.split('#')[0]);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..')) continue; // points outside the repo entirely
    if (!fs.existsSync(resolved)) {
      violations.push({
        kind: 'dead-link',
        skill: skillName,
        file: path.relative(root, skillFile),
        detail: `${target} → 未分发路径 ${rel}`,
      });
    }
  }
  return examined;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1]
    ? path.resolve(args[rootIndex + 1])
    : DEFAULT_ROOT;

  const l1Root = path.join(root, 'templates/_shared/.agent/skills');
  const l3Root = path.join(root, '.agent/skills');

  if (!fs.existsSync(l1Root) || !fs.existsSync(l3Root)) {
    console.error(`\n❌ L1 或 L3 skill 根目录不存在: ${l1Root} / ${l3Root}`);
    process.exit(1);
  }

  const l1Skills = fs.readdirSync(l1Root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const l3Skills = fs.readdirSync(l3Root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const violations = [];
  let manifestsChecked = 0;
  let filesCompared = 0;
  let contentCompared = 0;
  let linksChecked = 0;
  const l3OnlySkills = l3Skills.filter((name) => !l1Skills.includes(name));

  for (const skill of l1Skills) {
    const l1Dir = path.join(l1Root, skill);
    const l3Dir = path.join(l3Root, skill);
    const manifest = path.join(l1Dir, 'SKILL.md');

    // ── Check 1: manifest completeness ─────────────────────────────────────
    if (!fs.existsSync(manifest)) {
      violations.push({
        kind: 'missing-manifest',
        skill,
        file: path.relative(root, manifest),
        detail: 'L1 未分发 SKILL.md，agent 无法发现该 skill',
      });
    } else {
      manifestsChecked += 1;
      const fields = frontmatterOf(readText(manifest));
      if (!fields) {
        violations.push({
          kind: 'invalid-manifest',
          skill,
          file: path.relative(root, manifest),
          detail: 'SKILL.md 缺少 frontmatter',
        });
      } else {
        for (const required of ['name', 'description']) {
          if (!fields[required]) {
            violations.push({
              kind: 'invalid-manifest',
              skill,
              file: path.relative(root, manifest),
              detail: `frontmatter 缺少 ${required}`,
            });
          }
        }
      }
    }

    // ── Check 3: link validity (L1 manifest → L1 distributed tree) ─────────
    if (fs.existsSync(manifest)) {
      linksChecked += checkLinks(root, l1Dir, skill, manifest, violations);
    }

    // ── Check 2: file-set parity (L1 ⊇ L3, minus exclusions) ─────────────
    // Only for skills that are distributed at all. A skill that exists solely
    // in L3 is L3-specific and is never shipped, so it has no parity duty.
    if (!fs.existsSync(l3Dir)) continue;
    for (const rel of listSkillFiles(path.join(root, '.agent'), 'skills/' + skill)) {
      if (isExcluded(skill, rel)) continue;
      filesCompared += 1;
      if (!fs.existsSync(path.join(l1Dir, rel))) {
        violations.push({
          kind: 'missing-implementation',
          skill,
          file: path.relative(root, path.join(l1Dir, rel)),
          detail: `L1 缺少实现文件 ${rel}（该 skill 在下游不可用）`,
        });
      }
    }
  }

  // ── Check 4: implementation content parity (L1 ≡ L3, byte-for-byte) ───
  // Only implementation files. Documentation is localised by design and
  // runtime state is a template in L1 and a live record in L3 — comparing
  // those byte-for-byte would make the gate cry wolf, and a gate that cries
  // wolf gets ignored.
  const l3Repo = path.join(root, '.agent');
  const l3Files = new Set(listRepoFiles(l3Repo, ''));
  const sharedLayer = { name: '_shared', agentDir: path.join(root, 'templates/_shared/.agent') };
  const layers = [sharedLayer].concat(
    fs.readdirSync(path.join(root, 'templates'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
      .map((entry) => ({ name: entry.name, agentDir: path.join(root, 'templates', entry.name, '.agent') }))
      .filter((layer) => fs.existsSync(path.join(layer.agentDir, 'skills')))
      .sort((left, right) => left.name.localeCompare(right.name))
  );
  const appliedExemptions = new Set();

  // The comparison runs per *distribution layer*, because that is what a
  // downstream project actually receives: `cortex-agent init` lays the
  // `_shared` base down and then overlays the language layer, and the language
  // layer wins on conflict. Checking only `_shared` would miss a stale copy
  // that the overlay is about to ship.
  for (const layer of layers) {
    const layerFiles = new Set(listRepoFiles(layer.agentDir, ''));
    const sharedFiles = listRepoFiles(sharedLayer.agentDir, '');
    const surface = new Set([...sharedFiles, ...layerFiles]);

    for (const rel of surface) {
      if (!isImplementationFile(rel)) continue;
      const own = layerFiles.has(rel);
      const l1Path = path.join(own ? layer.agentDir : sharedLayer.agentDir, rel);
      const l3Path = path.join(l3Repo, rel);
      // A file L3 does not ship is not a content question — the file-set check
      // above already owns that, and its scope is the distributed skills.
      if (!l3Files.has(rel) || !fs.existsSync(l3Path)) continue;

      filesCompared += 1;
      contentCompared += 1;
      const exemption = exemptionFor(rel);
      if (exemption) {
        if (!exemption.reason || !exemption.reason.trim()) {
          violations.push({
            kind: 'invalid-exemption',
            skill: '-',
            file: path.relative(root, l1Path),
            detail: `豁免条目缺少理由：${rel}`,
          });
          continue;
        }
        appliedExemptions.add(rel);
      }

      if (sameBytes(l1Path, l3Path)) {
        if (exemption) {
          violations.push({
            kind: 'stale-exemption',
            skill: '-',
            file: path.relative(root, l1Path),
            detail: `豁免已失效（两边内容已一致），请删除该豁免条目：${rel}`,
          });
        }
        continue;
      }
      if (exemption) continue;

      violations.push({
        kind: 'content-divergence',
        skill: rel.includes('/') ? rel.split('/')[0] : '-',
        file: path.relative(root, l1Path),
        detail: `分发层 ${layer.name} 的实现文件与 L3 内容不一致：${rel}（下游跑的是旧实现）`,
      });
    }
  }

  // An exemption whose file no longer exists cannot be reported here: this
  // check also runs against fixture trees that legitimately do not contain it.
  // The test suite asserts that every exemption still resolves.

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log(`\n🔍 L1 Distribution Integrity Report (Harness Phase 9 / P-003)`);
  console.log(`   L1 skills:      ${l1Skills.length}`);
  console.log(`   L3-only skills: ${l3OnlySkills.length} (不随模板分发，无对等义务)`);
  console.log(`   Manifests checked: ${manifestsChecked}`);
  console.log(`   Implementation files in file-set parity: ${filesCompared}`);
  console.log(`   Implementation files content-compared: ${contentCompared}`);
  console.log(`   Content exemptions: ${CONTENT_EXEMPTIONS.length}`);
  console.log(`   Links checked: ${linksChecked}`);
  console.log(`   Violations: ${violations.length}`);

  if (violations.length) {
    const groups = {
      'missing-manifest': '缺少 SKILL.md（skill 不可发现）',
      'invalid-manifest': 'SKILL.md frontmatter 不合规',
      'missing-implementation': '缺少实现文件（skill 在下游不可用）',
      'dead-link': '死链（指向未分发路径）',
      'content-divergence': '实现文件内容漂移（下游跑的是旧实现）',
      'stale-exemption': '豁免已失效（请删除该豁免条目）',
      'invalid-exemption': '豁免条目缺少理由',
    };
    for (const [kind, title] of Object.entries(groups)) {
      const items = violations.filter((v) => v.kind === kind);
      if (!items.length) continue;
      console.log(`\n❌ ${title}:`);
      for (const item of items) {
        console.log(`   - ${item.skill}: ${item.detail}`);
        if (verbose) console.log(`     ${item.file}`);
      }
    }
    console.log(`\n❌ L1 分发完整性检查失败 — 分发面必须与 L3 保持对等`);
    process.exit(1);
  }

  console.log(`\n✅ L1 分发完整性检查通过：manifest 完整、实现齐全、链接可达、实现内容对等`);
  process.exit(0);
}

main();
