#!/usr/bin/env node
'use strict';
/**
 * local-publish-validate.cjs
 * ─────────────────────────────────────────────────────────────────────────────
 * 本地发包 + 本地安装 + 目标项目升级的本地验证循环。
 *
 * 设计原则：
 *   - **工具自身不 publish 到 npm**：默认仅本地 pack + 本地 volta install file: 协议
 *   - **不强制 commit / tag**：默认 commit + tag，可 --skip-commit 跳过
 *   - **可指定目标项目**：通过 --target <path> 在装完后跑 cortex-agent upgrade + update
 *   - **可 dry-run**：所有动作先打 log，不真执行
 *   - **可 stage-only**：工具自身仅构建/测试/pack 候选，不直接安装/运行目标 CLI/bump/commit/tag
 *     候选及完整 SHA-256 写入 cwd/.agent/runtime/local-publish-validate 的唯一目录。
 *     当前不支持 detached-local / 未认证的 .agent 符号链接；不认证链接目标，保持拒绝。
 *     构建、测试与 npm lifecycle 是可能产生副作用的受信代码，不证明进程树或源/目标不变。
 *     stage pack 用 --ignore-scripts 关闭 lifecycle；prepack/prepare 所需产物须提前构建核验。
 *     实际 pack 前重读 package.json；name/version 变化拒绝，禁用 hooks 取该快照。
 *     不验证生命周期产物完整性，不等同完整发布包、项目兼容验证或生产授权。
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
 *   node bin/local-publish-validate.cjs --stage-only              # 仅生成开发候选
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
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const versionCarriers = require('../lib/release/version-carriers');

// A local bump is not a publication, so the changelog section it writes is a
// placeholder: the version must be documented for the release consistency
// gate to pass, but the notes still have to be written before publishing.
const CHANGELOG_PLACEHOLDER =
  '> **本地自举**：由 `cortex-agent local-publish-validate --bump` 生成的本地版本条目，发布前请补齐变更说明。';

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
    stageOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '-t' || a === '--bump') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) { console.error(`❌ Missing value for ${a}`); process.exit(1); }
      if (a === '--bump') opts.bump = value;
      else opts.target = value;
    }
    else if (a === '--skip-tests') opts.skipTests = true;
    else if (a === '--skip-commit') opts.skipCommit = true;
    else if (a === '--stage-only') opts.stageOnly = true;
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
      --stage-only        工具自身仅构建/测试/pack，不直接安装/运行目标 CLI/bump/commit/tag
                          写 cwd/.agent/runtime/local-publish-validate 唯一目录及完整 SHA-256
                          当前不支持 detached-local / 未认证的 .agent 符号链接（未认证链接目标）
                          未验证目标项目，非生产授权；拒绝 --target/--bump/--skip-tests/--force
                          构建/测试/npm lifecycle 为受信代码，可能有副作用；不保证进程树无副作用
                          pack 用 --ignore-scripts；prepack/prepare 产物须提前构建核验，不等同完整发布包
      --skip-tests        跳过测试（默认会跑 scripts/test-runner.cjs --max-time 600）
      --skip-commit       跳过 git commit + tag（仅 pack + install + 升级）
      --bump <type>       bump 版本号: rc | patch | minor | major（不指定 = 不 bump）
      --dry-run           只打印动作，不执行；stage 目录/绑定未验证，实际运行可能拒绝
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

  # 仅生成开发候选（可配合 --dry-run；无 npm pack lifecycle hooks）
  node bin/local-publish-validate.cjs --stage-only

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
  const r = spawnSync(cmd, args, { cwd, env: opts && opts.childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r;
}

function runInherit(cmd, args, cwd, opts) {
  if (opts && opts.dryRun) {
    console.log(`[DRY-RUN] $ ${cmd} ${args.join(' ')}  (cwd=${cwd || process.cwd()})`);
    return { status: 0 };
  }
  return spawnSync(cmd, args, { cwd, env: opts && opts.childEnv, stdio: 'inherit' });
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
  // `--ignore-submodules=all` is required, not cosmetic: `.agent/` is a
  // gitlink, and in a worktree it is commonly a symlink to the shared
  // governance repository. Plain `git status` refuses to run in that shape
  // ("expected submodule path '.agent' not to be a symbolic link") and exits
  // non-zero, which this helper would misread as "the tree is dirty".
  const r = spawnSync('git', ['status', '--porcelain', '--ignore-submodules=all'], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return r.stdout.trim().length > 0;
}

function gitCommitAndTag(cwd, version, message, opts) {
  if (opts.dryRun) {
    console.log(`[DRY-RUN] git add -u && git commit -m "${message}" && git tag -a v${version} -m "v${version}"`);
    return;
  }
  runInherit('git', ['add', '-u'], cwd, opts);
  // `--no-verify` below disables every pre-commit hook, including the L3
  // distribution boundary gate. Publishing is precisely when that gate must not
  // be skipped: it is the last point before templates/ reaches every managed
  // project. Run it explicitly so the release path cannot ship L3 content that
  // belongs in <repo>/.agent/ only.
  const gateScript = path.join(cwd, 'scripts', 'check-l3-boundary.js');
  if (fs.existsSync(gateScript)) {
    const gateRun = spawnSync(process.execPath, [gateScript], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (gateRun.status !== 0) {
      process.stdout.write(gateRun.stdout || '');
      process.stderr.write(gateRun.stderr || '');
      console.error('❌ L3 distribution boundary check failed; refusing to commit and tag.');
      console.error('   L3 内容只能留在 <repo>/.agent/（标记 scope: L3），不得进入 templates/。');
      process.exit(1);
    }
  }
  runInherit('git', ['commit', '-m', message, '--no-verify'], cwd, opts);
  runInherit('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], cwd, opts);
}

// ─── main flow ──────────────────────────────────────────────────────────────
function validateTarget(target) {
  if (!target) return;
  try { if (fs.statSync(target).isDirectory()) return; } catch { /* fixed refusal below */ }
  console.error(`❌ Target not found or not a directory: ${target}`);
  process.exit(1);
}

function stageDirectory(cwd) {
  // Refuse redirection before writing into an existing component. This is a
  // local tool path check, not an OS exclusion or hostile-filesystem guarantee.
  let directory = cwd;
  for (const part of ['.agent', 'runtime', 'local-publish-validate']) {
    directory = path.join(directory, part);
    let stat;
    try { stat = fs.lstatSync(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (part === '.agent' && stat && stat.isSymbolicLink()) {
      throw new Error(`Stage-only currently does not support detached-local / unauthenticated .agent symlinks; the link target is not authenticated, so this tool refuses it: ${directory}`);
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe stage directory: ${directory}`);
    if (!stat) fs.mkdirSync(directory);
  }
  return fs.mkdtempSync(path.join(directory, 'stage-'));
}

function stageCandidate(cwd, pkg, opts) {
  const directory = opts.dryRun
    ? path.join(cwd, '.agent', 'runtime', 'local-publish-validate', 'stage-<unique>') : stageDirectory(cwd);
  if (opts.dryRun) console.log('[DRY-RUN] Stage directory and bindings are not verified; actual execution may refuse, including unsupported detached-local / unauthenticated .agent symlinks. No child tools are executed.');
  console.log('Stage-only: direct tool calls do not install, invoke target CLI, bump, commit or tag the source repository.');
  console.log('Target project: not validated. Non-production; no production authorization.');
  console.log('Trusted build/test code and npm lifecycle code may have side effects; process-tree effects and source/target immutability are not verified.');
  console.log('Pack uses --ignore-scripts: prepack/prepare outputs must already be built and reviewed; this candidate is not verified equivalent to a complete release package.');
  if (!opts.dryRun) {
    const scratch = path.join(directory, 'tmp'); fs.mkdirSync(scratch);
    opts.childEnv = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      npm_config_cache: path.join(directory, 'npm-cache') };
  }
  console.log('🔨 Building (if present)...');
  const build = runInherit('npm', ['run', 'build', '--if-present'], cwd, opts);
  if (build.status !== 0) { console.error('❌ Stage build failed'); return 2; }
  console.log('🧪 Running tests (max-time 600)...');
  const tests = runInherit('node', ['scripts/test-runner.cjs', '--max-time', '600'], cwd, opts);
  if (tests.status !== 0) { console.error('❌ Stage tests failed'); return 2; }
  if (opts.dryRun) {
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], cwd, opts);
    console.log('[DRY-RUN] Pre-pack package snapshot not verified; SHA-256/manifest not generated; no candidate created.');
    return 0;
  }
  try {
    // Trusted build/test code can rewrite package.json. Bind the hook report
    // and npm metadata checks to a fresh pre-pack snapshot, not startup data.
    const packPackage = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (packPackage.name !== pkg.name || packPackage.version !== pkg.version) {
      throw new Error('Package name/version changed during build/tests; refusing npm pack');
    }
    const configuredPackHooks = ['prepack', 'prepare', 'postpack'].filter(name => packPackage.scripts && packPackage.scripts[name]);
    if (configuredPackHooks.length) console.warn(`⚠️  Disabled pack lifecycle scripts: ${configuredPackHooks.join(', ')}; required generated assets may be missing or stale.`);
    const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], cwd, opts);
    if (packed.status !== 0) throw new Error(`npm pack failed (exit ${packed.status}, signal ${packed.signal || 'none'})`);
    const rows = JSON.parse(packed.stdout);
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Expected one packed candidate');
    const { filename, name, version } = rows[0];
    if (name !== packPackage.name || version !== packPackage.version || typeof filename !== 'string' ||
        !filename.endsWith('.tgz') || path.basename(filename) !== filename || filename.includes('\\')) throw new Error('Invalid candidate metadata');
    const file = path.join(directory, filename), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Candidate is not a regular file');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const manifest = { mode: 'stage-only', productionReady: false, projectValidation: 'not-performed',
      directToolActions: { scope: 'local-publish-validate-direct-calls-only',
        sourceRepository: { versionBump: false, gitCommit: false, gitTag: false }, voltaInstall: false, targetCli: false },
      trustBoundary: { buildTestAndNpmLifecycle: 'trusted-execution-code-may-have-side-effects',
        processTreeSideEffects: 'not-audited', sourceAndTargetImmutability: 'not-asserted' },
      packPolicy: { ignoreScripts: true, configurationSnapshot: 'reread-after-build-tests-before-pack',
        disabledConfiguredHooks: configuredPackHooks,
        lifecycleGeneratedAssets: 'must-be-built-and-reviewed-separately', completeReleasePackageEquivalence: 'not-verified' },
      build: pkg.scripts && pkg.scripts.build ? 'passed' : 'not-configured', tests: 'passed',
      package: { name, version }, artifact: { filename, sha256, bytes: stat.size } };
    fs.writeFileSync(path.join(directory, 'stage.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(`✅ Stage-only candidate: ${file}`);
    console.log(`   package: ${name}@${version}`);
    console.log(`   sha256: ${sha256}`);
    return 0;
  } catch (error) {
    console.error(`❌ Stage pack failed: ${error.message}`);
    return 3;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.stageOnly && (opts.target || opts.bump || opts.skipTests || opts.force)) {
    console.error('❌ --stage-only conflicts with --target, --bump, --skip-tests and --force.');
    return 1;
  }

  const cwd = process.cwd();
  const pkg = getPackageInfo(cwd);
  const pkgName = pkg.name;
  let version = pkg.version;
  const targetAbs = opts.target ? path.resolve(cwd, opts.target) : null;
  validateTarget(targetAbs); // Before bump, tests, pack, commit or installation.

  console.log(`📦 ${pkgName} @ ${version}`);
  console.log(`   cwd: ${cwd}`);
  if (opts.target) {
    const targetAbs = path.resolve(cwd, opts.target);
    console.log(`   target: ${targetAbs}`);
  }
  console.log('');
  if (opts.stageOnly) return stageCandidate(cwd, pkg, opts);

  // ── 0. Pre-flight checks ────────────────────────────────────────────────
  // A dirty tree always needs --force. --skip-commit does NOT relax this: it
  // only means "don't commit or tag", and a tarball built from uncommitted work
  // is indistinguishable from a release once it is installed by name+version.
  // (The workflow doc used to claim --skip-commit permitted a dirty tree; that
  // was wrong, and contradicted its own 注意事项 6. Fixed there too.)
  if (!opts.dryRun) {
    if (isDirty(cwd) && !opts.force) {
      console.error('❌ Working tree is dirty.');
      console.error('   Commit / stash first, or pass --force to accept packing uncommitted work.');
      console.error('   --skip-commit does not bypass this; it only skips commit + tag.');
      process.exit(1);
    }
  } else {
    // --dry-run skips the guard above, so mirror it faithfully: warn only when a
    // real run would actually be blocked.
    if (isDirty(cwd) && !opts.force) {
      console.log('⚠️  [DRY-RUN] Working tree is dirty; a real run would need --force');
    }
  }

  // ── 1. Bump version (optional) ──────────────────────────────────────────
  if (opts.bump) {
    const newVersion = bumpVersion(version, opts.bump);
    console.log(`🔼 Bump: ${version} → ${newVersion}  (${opts.bump})`);
    if (!opts.dryRun) {
      // Every version carrier has to move together. Rewriting package.json
      // alone leaves the lockfile, the Claude plugin manifest, the
      // marketplace manifest and the changelog on the old version — a tree the
      // repository's own release consistency gate rejects
      // (tests/release/release-version-consistency.test.js).
      const sync = versionCarriers.syncVersion(cwd, newVersion);
      console.log(`   版本载体已同步 (${sync.changed.length}): ${sync.changed.join(', ') || '(无变化)'}`);
      if (sync.missing.length > 0) {
        console.log(`   版本载体缺失 (${sync.missing.length}): ${sync.missing.join(', ')}`);
      }
      const changelog = versionCarriers.ensureChangelogEntry(cwd, newVersion, CHANGELOG_PLACEHOLDER);
      if (changelog.created) {
        console.log(`   已写入 CHANGELOG.md 条目: ## [${newVersion}]（占位说明，发布前请补齐变更说明）`);
      }
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
  // Pack into the local build dir (.build/tarballs) so the repo root stays clean.
  console.log('📦 npm pack...');
  const buildTarballs = path.join(cwd, '.build', 'tarballs');
  if (!opts.dryRun) fs.mkdirSync(buildTarballs, { recursive: true });
  const packR = run('npm', ['pack', '--silent', '--pack-destination', buildTarballs], cwd, opts);
  if (packR.status !== 0) {
    console.error('❌ npm pack failed');
    console.error(packR.stderr);
    process.exit(3);
  }
  const tarball = opts.dryRun ? '<planned-candidate.tgz>' : packR.stdout.trim().split('\n').pop();
  if (!opts.dryRun && (!tarball || path.basename(tarball) !== tarball ||
      !fs.existsSync(path.join(buildTarballs, tarball)) || !fs.statSync(path.join(buildTarballs, tarball)).isFile())) {
    console.error(`❌ Expected tarball not found: ${tarball} (in .build/tarballs)`);
    process.exit(3);
  }
  console.log(`   → .build/tarballs/${tarball}`);

  // ── 5. volta install ────────────────────────────────────────────────────
  console.log('⚡ volta install (file: protocol)...');
  validateTarget(targetAbs); // Recheck after build/test hooks, before install.
  const tarballAbs = path.join(buildTarballs, tarball);
  const installR = runInherit('volta', ['install', `${pkgName}@file:${tarballAbs}`], cwd, opts);
  if (installR.status !== 0) {
    console.error(`❌ volta install failed (exit ${installR.status})`);
    process.exit(4);
  }

  // ── 6. Target upgrade (optional) ────────────────────────────────────────
  let targetStatus = 'not requested';
  if (opts.target) {
    validateTarget(targetAbs);
    if (!fs.existsSync(path.join(targetAbs, '.agent')) || !fs.statSync(path.join(targetAbs, '.agent')).isDirectory()) {
      console.warn(`⚠️  Target has no .agent/ — skipping cortex-agent upgrade`);
      targetStatus = 'skipped (no .agent/ directory)';
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
      targetStatus = opts.dryRun ? 'planned upgrade + update (not executed)' : 'upgraded + updated';
    }
  } else {
    console.log('⏭  No target — install only');
  }

  // ── 7. Summary ──────────────────────────────────────────────────────────
  console.log('');
  console.log('✅ local-publish-validate complete');
  console.log(`   package:  ${pkgName}@${version}`);
  console.log(`   tarball:  ${tarball}`);
  console.log(`   volta:    ${opts.dryRun ? 'planned install (not executed)' : 'installed via file: protocol'}`);
  if (opts.target) console.log(`   target:   ${targetAbs} ${targetStatus}`);
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
