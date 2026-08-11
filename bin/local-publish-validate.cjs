#!/usr/bin/env node
'use strict';
/**
 * local-publish-validate.cjs
 * ─────────────────────────────────────────────────────────────────────────────
 * 本地发包 + 本地安装 + 目标项目升级的本地验证循环。
 *
 * 设计原则：
 *   - **不 publish 到 npm**：仅本地 pack + 本地 volta install file: 协议
 *   - **不强制 commit / tag**：默认 commit + tag，可 --skip-commit 跳过
 *   - **可指定目标项目**：通过 --target <path> 在装完后跑 cortex-agent upgrade + update
 *   - **可 dry-run**：所有动作先打 log，不真执行
 *   - **可独立运行**：与 bin/cli.js 解耦，脚本可被 agent / shell / CI 直接调用
 *
 * 适用场景：
 *   - 框架自举验证（cortex-agent → 自己 → 消费项目）
 *   - 内部 RC dogfooding（在 release:patch/minor 前的最后一步）
 *   - 跨项目模板更新（改完 templates/ 后想看 SamHMI 侧的影响）
 *
 * 用法:
 *   node bin/local-publish-validate.cjs                           # 装本仓 + 不升级目标
 *   node bin/local-publish-validate.cjs --target ../SamHMI       # 装 + 升级 SamHMI
 *   node bin/local-publish-validate.cjs --bump rc                # 1.12.0-rc.1 → 1.12.0-rc.2
 *   node bin/local-publish-validate.cjs --bump minor             # 1.12.0-rc.2 → 1.12.0
 *   node bin/local-publish-validate.cjs --skip-tests              # 跳过测试
 *   node bin/local-publish-validate.cjs --skip-commit             # 跳过 commit + tag
 *   node bin/local-publish-validate.cjs --dry-run                 # 仅打印
 *   node bin/local-publish-validate.cjs --help                    # 帮助
 *
 * Exit codes:
 *   0  成功
 *   1  参数错误 / 前置校验失败
 *   2  测试失败（默认阻断）
 *   3  pack 失败
 *   4  volta install 失败
 *   5  目标项目 upgrade 失败
 *   6  目标项目 update 失败
 *
 * 关联:
 *   - 工作流: .agent/workflows/local-publish-validate.md
 *   - CLI:    cortex-agent local-publish-validate (lib/commands/local-publish-validate.js)
 *   - Skill:  .agents/skills/source-command-local-publish-validate/SKILL.md
 *   - 位置:   bin/local-publish-validate.cjs (版本控制 + npm tarball 包含)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

// ─── CLI args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    target: null,
    skipTests: false,
    skipCommit: false,
    bump: null,         // 'rc' | 'patch' | 'minor' | 'major' | null (= 不 bump)
    dryRun: false,
    force: false,       // 覆盖 dirty working tree
    help: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '-t') opts.target = argv[++i];
    else if (a === '--skip-tests') opts.skipTests = true;
    else if (a === '--skip-commit') opts.skipCommit = true;
    else if (a === '--bump') opts.bump = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`❌ Unknown option: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

const HELP = `local-publish-validate — 本地发包 + 本地安装 + 可选目标升级

USAGE:
  node bin/local-publish-validate.cjs [options]

OPTIONS:
  -t, --target <path>     指定升级目标项目路径（绝对或相对 cwd）
      --skip-tests        跳过测试（默认会跑 tests/test-runner.cjs --max-time 600）
      --skip-commit       跳过 git commit + tag（仅 pack + install + 升级）
      --bump <type>       bump 版本号: rc | patch | minor | major（不指定 = 不 bump）
      --dry-run           只打印动作，不执行
      --force             强制覆盖 dirty working tree（默认会阻断）
  -v, --verbose          详细输出
  -h, --help              显示此帮助

EXAMPLES:
  # 装本仓当前版本到 volta，不升级任何目标
  node bin/local-publish-validate.cjs

  # bump 到 1.12.0-rc.2 + 装 + 升级 SamHMI
  node bin/local-publish-validate.cjs --bump rc --target ../SamHMI

  # 装当前版本到 volta + 升级 SamHMI（不 bump）
  node bin/local-publish-validate.cjs --target ../SamHMI

  # dry-run 看会做什么
  node bin/local-publish-validate.cjs --target ../SamHMI --dry-run

EXIT CODES: 0 成功 / 1 参数 / 2 测试 / 3 pack / 4 install / 5 升级 / 6 update
`;

// ─── helpers ────────────────────────────────────────────────────────────────
function log(msg, opts) {
  if (opts && opts.verbose) console.log(msg);
}

function run(cmd, args, cwd, opts) {
  if ((opts && opts.dryRun) || (opts && opts.dryRunGlobal)) {
    console.log(`[DRY-RUN] $ ${cmd} ${args.join(' ')}  (cwd=${cwd || process.cwd()})`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r;
}

function runInherit(cmd, args, cwd, opts) {
  if (opts && opts.dryRun) {
    console.log(`[DRY-RUN] $ ${cmd} ${args.join(' ')}  (cwd=${cwd || process.cwd()})`);
    return { status: 0 };
  }
  return spawnSync(cmd, args, { cwd, stdio: 'inherit' });
}

function getPackageInfo(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(`❌ package.json not found at ${pkgPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function bumpVersion(current, type) {
  // 支持: 1.2.3 / 1.2.3-rc.1 / 1.2.3-rc.2 / 1.2.3-beta.5
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/);
  if (!match) {
    console.error(`❌ Unparseable version: ${current}`);
    process.exit(1);
  }
  const [, major, minor, patch, pre, preNum] = match;
  if (type === 'rc') {
    if (pre === 'rc') return `${major}.${minor}.${patch}-rc.${parseInt(preNum, 10) + 1}`;
    return `${major}.${minor}.${patch}-rc.1`;
  }
  if (type === 'patch') return `${major}.${minor}.${parseInt(patch, 10) + 1}`;
  if (type === 'minor') return `${major}.${parseInt(minor, 10) + 1}.0`;
  if (type === 'major') return `${parseInt(major, 10) + 1}.0.0`;
  console.error(`❌ Unknown bump type: ${type}`);
  process.exit(1);
}

function isDirty(cwd) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  return r.stdout.trim().length > 0;
}

function gitCommitAndTag(cwd, version, message, opts) {
  if (opts.dryRun) {
    console.log(`[DRY-RUN] git add -u && git commit -m "${message}" && git tag -a v${version} -m "v${version}"`);
    return;
  }
  runInherit('git', ['add', '-u'], cwd, opts);
  runInherit('git', ['commit', '-m', message, '--no-verify'], cwd, opts);
  runInherit('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], cwd, opts);
}

// ─── main flow ──────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const cwd = process.cwd();
  const pkg = getPackageInfo(cwd);
  const pkgName = pkg.name;
  let version = pkg.version;

  console.log(`📦 ${pkgName} @ ${version}`);
  console.log(`   cwd: ${cwd}`);
  if (opts.target) {
    const targetAbs = path.resolve(cwd, opts.target);
    console.log(`   target: ${targetAbs}`);
  }
  console.log('');

  // ── 0. Pre-flight checks ────────────────────────────────────────────────
  if (!opts.dryRun) {
    if (isDirty(cwd) && !opts.force && !opts.skipCommit) {
      console.error('❌ Working tree is dirty. Commit / stash first, or pass --force (with --skip-commit or explicit accept).');
      process.exit(1);
    }
    if (isDirty(cwd) && !opts.force && opts.skipCommit) {
      console.error('❌ Working tree is dirty and --skip-commit set; refusing to pack a dirty tree.');
      process.exit(1);
    }
  } else {
    if (isDirty(cwd)) console.log('⚠️  [DRY-RUN] Working tree is dirty; would block real run');
  }

  // ── 1. Bump version (optional) ──────────────────────────────────────────
  if (opts.bump) {
    const newVersion = bumpVersion(version, opts.bump);
    console.log(`🔼 Bump: ${version} → ${newVersion}  (${opts.bump})`);
    if (!opts.dryRun) {
      const pkgPath = path.join(cwd, 'package.json');
      const updated = { ...pkg, version: newVersion };
      fs.writeFileSync(pkgPath, JSON.stringify(updated, null, 2) + '\n');
    }
    version = newVersion;
  } else {
    console.log(`⏭  No version bump (current: ${version})`);
  }

  // ── 2. Run tests (optional) ─────────────────────────────────────────────
  if (!opts.skipTests) {
    console.log('🧪 Running tests (max-time 600)...');
    const r = runInherit('node', ['scripts/test-runner.cjs', '--max-time', '600'], cwd, opts);
    if (r.status !== 0 && !opts.force) {
      console.error(`❌ Tests failed (exit ${r.status}). Pass --force to proceed despite failures.`);
      process.exit(2);
    }
    if (r.status !== 0) console.log('⚠️  Tests failed but --force set; proceeding.');
  } else {
    console.log('⏭  Skip tests');
  }

  // ── 3. Commit + tag (optional) ──────────────────────────────────────────
  if (!opts.skipCommit) {
    const msg = `chore(local-publish-validate): ${version} — local pack+install+upgrade cycle`;
    console.log(`📝 Commit + tag: v${version}`);
    gitCommitAndTag(cwd, version, msg, opts);
  } else {
    console.log('⏭  Skip commit/tag');
  }

  // ── 4. npm pack ────────────────────────────────────────────────────────
  console.log('📦 npm pack...');
  const packR = run('npm', ['pack', '--silent'], cwd, opts);
  if (packR.status !== 0) {
    console.error('❌ npm pack failed');
    console.error(packR.stderr);
    process.exit(3);
  }
  const tarball = packR.stdout.trim().split('\n').pop();
  if (!fs.existsSync(path.join(cwd, tarball))) {
    console.error(`❌ Expected tarball not found: ${tarball}`);
    process.exit(3);
  }
  console.log(`   → ${tarball}`);

  // ── 5. volta install ────────────────────────────────────────────────────
  console.log('⚡ volta install (file: protocol)...');
  const tarballAbs = path.join(cwd, tarball);
  const installR = runInherit('volta', ['install', `${pkgName}@file:${tarballAbs}`], cwd, opts);
  if (installR.status !== 0) {
    console.error(`❌ volta install failed (exit ${installR.status})`);
    process.exit(4);
  }

  // ── 6. Target upgrade (optional) ────────────────────────────────────────
  if (opts.target) {
    const targetAbs = path.resolve(cwd, opts.target);
    if (!fs.existsSync(targetAbs)) {
      console.error(`❌ Target not found: ${targetAbs}`);
      process.exit(1);
    }
    if (!fs.existsSync(path.join(targetAbs, '.agent'))) {
      console.warn(`⚠️  Target has no .agent/ — skipping cortex-agent upgrade`);
    } else {
      console.log(`🔄 Target upgrade: ${targetAbs}`);
      const upR = runInherit('cortex-agent', ['upgrade'], targetAbs, opts);
      if (upR.status !== 0) {
        console.error(`❌ cortex-agent upgrade failed (exit ${upR.status})`);
        process.exit(5);
      }
      const updR = runInherit('cortex-agent', ['update'], targetAbs, opts);
      if (updR.status !== 0) {
        console.error(`❌ cortex-agent update failed (exit ${updR.status})`);
        process.exit(6);
      }
    }
  } else {
    console.log('⏭  No target — install only');
  }

  // ── 7. Summary ──────────────────────────────────────────────────────────
  console.log('');
  console.log('✅ local-publish-validate complete');
  console.log(`   package:  ${pkgName}@${version}`);
  console.log(`   tarball:  ${tarball}`);
  console.log(`   volta:    installed via file: protocol`);
  if (opts.target) console.log(`   target:   ${path.resolve(cwd, opts.target)} upgraded + updated`);
  console.log('');
  console.log('Next steps (manual):');
  console.log('  - Review the diff (if any) in the target project');
  console.log('  - git push from the source repo (if not yet pushed)');
  console.log('  - publish to npm only when you actually want external consumers to get this version');
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error('❌ Unhandled error:', e && e.message);
  if (process.env.DEBUG) console.error(e && e.stack);
  process.exit(1);
}
