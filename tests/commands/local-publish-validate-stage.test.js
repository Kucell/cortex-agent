'use strict';

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'bin/local-publish-validate.cjs');
const WRAPPER = path.join(ROOT, 'lib/commands/local-publish-validate.js');
const CLI = path.join(ROOT, 'bin/cli.js');
const PRELOAD = path.join(__dirname, 'fixtures/local-publish-validate-stage-child.cjs');

function fixture(t) {
  const base = testRuntime("test-tmp"); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'local publish stage '));
  const project = path.join(root, 'source with spaces'), target = path.join(root, 'target with spaces');
  fs.mkdirSync(project); fs.mkdirSync(target); fs.mkdirSync(path.join(target, '.agent'));
  const pkg = { name: '@fixture/stage-candidate', version: '1.2.3-rc.4', scripts: { build: 'synthetic' } };
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(project, 'package-lock.json'), 'unchanged lock\n');
  fs.writeFileSync(path.join(project, 'CHANGELOG.md'), 'unchanged changelog\n');
  fs.mkdirSync(path.join(project, '.agent'));
  fs.writeFileSync(path.join(project, '.agent/version-stamp'), 'unchanged source\n');
  fs.writeFileSync(path.join(target, '.agent/version-stamp'), 'unchanged target\n');
  const eventsFile = path.join(root, 'events.jsonl');
  const run = (args, { wrapper = true, cli = false, realPack = false, fault, dirty = false, log = true } = {}) => {
    fs.rmSync(eventsFile, { force: true });
    const wrapperCode = `process.exitCode=require(${JSON.stringify(WRAPPER)}).localPublishValidate({args:['local-publish-validate',...process.argv.slice(1)],lang:'en'});`;
    const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`,
      TMPDIR: root, TMP: root, TEMP: root, LPV_EVENTS: log ? eventsFile : '', LPV_FAULT: fault || '', LPV_DIRTY: dirty ? '1' : '', LPV_TARGET: target,
      LPV_REAL_PACK: realPack ? '1' : '' };
    const result = spawnSync(process.execPath, cli ? [CLI, 'local-publish-validate', ...args] : wrapper ? ['-e', wrapperCode, '--', ...args] : [SCRIPT, ...args],
      { cwd: project, env, encoding: 'utf8', timeout: 15000 });
    const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.equal(result.error, undefined);
    return { ...result, out: result.stdout + result.stderr, events };
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project, target, pkg, run };
}
function snapshot(directory) {
  const result = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.statSync(file);
      result[path.relative(directory, file)] = stat.isDirectory() ? 'directory' : fs.readFileSync(file).toString('base64');
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(directory); return result;
}
function stageDirectories(f) {
  const base = path.join(f.project, '.agent/runtime/local-publish-validate');
  return fs.existsSync(base) ? fs.readdirSync(base).map(name => path.join(base, name)) : [];
}

test('real wrapper forwards stage-only; unique runtime candidates have exact SHA-256 and truthful non-production metadata', t => {
  const f = fixture(t), before = snapshot(f.project), targetBefore = snapshot(f.target);
  for (let i = 0; i < 2; i++) {
    const r = f.run(['--stage-only'], { dirty: true }); assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.events.map(e => [e.command, e.args[0]]), [['npm', 'run'], ['node', 'scripts/test-runner.cjs'], ['npm', 'pack']]);
    assert.ok(r.events[2].args.includes('--ignore-scripts'));
    assert.match(r.out, /not validated/); assert.match(r.out, /Non-production/);
    const directories = stageDirectories(f); assert.equal(directories.length, i + 1);
    for (const directory of directories) {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'stage.json'), 'utf8'));
      assert.equal(manifest.mode, 'stage-only'); assert.equal(manifest.productionReady, false);
      assert.equal(manifest.projectValidation, 'not-performed'); assert.deepEqual(manifest.package, { name: f.pkg.name, version: f.pkg.version });
      for (const key of ['installed', 'targetCliInvoked', 'versionBumped', 'committed', 'tagged', 'version_changed']) assert.equal(Object.hasOwn(manifest, key), false);
      assert.deepEqual(manifest.directToolActions, { scope: 'local-publish-validate-direct-calls-only',
        sourceRepository: { versionBump: false, gitCommit: false, gitTag: false }, voltaInstall: false, targetCli: false });
      assert.equal(manifest.trustBoundary.processTreeSideEffects, 'not-audited');
      assert.equal(manifest.trustBoundary.sourceAndTargetImmutability, 'not-asserted');
      assert.equal(manifest.packPolicy.ignoreScripts, true);
      assert.equal(manifest.packPolicy.configurationSnapshot, 'reread-after-build-tests-before-pack');
      assert.equal(manifest.packPolicy.completeReleasePackageEquivalence, 'not-verified');
      const bytes = fs.readFileSync(path.join(directory, manifest.artifact.filename));
      assert.equal(manifest.artifact.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
      assert.equal(manifest.artifact.sha256.length, 64); assert.equal(manifest.artifact.bytes, bytes.length);
      assert.ok(r.out.includes(manifest.artifact.sha256));
    }
    for (const event of r.events) {
      assert.equal(event.cwd, f.project);
      assert.ok(event.tmp.startsWith(path.join(f.project, '.agent/runtime/local-publish-validate/stage-')));
      assert.ok(event.cache.startsWith(path.join(f.project, '.agent/runtime/local-publish-validate/stage-')));
    }
  }
  for (const name of Object.keys(before)) assert.equal(snapshot(f.project)[name], before[name]);
  assert.deepEqual(snapshot(f.target), targetBefore); assert.equal(fs.existsSync(path.join(f.project, '.build')), false);
});

for (const args of [['--target', 'target'], ['-t', 'target'], ['--bump', 'rc'], ['--skip-tests'], ['--force']]) {
  test(`stage-only rejects conflicting ${args[0]} before subprocesses or writes`, t => {
    const f = fixture(t), before = snapshot(f.project);
    const r = f.run(['--stage-only', ...args]); assert.equal(r.status, 1, r.out);
    assert.match(r.out, /conflicts/); assert.deepEqual(r.events, []); assert.deepEqual(snapshot(f.project), before);
  });
}

test('stage-only accepts redundant skip-commit while omitting direct git/installation/target commands', t => {
  const f = fixture(t), r = f.run(['--stage-only', '--skip-commit']); assert.equal(r.status, 0, r.out);
  assert.ok(!r.events.some(e => ['git', 'volta', 'cortex-agent'].includes(e.command)));
});

for (const fault of ['pack', 'signal', 'spawn', 'missing', 'metadata', 'path']) {
  test(`stage pack ${fault} is nonzero through the real wrapper and never produces a successful stage manifest`, t => {
    const f = fixture(t), r = f.run(['--stage-only'], { fault }); assert.equal(r.status, 3, r.out);
    assert.ok(!r.events.some(e => ['volta', 'cortex-agent', 'git'].includes(e.command)));
    assert.equal(stageDirectories(f).length, 1);
    assert.equal(fs.existsSync(path.join(stageDirectories(f)[0], 'stage.json')), false);
  });
}

for (const fault of ['build', 'tests']) test(`stage ${fault} failure stops before pack without force bypass`, t => {
  const f = fixture(t), r = f.run(['--stage-only'], { fault }); assert.equal(r.status, 2, r.out);
  assert.ok(!r.events.some(e => e.args[0] === 'pack' || ['volta', 'git', 'cortex-agent'].includes(e.command)));
});

for (const kind of ['missing', 'file']) test(`default mode rejects ${kind} target before any install, test, bump or commit`, t => {
  const f = fixture(t), target = path.join(f.root, 'invalid target');
  if (kind === 'file') fs.writeFileSync(target, 'file');
  const before = snapshot(f.project), r = f.run(['--target', target, '--bump', 'patch']);
  assert.equal(r.status, 1, r.out); assert.match(r.out, /not found or not a directory/);
  assert.deepEqual(r.events, []); assert.deepEqual(snapshot(f.project), before);
});

test('default install remains available but missing .agent truthfully reports skipped and never invokes target CLI', t => {
  const f = fixture(t); fs.rmSync(path.join(f.target, '.agent'), { recursive: true });
  const r = f.run(['--target', f.target, '--skip-tests', '--skip-commit']); assert.equal(r.status, 0, r.out);
  assert.equal(r.events.filter(e => e.command === 'volta').length, 1);
  assert.equal(r.events.filter(e => e.command === 'cortex-agent').length, 0);
  assert.match(r.out, /target:.*skipped \(no \.agent\/ directory\)/); assert.doesNotMatch(r.out, /upgraded \+ updated/);
});

test('default managed target uses install then upgrade/update and preserves spaced argv paths', t => {
  const f = fixture(t), r = f.run(['--target', f.target, '--skip-tests', '--skip-commit']); assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.events.filter(e => ['volta', 'cortex-agent'].includes(e.command)).map(e => [e.command, e.args[0]]),
    [['volta', 'install'], ['cortex-agent', 'upgrade'], ['cortex-agent', 'update']]);
  assert.match(r.events.find(e => e.command === 'volta').args[1], /candidate with spaces\.tgz$/);
  for (const event of r.events.filter(e => e.command === 'cortex-agent')) assert.equal(event.cwd, f.target);
  assert.match(r.out, /upgraded \+ updated/);
});

for (const stage of [false, true]) test(`${stage ? 'stage' : 'default'} dry-run creates no directories, stamp changes, or empty-tarball lookup`, t => {
  const f = fixture(t), before = snapshot(f.root);
  const args = stage ? ['--stage-only', '--dry-run'] : ['--dry-run', '--bump', 'rc', '--target', f.target];
  const r = f.run(args, { log: false }); assert.equal(r.status, 0, r.out);
  assert.deepEqual(snapshot(f.root), before); assert.match(r.out, /DRY-RUN/);
  if (stage) {
    assert.match(r.out, /Pre-pack package snapshot not verified/);
    assert.match(r.out, /Stage directory and bindings are not verified; actual execution may refuse/);
    assert.deepEqual(r.events, []);
  }
  assert.doesNotMatch(r.out, /Expected tarball not found|upgraded \+ updated|installed via file:/);
});

test('script and both wrapper help texts document stage boundaries and conflicts', t => {
  const f = fixture(t);
  for (const wrapper of [false, true]) {
    const r = f.run(['--help'], { wrapper }); assert.equal(r.status, 0, r.out);
    assert.match(r.out, /--stage-only/); assert.match(r.out, /SHA-256/); assert.match(r.out, /--skip-tests/);
    assert.match(r.out, /detached-local/); assert.match(r.out, /\.agent/);
  }
  const { HELP_EN, HELP_ZH } = require('../../lib/commands/local-publish-validate');
  assert.match(HELP_EN, /no production authorization/); assert.match(HELP_EN, /Conflicts/);
  assert.match(HELP_EN, /side effects are possible/); assert.match(HELP_EN, /prepack\/prepare/);
  assert.match(HELP_EN, /Currently unsupported: detached-local \/ unauthenticated \.agent symlinks/);
  assert.match(HELP_EN, /Link targets are not authenticated/);
  assert.match(HELP_EN, /stage directory\/bindings unverified, real run may refuse/);
  assert.match(HELP_ZH, /非生产授权/); assert.match(HELP_ZH, /拒绝 --target/);
  assert.match(HELP_ZH, /不保证进程树或源\/目标不变/);
  assert.match(HELP_ZH, /当前不支持 detached-local \/ 未认证的 \.agent 符号链接/);
  assert.match(HELP_ZH, /stage 目录\/绑定未验证，实际运行可能拒绝/);
});

test('real bin/cli.js forwards stage flags and child pack failure without routing to install or a target', t => {
  const f = fixture(t);
  const staged = f.run(['--stage-only', '--skip-commit', '--verbose'], { cli: true });
  assert.equal(staged.status, 0, staged.out);
  assert.deepEqual(staged.events.map(e => [e.command, e.args[0]]), [['npm', 'run'], ['node', 'scripts/test-runner.cjs'], ['npm', 'pack']]);
  assert.equal(stageDirectories(f).length, 1);
  const failed = f.run(['--stage-only'], { cli: true, fault: 'signal' });
  assert.equal(failed.status, 3, failed.out);
  const conflicting = f.run(['--stage-only', '--target', f.target], { cli: true });
  assert.equal(conflicting.status, 1, conflicting.out); assert.match(conflicting.out, /conflicts/);
  assert.deepEqual(conflicting.events, []);
});

test('manifest describes only direct tool operations even when trusted tests mutate source and target stamps', t => {
  const f = fixture(t), result = f.run(['--stage-only'], { cli: true, fault: 'side-effects' });
  assert.equal(result.status, 0, result.out);
  assert.equal(fs.readFileSync(path.join(f.project, '.agent/version-stamp'), 'utf8'), 'trusted test side effect\n');
  assert.equal(fs.readFileSync(path.join(f.target, '.agent/version-stamp'), 'utf8'), 'trusted test target side effect\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(stageDirectories(f)[0], 'stage.json'), 'utf8'));
  assert.equal(manifest.directToolActions.sourceRepository.gitCommit, false);
  assert.equal(manifest.trustBoundary.sourceAndTargetImmutability, 'not-asserted');
  assert.match(result.out, /process-tree effects and source\/target immutability are not verified/);
});

test('real fixture npm pack disables all pack hooks and preserves already built artifacts, without release-equivalence claims', t => {
  const f = fixture(t), packageFile = path.join(f.project, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  pkg.files = ['dist'];
  for (const hook of ['prepack', 'prepare', 'postpack']) pkg.scripts[hook] = 'node -e "throw new Error(\'pack lifecycle must not execute\')"';
  fs.writeFileSync(packageFile, JSON.stringify(pkg));
  fs.mkdirSync(path.join(f.project, 'dist')); fs.writeFileSync(path.join(f.project, 'dist/built.js'), 'already built artifact\n');
  const result = f.run(['--stage-only'], { realPack: true }); assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Disabled pack lifecycle scripts: prepack, prepare, postpack/);
  assert.match(result.out, /may be missing or stale/);
  const directory = stageDirectories(f)[0], manifest = JSON.parse(fs.readFileSync(path.join(directory, 'stage.json'), 'utf8'));
  const artifact = fs.readFileSync(path.join(directory, manifest.artifact.filename));
  assert.equal(manifest.artifact.sha256, crypto.createHash('sha256').update(artifact).digest('hex'));
  assert.equal(manifest.artifact.bytes, artifact.length);
  assert.deepEqual(manifest.packPolicy.disabledConfiguredHooks, ['prepack', 'prepare', 'postpack']);
  assert.equal(manifest.packPolicy.completeReleasePackageEquivalence, 'not-verified');
  const packed = spawnSync('tar', ['-xOf', path.join(directory, manifest.artifact.filename), 'package/dist/built.js'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: f.root, TMP: f.root, TEMP: f.root } });
  assert.equal(packed.status, 0, packed.stderr); assert.equal(packed.stdout, 'already built artifact\n');
});

for (const phase of ['build', 'tests']) {
  test(`pre-pack snapshot reports the hook added by trusted ${phase} code, with real npm pack`, t => {
    const f = fixture(t), result = f.run(['--stage-only'], { cli: true, realPack: true, fault: `${phase}-add-hook` });
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /Disabled pack lifecycle scripts: prepack/);
    const directory = stageDirectories(f)[0], manifest = JSON.parse(fs.readFileSync(path.join(directory, 'stage.json'), 'utf8'));
    assert.deepEqual(manifest.packPolicy.disabledConfiguredHooks, ['prepack']);
    assert.equal(manifest.packPolicy.configurationSnapshot, 'reread-after-build-tests-before-pack');
    assert.deepEqual(manifest.package, { name: f.pkg.name, version: f.pkg.version });
    const artifact = fs.readFileSync(path.join(directory, manifest.artifact.filename));
    assert.equal(manifest.artifact.sha256, crypto.createHash('sha256').update(artifact).digest('hex'));
    assert.equal(manifest.artifact.bytes, artifact.length);
  });
  for (const field of ['name', 'version']) test(`trusted ${phase} changing package ${field} fails before npm pack and success manifest`, t => {
    const f = fixture(t), result = f.run(['--stage-only'], { cli: true, fault: `${phase}-${field}` });
    assert.equal(result.status, 3, result.out); assert.match(result.out, /Package name\/version changed during build\/tests/);
    assert.ok(!result.events.some(e => e.command === 'npm' && e.args[0] === 'pack'));
    assert.ok(!result.events.some(e => ['git', 'volta', 'cortex-agent'].includes(e.command)));
    const directory = stageDirectories(f)[0];
    assert.equal(fs.existsSync(path.join(directory, 'stage.json')), false);
    assert.ok(!fs.readdirSync(directory).some(name => name.endsWith('.tgz')));
  });
}

for (const relative of [false, true]) test(`stage refuses ${relative ? 'relative' : 'absolute'} .agent links with the unsupported detached-local diagnostic`, t => {
  const f = fixture(t); fs.rmSync(path.join(f.project, '.agent'), { recursive: true });
  const link = path.join(f.project, '.agent');
  fs.symlinkSync(relative ? path.relative(f.project, f.target) : f.target, link, 'dir');
  const before = snapshot(f.target), linkBefore = fs.readlinkSync(link);
  const r = f.run(['--stage-only'], { cli: true }); assert.equal(r.status, 1, r.out);
  assert.match(r.out, /currently does not support detached-local \/ unauthenticated \.agent symlinks/);
  assert.match(r.out, /link target is not authenticated/);
  assert.deepEqual(r.events, []); assert.deepEqual(snapshot(f.target), before);
  assert.equal(fs.readlinkSync(link), linkBefore);
});

for (const relative of [false, true]) test(`dry-run with ${relative ? 'relative' : 'absolute'} .agent link is zero-write planning, not directory/binding validation`, t => {
  const f = fixture(t); fs.rmSync(path.join(f.project, '.agent'), { recursive: true });
  const link = path.join(f.project, '.agent');
  fs.symlinkSync(relative ? path.relative(f.project, f.target) : f.target, link, 'dir');
  const before = snapshot(f.root), linkBefore = fs.readlinkSync(link);
  const planned = f.run(['--stage-only', '--dry-run'], { cli: true });
  assert.equal(planned.status, 0, planned.out); assert.deepEqual(planned.events, []);
  assert.match(planned.out, /Stage directory and bindings are not verified; actual execution may refuse/);
  assert.match(planned.out, /including unsupported detached-local \/ unauthenticated \.agent symlinks/);
  assert.match(planned.out, /No child tools are executed/);
  assert.match(planned.out, /no candidate created/); assert.doesNotMatch(planned.out, /✅ Stage-only candidate:/);
  assert.deepEqual(snapshot(f.root), before); assert.equal(fs.readlinkSync(link), linkBefore);
  const actual = f.run(['--stage-only'], { cli: true });
  assert.equal(actual.status, 1, actual.out); assert.match(actual.out, /currently does not support detached-local/);
  assert.deepEqual(actual.events, []); assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.readlinkSync(link), linkBefore);
});

test('nested runtime symlinks retain the existing generic refusal', t => {
  const f = fixture(t); fs.symlinkSync(f.target, path.join(f.project, '.agent/runtime'), 'dir');
  const before = snapshot(f.target), r = f.run(['--stage-only']); assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Unsafe stage directory/); assert.deepEqual(r.events, []); assert.deepEqual(snapshot(f.target), before);
});

test('missing option values fail before any child tool or write', t => {
  const f = fixture(t), before = snapshot(f.project);
  for (const args of [['--target'], ['--bump'], ['--stage-only', '--target', '--dry-run']]) {
    const r = f.run(args); assert.equal(r.status, 1, r.out); assert.match(r.out, /Missing value/); assert.deepEqual(r.events, []);
  }
  assert.deepEqual(snapshot(f.project), before);
});

test('target removed by test hooks is rechecked before installation', t => {
  const f = fixture(t), r = f.run(['--target', f.target, '--skip-commit'], { fault: 'remove-target' });
  assert.equal(r.status, 1, r.out); assert.match(r.out, /not found or not a directory/);
  assert.ok(r.events.some(e => e.command === 'npm' && e.args[0] === 'pack'));
  assert.ok(!r.events.some(e => ['volta', 'cortex-agent'].includes(e.command)));
});

test('default dirty-tree and skip-commit guard remain unchanged; force does not require a real install in dry-run', t => {
  const f = fixture(t);
  for (const args of [['--skip-tests'], ['--skip-tests', '--skip-commit']]) {
    const r = f.run(args, { dirty: true }); assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Working tree is dirty/); assert.ok(r.events.every(e => e.command === 'git' && e.args[0] === 'status'));
  }
  const before = snapshot(f.project);
  const dry = f.run(['--dry-run', '--force', '--skip-tests', '--skip-commit'], { dirty: true });
  assert.equal(dry.status, 0, dry.out); assert.deepEqual(snapshot(f.project), before);
  assert.ok(dry.events.every(e => e.command === 'git' && e.args[0] === 'status'));
});
