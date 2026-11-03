'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const local = require('../../lib/design/local');
const lockfile = require('../../lib/design/lockfile');
const resolve = require('../../lib/design/resolve');
const { parseDesignArgs, designCommand } = require('../../lib/design/cli');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Build a local design system package.
// opts.manifest: manifest.json content, or null to omit the file entirely.
// opts.withTokens: include tokens.css (default true).
function writeSystem(dir, opts) {
  opts = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  if (opts.manifest !== null) {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(opts.manifest || {
        id: 'workbench',
        name: 'Workbench',
        category: 'Local',
        license: 'Apache-2.0',
      }, null, 2),
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(dir, 'DESIGN.md'),
    '# Workbench Design System\n\n## Visual theme\n\nDense cockpit UI.\n',
    'utf8',
  );
  if (opts.withTokens !== false) {
    fs.writeFileSync(path.join(dir, 'tokens.css'), ':root { --wb-bg: #06080d; }\n', 'utf8');
  }
  return dir;
}

async function captureStdoutAsync(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  const buf = [];
  process.stdout.write = (s) => { buf.push(String(s)); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf.join('');
}

async function captureStderrAsync(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const buf = [];
  process.stderr.write = (s) => { buf.push(String(s)); return true; };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf.join('');
}

// -- readLocalSystem ---------------------------------------------------------

test('local install rejects path traversal and does not follow destination symlinks', () => {
  const root = makeTmpDir('cortex-design-local-');
  try {
    const dir = writeSystem(path.join(root, 'source'));
    assert.throws(() => local.readLocalSystem({ dir, id: '../escape' }), /Invalid design system id/);
    const target = path.join(root, 'outside');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'safe');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(dest);
    fs.symlinkSync(target, path.join(dest, 'link'), 'dir');
    local.installLocalSystem({ dir, destDir: dest });
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'safe');
    const link = path.join(root, 'dest-link');
    fs.symlinkSync(target, link, 'dir');
    assert.throws(() => local.installLocalSystem({ dir, destDir: link }), /symlink/);
    const nested = writeSystem(path.join(dest, 'nested'));
    assert.throws(() => local.installLocalSystem({ dir: nested, destDir: dest }), /source directory/);
    assert.ok(fs.existsSync(path.join(nested, 'DESIGN.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readLocalSystem: reads manifest, DESIGN.md and tokens.css', () => {
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-local-'), 'workbench'));
  try {
    const system = local.readLocalSystem({ dir });
    assert.equal(system.id, 'workbench');
    assert.equal(system.manifest.license, 'Apache-2.0');
    assert.match(system.designText, /Workbench Design System/);
    assert.match(system.tokensText, /--wb-bg/);
    assert.equal(system.sha256.design, local.sha256(system.designText));
    assert.equal(system.sha256.tokens, local.sha256(system.tokensText));
    assert.equal(system.sha256.manifest, local.sha256(system.manifestText));
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('readLocalSystem: synthesizes a manifest when manifest.json is absent', () => {
  const root = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(root, 'legacy-system'), { manifest: null });
  try {
    const system = local.readLocalSystem({ dir });
    assert.equal(system.id, 'legacy-system');
    assert.equal(system.manifest.source.type, 'local');
    assert.ok(system.sha256.manifest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readLocalSystem: explicit id overrides the manifest id', () => {
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-local-'), 'workbench'));
  try {
    const system = local.readLocalSystem({ dir, id: 'renamed' });
    assert.equal(system.id, 'renamed');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('readLocalSystem: missing directory fails closed', () => {
  const root = makeTmpDir('cortex-design-local-');
  try {
    assert.throws(
      () => local.readLocalSystem({ dir: path.join(root, 'nope') }),
      (err) => err.code === 'ERR_LOCAL' && /not found/.test(err.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readLocalSystem: missing DESIGN.md fails closed', () => {
  const root = makeTmpDir('cortex-design-local-');
  try {
    assert.throws(
      () => local.readLocalSystem({ dir: root }),
      (err) => err.code === 'ERR_LOCAL' && /DESIGN\.md/.test(err.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readLocalSystem: invalid manifest.json fails closed', () => {
  const root = makeTmpDir('cortex-design-local-');
  try {
    writeSystem(root);
    fs.writeFileSync(path.join(root, 'manifest.json'), '{ not json', 'utf8');
    assert.throws(
      () => local.readLocalSystem({ dir: root }),
      (err) => err.code === 'ERR_LOCAL' && /Invalid manifest\.json/.test(err.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- installLocalSystem ------------------------------------------------------

test('installLocalSystem: writes the package and returns content hashes', () => {
  const root = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(root, 'workbench'));
  const destDir = path.join(root, 'dest');
  try {
    const result = local.installLocalSystem({ dir, destDir });
    assert.equal(result.id, 'workbench');
    assert.deepEqual(result.source, { type: 'local', origin: path.resolve(dir) });
    assert.ok(fs.existsSync(path.join(destDir, 'DESIGN.md')));
    assert.ok(fs.existsSync(path.join(destDir, 'tokens.css')));
    assert.ok(fs.existsSync(path.join(destDir, 'manifest.json')));
    const written = fs.readFileSync(path.join(destDir, 'DESIGN.md'), 'utf8');
    assert.equal(result.sha256.design, local.sha256(written));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installLocalSystem: replaces a previous copy so stale files cannot survive', () => {
  const root = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(root, 'workbench'));
  const destDir = path.join(root, 'dest');
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'stale.txt'), 'old', 'utf8');
    local.installLocalSystem({ dir, destDir });
    assert.equal(fs.existsSync(path.join(destDir, 'stale.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installLocalSystem: tokens.css is optional', () => {
  const root = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(root, 'workbench'), { withTokens: false });
  const destDir = path.join(root, 'dest');
  try {
    const result = local.installLocalSystem({ dir, destDir });
    assert.equal(result.sha256.tokens, null);
    assert.equal(fs.existsSync(path.join(destDir, 'tokens.css')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- CLI argument parsing ----------------------------------------------------

test('parseDesignArgs: --from <dir>', () => {
  const p = parseDesignArgs(['install', '--from', '/tmp/pkg']);
  assert.equal(p.from, '/tmp/pkg');
});

test('parseDesignArgs: --from=<dir>', () => {
  const p = parseDesignArgs(['install', '--from=/tmp/pkg']);
  assert.equal(p.from, '/tmp/pkg');
});

test('parseDesignArgs: --from without a value is a usage error', () => {
  const p = parseDesignArgs(['install', '--from']);
  assert.equal(process.exitCode, 2);
  process.exitCode = undefined;
});

test('parseDesignArgs: no --from keeps from null', () => {
  assert.equal(parseDesignArgs(['install', 'default']).from, null);
});

// -- CLI install --from ------------------------------------------------------

test('designCommand: install --from installs into .agent/design-systems', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'));
  try {
    const out = await captureStdoutAsync(() => designCommand({
      args: ['design', 'install', '--from', dir],
      cwd,
    }));
    assert.match(out, /Installed workbench/);
    const installed = lockfile.listSystems(cwd);
    assert.equal(installed.length, 1);
    assert.equal(installed[0].id, 'workbench');
    assert.equal(installed[0].source.type, 'local');
    assert.equal(installed[0].license, 'Apache-2.0');
    assert.ok(fs.existsSync(path.join(cwd, '.agent', 'design-systems', 'workbench', 'DESIGN.md')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from with an explicit id overrides the package id', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'));
  try {
    await captureStdoutAsync(() => designCommand({
      args: ['design', 'install', '--from', dir, 'renamed'],
      cwd,
    }));
    const installed = lockfile.listSystems(cwd);
    assert.equal(installed[0].id, 'renamed');
    assert.ok(fs.existsSync(path.join(cwd, '.agent', 'design-systems', 'renamed', 'DESIGN.md')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from surfaces the local package as a cascade layer', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'));
  try {
    await captureStdoutAsync(() => designCommand({
      args: ['design', 'install', '--from', dir],
      cwd,
    }));
    const cascade = resolve.resolveCascade({ cwd, templateDir: null });
    const layer3 = cascade.find((l) => l.layer === 3 && l.id === 'workbench');
    assert.ok(layer3, 'installed local system must appear as a layer 3 entry');
    assert.equal(layer3.kind, 'installed');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from fails closed on an unknown license', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'), {
    manifest: { id: 'workbench', name: 'Workbench', category: 'Local' },
  });
  try {
    const err = await captureStderrAsync(() => designCommand({
      args: ['design', 'install', '--from', dir, '--yes'],
      cwd,
    }));
    assert.match(err, /license unacceptable/);
    assert.equal(process.exitCode, 4);
    assert.equal(lockfile.listSystems(cwd).length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from --force overrides the license gate', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'), {
    manifest: { id: 'workbench', name: 'Workbench', category: 'Local' },
  });
  try {
    await captureStdoutAsync(() => designCommand({
      args: ['design', 'install', '--from', dir, '--force'],
      cwd,
    }));
    assert.equal(lockfile.listSystems(cwd).length, 1);
    assert.equal(lockfile.listSystems(cwd)[0].license, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from aborts when the license prompt is declined', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'), {
    manifest: { id: 'workbench', name: 'Workbench', category: 'Local' },
  });
  try {
    const err = await captureStderrAsync(() => designCommand({
      args: ['design', 'install', '--from', dir],
      cwd,
      prompt: async () => 'n',
    }));
    assert.match(err, /Aborted/);
    assert.equal(process.exitCode, 4);
    assert.equal(lockfile.listSystems(cwd).length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from with a missing directory is a usage error', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  try {
    const err = await captureStderrAsync(() => designCommand({
      args: ['design', 'install', '--from', path.join(cwd, 'nope')],
      cwd,
    }));
    assert.match(err, /not found/);
    assert.equal(process.exitCode, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from --json emits machine-readable output', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'));
  try {
    const out = await captureStdoutAsync(() => designCommand({
      args: ['design', 'install', '--from', dir, '--json'],
      cwd,
    }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.id, 'workbench');
    assert.equal(parsed.source.type, 'local');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

// -- starter shadowing -------------------------------------------------------

test('designCommand: install --from warns when the starter still shadows the new system', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'));
  try {
    // Reproduce a freshly-initialized project: the starter placeholder is
    // still at .agent/DESIGN.md, which outranks every installed system.
    const starter = path.resolve(__dirname, '..', '..', 'templates', '_shared', '.agent', 'DESIGN.md');
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.copyFileSync(starter, path.join(cwd, '.agent', 'DESIGN.md'));

    const out = await captureStdoutAsync(() => designCommand({
      args: ['design', 'install', '--from', dir],
      cwd,
    }));
    assert.match(out, /unmodified starter template/);
    assert.match(out, /layer 2 > layer 3/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('designCommand: install --from stays quiet when the project has its own DESIGN.md', async () => {
  const cwd = makeTmpDir('cortex-design-local-');
  const dir = writeSystem(path.join(makeTmpDir('cortex-design-pkg-'), 'workbench'));
  try {
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'DESIGN.md'), '# Project owned spec\n', 'utf8');

    const out = await captureStdoutAsync(() => designCommand({
      args: ['design', 'install', '--from', dir],
      cwd,
    }));
    assert.doesNotMatch(out, /unmodified starter template/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    process.exitCode = undefined;
  }
});

test('isUnmodifiedStarter: detects the shipped starter and rejects a project spec', () => {
  const templateDir = path.resolve(__dirname, '..', '..', 'templates');
  const root = makeTmpDir('cortex-design-local-');
  try {
    const starter = path.join(templateDir, '_shared', '.agent', 'DESIGN.md');
    assert.equal(resolve.isUnmodifiedStarter(starter, templateDir), true);

    const own = path.join(root, 'DESIGN.md');
    fs.writeFileSync(own, '# Project owned spec\n', 'utf8');
    assert.equal(resolve.isUnmodifiedStarter(own, templateDir), false);
    assert.equal(resolve.isUnmodifiedStarter(path.join(root, 'missing.md'), templateDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
